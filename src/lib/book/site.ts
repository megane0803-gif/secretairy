// 予約サイト（架空）→ 台帳の向き（docs/SPEC.md §1.4）。予約サイト同士をつなぐ有料のサービスの代わりを、自分で作る所。
// ここは形と変え方だけ（どこにも書かない）。書くのは予約サイト（架空）の画面（BookingSite.tsx）と、ホームの「AI の仕事」（jobs/run.ts）。
//
// お客様が予約サイトで自分で決めた予約なので、承認の箱は通さずに「確定」で台帳に入る（札は「予約サイトから」・色は外の相手 = 藍）。
// これは 🔒「確定は人」（店の側の確定）とは別の物：店の AI・自動の処理が確定するのではなく、外のお客様が自分で決めた予約を受け取るだけ。
// AI は使わない。AI の道具（src/lib/ai/tools.ts）からも呼ばない。
//
// 枠の決め方（プログラム）：
//   free   … 空いている枠に1件（台帳の確定・仮押さえ・同じ時間に受ける人数・店の設定・ルールを judge.ts で確かめて、通った最初の枠）
//   onHold … デモの見せ場：いちばん古い承認待ちの仮押さえと同じ枠に入れる（予約サイトには仮押さえは見えないので、確定の予約だけで確かめる）
// どちらも、オーナーが「ネットでは受けない」にした時間（siteStops.ts）にかかる枠には入れない（その時刻に始まる物も、重なる物も）。
// 二重予約を防ぐ：入った予約で同じ時間に受ける人数をこえる仮押さえは外し、ToDo に「○○（架空）様に別の日時を案内」を今日中として足す。

import { candidateLabel, findSlots, judgeSlot, type SlotContext } from "../ai/slots";
import type { BookedRow, Candidate } from "../ai/wire";
import { demoClock, toMinutes } from "../calendar";
import { resolveMenu } from "../combo";
import { siteStep, stopHit } from "./siteStops";
import type { JournalWho } from "../journal";
import { loadBook, resolveChatReservations, seedAnchor, sortReservations, type ChatReservation, type Reservation } from "../reservations";
import type { Rule } from "../rules/types";
import { rescheduleTodo } from "../todo/reschedule";
import type { BookData } from "./data";
import { activeChat, pendingApprovals, withTodo, type BookState } from "./state";

/** free = 空いている枠に1件 / onHold = 仮押さえと同じ枠に（デモの見せ場） */
export type SiteMode = "free" | "onHold";

/** 予約サイトから入った予約の id の頭 */
export const SITE_ID_PREFIX = "site-";

export const SITE_NAME = "予約サイト（架空）";

/** 日誌の「だれ」（外の相手。札は「外 予約サイト」） */
export const SITE_WHO: JournalWho = "予約サイト";

export type SiteContext = {
  /** 店の設定に「同じ時間に受ける人数」を重ねた BookData（useBook の data） */
  data: BookData;
  /** そのブラウザのルール（鍵つき＋オーナーのルール） */
  rules: Rule[];
  now: Date;
  /** オーナーが予約サイトで「ネットでは受けない」にした時間（siteStops.ts の印）。予約サイトだけに効く */
  stops?: string[];
};

export type SiteReleased = { approvalId: string; reservation: ChatReservation; surname: string; todo: string };

export type SiteOutcome =
  | {
      ok: true;
      state: BookState;
      placed: ChatReservation;
      surname: string;
      label: string;
      released: SiteReleased[];
      journal: { who: JournalWho; text: string }[];
      /** 画面に出す1行 */
      message: string;
    }
  | { ok: false; state: BookState; note: string };

export const isSiteReservation = (r: Pick<ChatReservation, "via">): boolean => r.via === "site";

/** このブラウザに入った、予約サイトからの予約の数（「最初に戻す」で 0 に戻る） */
export function siteCount(s: BookState): number {
  return s.chat.filter(isSiteReservation).length;
}

