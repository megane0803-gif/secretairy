// 台帳の予約を押して開く1枚の中身と、取り消す・日時とメニューを変える（docs/SPEC.md §1.4.2）。形と変え方だけ（どこにも書かない）。
// 書くのは台帳の1枚（ReservationSheet.tsx）。人のボタン（オーナーが押した「取り消す」「この内容に変える」）だけが呼ぶ。
//
// 🔒 確定は人：直せるのは「確定」で「開始前」の予約だけ。仮押さえは承認BOXで承認か見送りを決める（ここでは直さない）。
// AI・自動の処理・LINE の一言からは呼ばない。AI は使わない。
//
// 見るだけ（取り消す・変えるを出さない）：仮押さえ・開始の時刻を過ぎた予約・保存したカルテ（最初の状態のカルテも）がある予約。
// 変える時の確かめは「台帳から入れる」（owner.ts）と同じ judgeSlot で、変える前と保存の直前（その時の台帳で）の2回。
// 判定に渡す台帳からは、変えようとしている予約と id が同じ1件だけを外す（同じお客様のほかの予約は残す）。
// 予約サイトの止めた時間は効かせない（台帳から入れる時と同じ）。
//
// 保存の形：最初の状態の予約は state.seedResEdits（取り消した印か、直した後の日付・開始・menuId）。
// 予約チャット・予約サイト・台帳から入った予約は、今ある記録（state.chat）の中を直す（取り消しは外す）。
// 承認BOXの履歴・保存したカルテ・送った LINE・ToDo はそのまま（withReleased は承認待ち専用で ToDo も足すので使わない）。

import { menuName, type SlotContext } from "../ai/slots";
import type { Candidate } from "../ai/wire";
import { calDay, toHHMM, toMinutes } from "../calendar";
import { resolveMenu } from "../combo";
import type { JournalWho } from "../journal";
import type { KarteRecord } from "../karte/record";
import type { Reservation } from "../reservations";
import { OWNER_TAG, ownerCheck, type OwnerCheck, type OwnerContext } from "./owner";
import { toRow } from "./assemble";
import { ledgerView, SITE_NAME } from "./site";
import type { BookState } from "./state";
import { viewKey, viewRange } from "./weekView";

/** どこから入ったか（1枚に出す札） */
export const SOURCE_LABEL: Record<Reservation["source"], string> = {
  seed: "最初から",
  chat: "予約チャット",
  site: SITE_NAME,
  owner: OWNER_TAG,
};

/** 1枚で出す物の分け方。hold = 仮押さえ（承認BOXへ）/ past = 開始を過ぎた / karte = カルテがある / edit = 取り消す・変えるを出す */
export type SheetMode = "hold" | "past" | "karte" | "edit";

export const HOLD_NOTE = "仮押さえは承認BOXで、承認か見送りを決めます";
export const PAST_NOTE = "開始の時刻を過ぎた予約なので、見るだけです（取り消す・変えるはできません）";
export const KARTE_NOTE = "保存したカルテがある予約なので、見るだけです（取り消す・変えるはできません）";

/** 開始の時刻を過ぎたか（「翌日へ」も入れた今の時刻で） */
export function isStarted(r: Pick<Reservation, "date" | "start">, now: { date: string; time: string }): boolean {
  return r.date < now.date || (r.date === now.date && r.start <= now.time);
}

/** その予約に保存したカルテ（最初の状態のカルテも）があるか */
export function hasKarte(r: Pick<Reservation, "id" | "date"> & { customer: { id: string } }, kartes: Pick<KarteRecord, "reservationId" | "customerId" | "date">[]): boolean {
  return kartes.some((k) => k.reservationId === r.id || (!k.reservationId && k.customerId === r.customer.id && k.date === r.date));
}

export function sheetMode(r: Reservation, now: { date: string; time: string }, kartes: Pick<KarteRecord, "reservationId" | "customerId" | "date">[]): SheetMode {
  if (r.status === "hold") return "hold";
  if (isStarted(r, now)) return "past";
  if (hasKarte(r, kartes)) return "karte";
  return "edit";
}

