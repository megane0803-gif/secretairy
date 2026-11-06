// オーナーが台帳から予約を入れる所（電話や店頭で受けた予約。docs/SPEC.md §1.4.1）。形と変え方だけ（どこにも書かない）。
// 書くのは台帳の「入れる」の画面（OwnerBookSheet.tsx）。人のボタン（オーナーが押した「入れる」）だけが呼ぶ。
//
// 🔒 確定は人：オーナーが自分で入れるので、承認の箱は通さずに「確定」で台帳に入る（札は「台帳から（オーナー）」）。
// AI・自動の処理・LINE の一言からは呼ばない。AI は使わない。
//
// 確かめ方は予約チャット・承認の箱と同じ判定（ai/slots.ts の judgeSlot）。入れる前と、保存する直前（その時の台帳で）の2回。
//   入れられない      … 店の基礎の判定（過ぎた日時・営業時間の外・最終受付・定休日と休みの日・同じ時間に受ける人数）と、鍵つきのルール
//   もう一度押せば入れられる … オーナーが足したルール（来店の何時間前まで・初めての方の人数・組み合わせ など）だけに当たる時。
//                        電話でお客様と話して決めた予約のため。どのルールに当たるかはオーナー向けの言葉で出し、日誌にも名前を残す。

import { candidateLabel, judgeSlot, menuName, type SlotContext } from "../ai/slots";
import type { Candidate } from "../ai/wire";
import { toHHMM, toMinutes } from "../calendar";
import { resolveMenu } from "../combo";
import type { JournalWho } from "../journal";
import type { ChatReservation } from "../reservations";
import { scopeTag } from "../rules/describe";
import type { Verdict } from "../rules/judge";
import type { Rule } from "../rules/types";
import type { BookData } from "./data";
import { ledgerView, toRow } from "./site";
import type { BookState } from "./state";

/** 台帳から入れた予約の id の頭 */
export const OWNER_ID_PREFIX = "own-";

/** 台帳の札（予約サイトから・承認で確定と見分ける） */
export const OWNER_TAG = "台帳から（オーナー）";

export type OwnerInput = { customerId: string; menuId: string; date: string; start: string };

/** 確かめの1行（✓ ／ ✗）。kind = base（店の設定）/ rule（ルール） */
export type OwnerLine = {
  key: string;
  kind: "base" | "rule";
  label: string;
  ok: boolean;
  reason: string;
  locked?: boolean;
  /** ルールの名前と、どこに効くか（ルールの時だけ。オーナー向けの言葉で出す） */
  name?: string;
  scope?: string;
};

export type OwnerCheck = {
  /** 何も当たらない（そのまま入れられる） */
  ok: boolean;
  /** 全部の確かめ（✓ と ✗。画面に出す） */
  lines: OwnerLine[];
  /** 入れられない理由（店の基礎の判定・鍵つきのルール）。1つでもあれば入れない */
  blocked: OwnerLine[];
  /** もう一度押せば入れられる理由（オーナーが足したルール） */
  rules: OwnerLine[];
  /** 終わる時刻（HH:MM）。メニューが無ければ null */
  end: string | null;
};

const ruleLabel = (ctx: Pick<SlotContext, "menus">, r: Rule) => `[${scopeTag(r, (id) => menuName(ctx, id))}] ${r.label}`;

/** 判定の結果を、台帳から入れる時の形に分ける */
export function splitVerdict(ctx: Pick<SlotContext, "menus">, v: Verdict): Omit<OwnerCheck, "end"> {
  const lines: OwnerLine[] = [
    ...v.base.map((b): OwnerLine => ({ key: `base:${b.id}`, kind: "base", label: b.label, ok: b.ok, reason: b.reason })),
    ...v.results.map(
      (r): OwnerLine => ({
        key: `rule:${r.rule.id}`,
        kind: "rule",
        label: ruleLabel(ctx, r.rule),
        ok: r.ok,
        reason: r.reason,
        name: r.rule.label,
        scope: scopeTag(r.rule, (id) => menuName(ctx, id)),
        ...(r.rule.locked ? { locked: true } : {}),
      }),
    ),
  ];
  const bad = lines.filter((l) => !l.ok);
  const blocked = bad.filter((l) => l.kind === "base" || l.locked);
  const rules = bad.filter((l) => l.kind === "rule" && !l.locked);
  return { ok: bad.length === 0, lines, blocked, rules };
}