/** 台帳を画面と同じ組み立て方で（useBook と同じ部品）。確定・仮押さえ（期限の切れていない物）・予約サイトの物。台帳から入れる予約（owner.ts）も使う */
export function ledgerView(data: BookData, state: BookState, now: Date) {
  const clock = demoClock(data.shop, now, state.dayOffset);
  const nowIso = now.toISOString();
  const anchor = seedAnchor(data.shop, state.anchor, clock.today);
  const chat = resolveChatReservations(data.menus, data.customers, activeChat(state, nowIso));
  const all = sortReservations(loadBook(data.shop, data.menus, clock.today, anchor, chat).all);
  return { clock, nowIso, all };
}

export const toRow = (r: Reservation): BookedRow => ({
  id: r.id,
  customerId: r.customer.id,
  menuId: r.menu.id,
  date: r.date,
  start: r.start,
  status: r.status,
  newCustomer: r.customer.firstVisit,
});

/** 入れる順のお客様（架空）。入った数で1人ずつずらす（同じ方ばかりにしない） */
function rotate<T>(list: T[], n: number): T[] {
  if (list.length === 0) return list;
  const k = n % list.length;
  return [...list.slice(k), ...list.slice(0, k)];
}

type Span = { id: string; startMin: number; endMin: number };

/** 入った予約の時間の中で、同じ時間に受ける人数をこえる時があるか */
function overflows(target: Span, others: Span[], seats: number): boolean {
  const all = [target, ...others.filter((o) => o.id !== target.id && o.startMin < target.endMin && target.startMin < o.endMin)];
  const points = [target.startMin, ...all.map((s) => s.startMin).filter((m) => m > target.startMin && m < target.endMin)];
  return points.some((p) => all.filter((s) => s.startMin <= p && p < s.endMin).length > seats);
}

/**
 * 予約サイト（架空）で、架空のお客様の予約が1件入る。AI は使わない。
 * 入ったら台帳に確定で入り（承認の箱は通さない）、重なって人数をこえる仮押さえは外して ToDo に足す。
 */