/** 開いた時の印。保存の直前に、印（viewKey）と中身がそのままかを確かめる */
export type OpenedMark = { key: string; id: string; date: string; start: string; menuId: string; status: Reservation["status"] };

export const openedMark = (key: string, r: Reservation): OpenedMark => ({ key, id: r.id, date: r.date, start: r.start, menuId: r.menu.id, status: r.status });

/** 「青木様 11/12（木） 15:00 カット」（日誌と1枚に出す形） */
export function resLabel(shop: OwnerContext["data"]["shop"], x: { surname: string; date: string; start: string; menuName: string }): string {
  return `${x.surname}様 ${calDay(shop, x.date).label} ${x.start} ${x.menuName}`;
}

export type ChangeContext = OwnerContext & {
  /** 保存したカルテ（最初の状態も。useBook の kartes） */
  kartes: Pick<KarteRecord, "reservationId" | "customerId" | "date">[];
};

export const STALE_NOTE = "1枚を開いた後に「翌日へ」か「最初に戻す」が押されたので、この内容は使いません。閉じて、もう一度押してください";
export const MOVED_NOTE = "開いた後に、この予約がほかの画面で変わりました。閉じて、もう一度押してください";

/** 保存の直前の確かめ：印が同じ・予約がまだある・確定・開始前・カルテなし・開いた時と同じ中身。通れば今の予約 */
function stillEditable(state: BookState, ctx: ChangeContext, opened: OpenedMark): { ok: true; r: Reservation; view: ReturnType<typeof ledgerView> } | { ok: false; note: string } {
  const view = ledgerView(ctx.data, state, ctx.now);
  if (viewKey(state.epoch, view.clock.dayOffset) !== opened.key) return { ok: false, note: STALE_NOTE };
  const r = view.all.find((x) => x.id === opened.id);
  if (!r) return { ok: false, note: "この予約はもう台帳にありません（ほかの画面で取り消されたかもしれません）" };
  if (r.date !== opened.date || r.start !== opened.start || r.menu.id !== opened.menuId || r.status !== opened.status) return { ok: false, note: MOVED_NOTE };
  const mode = sheetMode(r, view.clock.now, ctx.kartes);
  if (mode === "hold") return { ok: false, note: HOLD_NOTE };
  if (mode === "past") return { ok: false, note: PAST_NOTE };
  if (mode === "karte") return { ok: false, note: KARTE_NOTE };
  return { ok: true, r, view };
}

export type ChangeOutcome =
  | { ok: true; state: BookState; journal: { who: JournalWho; text: string }[]; message: string; label: string; date?: string }
  | { ok: false; state: BookState; note: string; check?: OwnerCheck | null };

/** 🔒 オーナーが「取り消す」を2回目に押した時だけ呼ぶ。保存の直前の確かめを通った時だけ、台帳から外す（空きに戻る） */
export function cancelReservation(state: BookState, ctx: ChangeContext, opened: OpenedMark): ChangeOutcome {
  const st = stillEditable(state, ctx, opened);
  if (!st.ok) return { ok: false, state, note: st.note };
  const r = st.r;
  const label = resLabel(ctx.data.shop, { surname: r.customer.surname, date: r.date, start: r.start, menuName: r.menu.name });
  const at = ctx.now.toISOString();
  const next: BookState =
    r.source === "seed"
      ? { ...state, seedResEdits: { ...(state.seedResEdits ?? {}), [r.id]: { cancelled: true, at } } }
      : { ...state, chat: state.chat.filter((x) => x.id !== r.id) };
  return { ok: true, state: next, label, journal: [{ who: "オーナー", text: `予約を取り消した（${label}）` }], message: `取り消しました：${label}` };
}

/** 変える時の判定に使う形（変えようとしている予約と id が同じ1件だけを外した台帳で） */
export function changeSlotContext(state: BookState, ctx: OwnerContext, reservationId: string): SlotContext | null {
  const { clock, all } = ledgerView(ctx.data, state, ctx.now);
  const r = all.find((x) => x.id === reservationId);
  if (!r) return null;
  return {
    shop: ctx.data.shop,
    menus: ctx.data.menus,
    rules: ctx.rules,
    booked: all.filter((x) => x.id !== reservationId).map(toRow),
    customer: { id: r.customer.id, surname: r.customer.surname, firstVisit: r.customer.firstVisit },
    now: clock.now,
    today: clock.today,
  };
}