/** いまの台帳で、その予約を入れてよいか（予約チャット・承認の箱と同じ judgeSlot） */
export function ownerCheck(ctx: SlotContext, input: Candidate): OwnerCheck {
  const menu = resolveMenu(ctx.menus, input.menuId);
  const v = judgeSlot(ctx, input);
  return { ...splitVerdict(ctx, v), end: menu ? toHHMM(toMinutes(input.start) + menu.minutes) : null };
}

export type OwnerContext = {
  /** 店の設定に「同じ時間に受ける人数」と「休みの日」を重ねた BookData（useBook の data） */
  data: BookData;
  /** そのブラウザのルール（鍵つき＋オーナーのルール） */
  rules: Rule[];
  now: Date;
  newId?: () => string;
};

/** その時の台帳（state）から、判定に使う形を作る */
export function ownerSlotContext(state: BookState, ctx: OwnerContext, customerId: string): SlotContext | null {
  const c = ctx.data.customers.find((x) => x.id === customerId);
  if (!c) return null;
  const { clock, all } = ledgerView(ctx.data, state, ctx.now);
  return {
    shop: ctx.data.shop,
    menus: ctx.data.menus,
    rules: ctx.rules,
    booked: all.map(toRow),
    customer: { id: c.id, surname: c.surname, firstVisit: c.firstVisit },
    now: clock.now,
    today: clock.today,
  };
}

export type OwnerOutcome =
  | { ok: true; state: BookState; placed: ChatReservation; label: string; journal: { who: JournalWho; text: string }[]; message: string }
  | { ok: false; state: BookState; check: OwnerCheck | null; note: string };

/**
 * 🔒 オーナーが「入れる」を押した時だけ呼ぶ。保存する直前に、その時の台帳（state）でもう一度確かめる。
 * acknowledged = オーナーが「当たるけれど入れる」と2回目に押した時に見ていたルールの key。
 * 今のルールの当たりが、その中に全部ある時だけ入れる（押した後で別のルールに当たるようになったら、もう一度見せる）。
 */
export function ownerBook(state: BookState, ctx: OwnerContext, input: OwnerInput, acknowledged: string[] = []): OwnerOutcome {
  const slot = ownerSlotContext(state, ctx, input.customerId);
  if (!slot) return { ok: false, state, check: null, note: "お客様を選んでください" };
  if (!resolveMenu(ctx.data.menus, input.menuId)) return { ok: false, state, check: null, note: "メニューを選んでください" };
  const c: Candidate = { menuId: input.menuId, date: input.date, start: input.start };
  const check = ownerCheck(slot, c);
  if (check.blocked.length) return { ok: false, state, check, note: `入れられません：${check.blocked[0].reason}` };
  if (check.rules.some((r) => !acknowledged.includes(r.key)))
    return { ok: false, state, check, note: "オーナーが足したルールに当たります。確かめて、もう一度押すと入れられます" };

  const nowIso = ctx.now.toISOString();
  const id = ctx.newId?.() ?? `${OWNER_ID_PREFIX}${ctx.now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const placed: ChatReservation = {
    id: id.startsWith(OWNER_ID_PREFIX) ? id : `${OWNER_ID_PREFIX}${id}`,
    customerId: input.customerId,
    menuId: input.menuId,
    date: input.date,
    start: input.start,
    status: "confirmed",
    heldAt: nowIso,
    expiresAt: nowIso,
    via: "owner",
  };
  const label = `${slot.customer.surname}（架空）様 ${candidateLabel(ctx.data, placed)}`;
  const ruleNames = check.rules.map((r) => `「${r.name ?? r.label}」`).join("・");
  const text = `台帳から予約を入れた（${label}）${ruleNames ? `。ルール${ruleNames}に当たったが、オーナーが確かめて入れた` : ""}`;
  return {
    ok: true,
    state: { ...state, chat: [...state.chat, placed] },
    placed,
    label,
    journal: [{ who: "オーナー", text }],
    message: `✓ 台帳に入れました（確定）：${label}`,
  };
}

/** 台帳から入れた予約か */
export const isOwnerReservation = (r: Pick<ChatReservation, "via">): boolean => r.via === "owner";