export function siteBook(state: BookState, ctx: SiteContext, mode: SiteMode): SiteOutcome {
  const { data, rules, now } = ctx;
  const stops = ctx.stops ?? [];
  const step = siteStep(data.shop);
  const { clock, nowIso, all } = ledgerView(data, state, now);
  // 止めた時間にかかるか（施術の時間のどこかが止めたマスに重なれば入れない）
  const stoppedAt = (c: Candidate): string | null => {
    const m = resolveMenu(data.menus, c.menuId);
    if (!m) return null;
    const s = toMinutes(c.start);
    return stopHit(stops, step, c.date, s, s + m.minutes);
  };
  const n = siteCount(state);
  const slotCtx = (c: BookData["customers"][number], booked: BookedRow[]): SlotContext => ({
    shop: data.shop,
    menus: data.menus,
    rules,
    booked,
    customer: { id: c.id, surname: c.surname, firstVisit: c.firstVisit },
    now: clock.now,
    today: clock.today,
  });
  const busyOn = (customerId: string, date: string) => all.some((r) => r.customer.id === customerId && r.date === date);

  let pick: { customerId: string; candidate: Candidate } | null = null;
  let target: string | null = null;

  if (mode === "onHold") {
    const row = pendingApprovals(state, nowIso)[0];
    if (!row) return { ok: false, state, note: "承認待ちの仮押さえがありません（予約チャットで仮押さえをしてから押してください）" };
    const hold = row.reservation;
    target = hold.id;
    const candidate: Candidate = { menuId: hold.menuId, date: hold.date, start: hold.start };
    const hit = stoppedAt(candidate);
    if (hit) return { ok: false, state, note: `仮押さえと同じ枠（${candidateLabel(data, candidate)}）は、${hit} からの時間をネットでは受けないにしているので、予約サイトからは入りません` };
    // 予約サイトには仮押さえは見えない（送らない）ので、確定の予約だけで確かめる
    const confirmed = all.filter((r) => r.status === "confirmed").map(toRow);
    for (const c of rotate(data.customers, n)) {
      if (c.id === hold.customerId || busyOn(c.id, hold.date)) continue;
      if (judgeSlot(slotCtx(c, confirmed), candidate).ok) {
        pick = { customerId: c.id, candidate };
        break;
      }
    }
    if (!pick) return { ok: false, state, note: "仮押さえと同じ枠には、いまの台帳・ルールでは入れられませんでした" };
  } else {
    const booked = all.map(toRow);
    const menus = rotate(data.menus, n);
    const from = { date: clock.today.date, ...(clock.now.date === clock.today.date ? { time: clock.now.time } : {}) };
    outer: for (const menu of menus) {
      for (const c of rotate(data.customers, n)) {
        // 止めた時間にかかる枠は飛ばす（多めに探してから外す）
        const found = findSlots(slotCtx(c, booked), menu.id, from, stops.length ? 40 : 3).slots.find((s) => !busyOn(c.id, s.date) && !stoppedAt(s));
        if (found) {
          pick = { customerId: c.id, candidate: found };
          break outer;
        }
      }
    }
    if (!pick) return { ok: false, state, note: "空いている枠が見つかりませんでした" };
  }

  const customer = data.customers.find((c) => c.id === pick!.customerId)!;
  const placed: ChatReservation = {
    id: `${SITE_ID_PREFIX}${n + 1}`,
    customerId: customer.id,
    menuId: pick.candidate.menuId,
    date: pick.candidate.date,
    start: pick.candidate.start,
    status: "confirmed",
    heldAt: nowIso,
    expiresAt: nowIso,
    via: "site",
  };
  let next: BookState = { ...state, chat: [...state.chat, placed] };
  const label = candidateLabel(data, placed);

  // 二重予約を防ぐ：同じ時間に受ける人数をこえるなら、重なる仮押さえを外す（仮押さえと同じ枠を選んだ時はその仮押さえから。あとは新しい順）
  const placedRes = resolveChatReservations(data.menus, data.customers, [placed])[0];
  const spans: Span[] = all.filter((r) => r.date === placed.date).map((r) => ({ id: r.id, startMin: r.startMin, endMin: r.endMin }));
  const pending = pendingApprovals(state, nowIso)
    .filter((p) => p.reservation.date === placed.date)
    .map((p) => ({ row: p, span: spans.find((s) => s.id === p.reservation.id) }))
    .filter((x): x is { row: (typeof x)["row"]; span: Span } => !!x.span && x.span.startMin < placedRes.endMin && placedRes.startMin < x.span.endMin)
    .sort((a, b) => (a.row.reservation.id === target ? -1 : b.row.reservation.id === target ? 1 : b.row.reservation.heldAt.localeCompare(a.row.reservation.heldAt)));
  let left = spans;
  const released: SiteReleased[] = [];
  for (const p of pending) {
    if (!overflows({ id: placed.id, startMin: placedRes.startMin, endMin: placedRes.endMin }, left, data.shop.seats)) break;
    left = left.filter((s) => s.id !== p.span.id);
    const r = p.row.reservation;
    const surname = data.customers.find((c) => c.id === r.customerId)?.surname ?? "お客";
    const todo = rescheduleTodo({ idPrefix: "td-site", reservationId: r.id, surname, from: r, nowIso, due: clock.today.date });
    next = {
      ...withTodo(next, todo),
      chat: next.chat.filter((x) => x.id !== r.id),
      approvals: next.approvals.map((a) => (a.id === p.row.approval.id ? { ...a, state: "taken", decidedAt: nowIso } : a)),
    };
    released.push({ approvalId: p.row.approval.id, reservation: r, surname, todo: todo.title });
  }

  const who = `${customer.surname}（架空）様`;
  const journal: { who: JournalWho; text: string }[] = [
    { who: SITE_WHO, text: `${SITE_NAME}から1件入った：${who} ${label}（お客様が自分で決めた予約なので、承認の箱は通さずに台帳へ）` },
    ...released.map((x) => ({
      who: "プログラム" as const,
      text: `${SITE_NAME}の予約と同じ枠だったので、${x.surname}（架空）様の仮押さえ（${candidateLabel(data, x.reservation)}）を外し、ToDo に「${x.todo}」（今日中）を足した（二重予約を防ぐ。AI は使っていない）`,
    })),
  ];
  const message = `${SITE_NAME}から1件入りました：${who} ${label}${released.length ? `。同じ枠の仮押さえ ${released.length}件を外し、ToDo に「別の日時を案内」を足しました` : ""}`;
  return { ok: true, state: next, placed, surname: customer.surname, label, released, journal, message };
}
