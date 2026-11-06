// 承認の箱に出す行を、1か所で決める。
// 承認の箱（ホーム・予約タブ）・どのタブにも出す「承認待ち N 件」・朝の要点の「承認待ち」は、
// みなここの同じ行から数える（数と行がずれないように。docs/SPEC.md §1.3・§2.2）。
// 経理は承認の箱を使わないので数えない（§1.8）。

import type { AdJudgement } from "./ads/results";
import { pendingAd, type AdProposal, type AdsState } from "./ads/state";
import { pendingRevert } from "./ads/verdict";
import type { BookedRow } from "./ai/wire";
import { pendingApprovals, type BookState, type PendingRow } from "./book/state";

export type ApprovalQueue = {
  /** 予約の仮押さえの行（古い順。期限の切れた物は出さない） */
  reservations: PendingRow[];
  /** 広告の案の行（あれば1つ） */
  ad: AdProposal | null;
  /** 広告の「戻す案」の行（効いたかの判定で予約が減った言葉。あれば1つ。ads/verdict.ts。無ければ持たない） */
  adRevert?: AdJudgement;
  /** 承認の箱の行の数（= 上の帯・朝の要点の「承認待ち」） */
  count: number;
};

export function approvalQueue(book: BookState, ads: AdsState, nowIso: string): ApprovalQueue {
  const reservations = pendingApprovals(book, nowIso);
  const ad = pendingAd(ads);
  const adRevert = pendingRevert(ads);
  return { reservations, ad, ...(adRevert ? { adRevert } : {}), count: reservations.length + (ad ? 1 : 0) + (adRevert ? 1 : 0) };
}

/** 承認の箱のどの行を出すか。ホームは全部、予約タブは予約の行だけ（広告の案は広告タブとホームで押す） */
export type ApprovalView = "all" | "reservations";

/** その場所に出す行と、その数。数そのもの（上の帯・朝の要点）は approvalQueue の count のまま */
export function approvalsFor(
  queue: ApprovalQueue,
  view: ApprovalView,
): { reservations: PendingRow[]; ad: AdProposal | null; adRevert?: AdJudgement; count: number } {
  if (view === "reservations") return { reservations: queue.reservations, ad: null, count: queue.reservations.length };
  return { reservations: queue.reservations, ad: queue.ad, ...(queue.adRevert ? { adRevert: queue.adRevert } : {}), count: queue.count };
}

/** 残りがこれより少ない仮押さえの行は、上に回して太字にする（赤で急がせない） */
export const HOLD_SOON_MINUTES = 60;

/**
 * 仮押さえが自動で外れるまでの残り（承認の箱の行に出す）。
 * 外れるのは作った時に保存した期限（expiresAt）で本当の時計なので、残りも同じ時計で「期限 − 今」から出す（「翌日へ」の日付では数えない）。
 * 画面は1分ごとの描き直し（useMinute）の「今」を渡す。
 */
export function holdLeft(expiresAt: string, nowMs: number): { minutes: number; text: string; soon: boolean } {
  const ms = Date.parse(expiresAt) - nowMs;
  const minutes = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 60_000)) : 0;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const text =
    minutes < 1 ? "まもなく外れます" : h === 0 ? `あと${m}分で外れます` : m === 0 ? `あと${h}時間で外れます` : `あと${h}時間${m}分で外れます`;
  return { minutes, text, soon: minutes < HOLD_SOON_MINUTES };
}

/** 承認の箱の予約の行の並び：残りが1時間を切った行を上に（その中と、ほかの行は今までの古い順のまま） */
export function soonFirst(rows: PendingRow[], nowMs: number): PendingRow[] {
  const soon = (r: PendingRow) => holdLeft(r.reservation.expiresAt, nowMs).soon;
  return [...rows.filter(soon), ...rows.filter((r) => !soon(r))];
}

/**
 * 同じお客様の、同じ日のほかの予約の時刻（早い順）。承認の箱の行に「! 同じ日の13:00にも予約があります」と出す（止めはしない）。
 * 台帳の今ある予約（book.booked。確定と、期限の切れていない仮押さえ。外した物は入っていない）を「その予約の日付＋お客様の番号」で照らし、
 * その行自身は数えない。
 */
export function sameDayOthers(
  row: { id: string; customerId: string; date: string },
  booked: Pick<BookedRow, "id" | "customerId" | "date" | "start">[],
): string[] {
  return booked
    .filter((b) => b.id !== row.id && b.customerId === row.customerId && b.date === row.date)
    .map((b) => b.start)
    .sort();
}

/**
 * 承認の箱の予約の行に足す1行ずつ（理由の下・✓ とボタンの上。この1か所で決める）。
 * 今は「外れるまでの残り」と「同じ日のほかの予約」。行に足す物を増やす時（直しC など）は、ここに種類を足し、
 * 画面（components/ApprovalRowNotes.tsx）は種類ごとの見た目だけ持つ。数（approvalQueue の count）と行の中身・ボタンは変えない。
 */
export type ApprovalRowNote = {
  kind: "left" | "sameDay";
  text: string;
  /** 太字にするか（残りが1時間を切った時。赤で急がせない） */
  strong: boolean;
};

/** 行に足す物を作るのに要る物：今（1分ごとの描き直しの本当の時計）と、台帳の今ある予約（book.booked） */
export type ApprovalRowCtx = {
  nowMs: number;
  booked: Pick<BookedRow, "id" | "customerId" | "date" | "start">[];
};

export function approvalRowNotes(row: PendingRow, ctx: ApprovalRowCtx): ApprovalRowNote[] {
  const r = row.reservation;
  const left = holdLeft(r.expiresAt, ctx.nowMs);
  const others = sameDayOthers({ id: r.id, customerId: r.customerId, date: r.date }, ctx.booked);
  return [
    { kind: "left", text: left.text, strong: left.soon },
    ...(others.length ? [{ kind: "sameDay" as const, text: `! 同じ日の${others.join("・")}にも予約があります`, strong: false }] : []),
  ];
}

/** 承認の箱に出す予約の行の順と、行ごとの足す物（画面はこれを1回呼ぶだけ）。並べ方は soonFirst */
export function approvalRowsView(rows: PendingRow[], ctx: ApprovalRowCtx): { row: PendingRow; notes: ApprovalRowNote[]; soon: boolean }[] {
  return soonFirst(rows, ctx.nowMs).map((row) => {
    const notes = approvalRowNotes(row, ctx);
    return { row, notes, soon: notes.some((n) => n.kind === "left" && n.strong) };
  });
}