/** 選べる日の範囲（今日を含めて、台帳で見られる最後の日まで） */
export function changeDays(state: BookState, ctx: OwnerContext): { first: string; last: string } {
  const { clock, all } = ledgerView(ctx.data, state, ctx.now);
  const range = viewRange(ctx.data.shop, { todayDate: clock.today.date, nowDate: clock.now.date, all });
  const first = clock.today.date > clock.now.date ? clock.today.date : clock.now.date;
  return { first, last: range.last };
}

/** 変える前の確かめ（いまの台帳で。自分とはぶつからない）。台帳で見られる範囲の外は入れられない */
export function changeCheck(state: BookState, ctx: OwnerContext, reservationId: string, c: Candidate): OwnerCheck | null {
  const slot = changeSlotContext(state, ctx, reservationId);
  if (!slot) return null;
  const check = ownerCheck(slot, c);
  const days = changeDays(state, ctx);
  if (c.date <= days.last) return check;
  const out = { key: "base:range", kind: "base" as const, label: "台帳で見られる範囲", ok: false, reason: "台帳で見られる範囲より先の日です" };
  return { ...check, ok: false, lines: [out, ...check.lines], blocked: [out, ...check.blocked] };
}

export type ChangeInput = { date: string; start: string; menuId: string };

/**
 * 🔒 オーナーが「この内容に変える」を押した時だけ呼ぶ。保存の直前に、その時の台帳でもう一度確かめる。
 * acknowledged = 2回目に押した時に見ていたオーナーのルールの key（台帳から入れる時と同じ。owner.ts の ownerBook）。
 */
export function changeReservation(state: BookState, ctx: ChangeContext, opened: OpenedMark, input: ChangeInput, acknowledged: string[] = []): ChangeOutcome {
  const st = stillEditable(state, ctx, opened);
  if (!st.ok) return { ok: false, state, note: st.note };
  const r = st.r;
  const menu = resolveMenu(ctx.data.menus, input.menuId);
  if (!menu) return { ok: false, state, note: "メニューを選んでください", check: null };
  if (input.date === r.date && input.start === r.start && menu.id === r.menu.id) return { ok: false, state, note: "今と同じ内容です（日時かメニューを変えてください）", check: null };
  const check = changeCheck(state, ctx, r.id, { menuId: menu.id, date: input.date, start: input.start });
  if (!check) return { ok: false, state, note: "この予約はもう台帳にありません", check: null };
  if (check.blocked.length) return { ok: false, state, check, note: `変えられません：${check.blocked[0].reason}` };
  if (check.rules.some((x) => !acknowledged.includes(x.key)))
    return { ok: false, state, check, note: "オーナーが足したルールに当たります。確かめて、もう一度押すと変えられます" };

  const at = ctx.now.toISOString();
  const next: BookState =
    r.source === "seed"
      ? { ...state, seedResEdits: { ...(state.seedResEdits ?? {}), [r.id]: { date: input.date, start: input.start, menuId: menu.id, at } } }
      : { ...state, chat: state.chat.map((x) => (x.id === r.id ? { ...x, date: input.date, start: input.start, menuId: menu.id } : x)) };
  const shop = ctx.data.shop;
  const before = resLabel(shop, { surname: r.customer.surname, date: r.date, start: r.start, menuName: r.menu.name });
  const afterShort = `${calDay(shop, input.date).label} ${input.start} ${menu.name}`;
  const ruleNames = check.rules.map((x) => `「${x.name ?? x.label}」`).join("・");
  const text = `予約を変えた（${before} → ${afterShort}）${ruleNames ? `。ルール${ruleNames}に当たったが、オーナーが確かめて変えた` : ""}`;
  return { ok: true, state: next, label: afterShort, date: input.date, journal: [{ who: "オーナー", text }], message: `変えました：${afterShort}` };
}

/** 終わる時刻（HH:MM） */
export function endOf(start: string, minutes: number): string {
  return toHHMM(toMinutes(start) + minutes);
}

export { menuName };
