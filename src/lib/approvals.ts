// 承認の箱に出す行を、1か所で決める。
// 承認の箱（ホーム・予約タブ）・どのタブにも出す「承認待ち N 件」・朝の要点の「承認待ち」は、
// みなここの同じ行から数える（数と行がずれないように。docs/SPEC.md §1.3・§2.2）。
// 経理は承認の箱を使わないので数えない（§1.8）。

import { pendingAd, type AdProposal, type AdsState } from "./ads/state";
import { pendingApprovals, type BookState, type PendingRow } from "./book/state";

export type ApprovalQueue = {
  /** 予約の仮押さえの行（古い順。期限の切れた物は出さない） */
  reservations: PendingRow[];
  /** 広告の案の行（あれば1つ） */
  ad: AdProposal | null;
  /** 承認の箱の行の数（= 上の帯・朝の要点の「承認待ち」） */
  count: number;
};

export function approvalQueue(book: BookState, ads: AdsState, nowIso: string): ApprovalQueue {
  const reservations = pendingApprovals(book, nowIso);
  const ad = pendingAd(ads);
  return { reservations, ad, count: reservations.length + (ad ? 1 : 0) };
}

/** 承認の箱のどの行を出すか。ホームは全部、予約タブは予約の行だけ（広告の案は広告タブとホームで押す） */
export type ApprovalView = "all" | "reservations";

/** その場所に出す行と、その数。数そのもの（上の帯・朝の要点）は approvalQueue の count のまま */
export function approvalsFor(queue: ApprovalQueue, view: ApprovalView): { reservations: PendingRow[]; ad: AdProposal | null; count: number } {
  if (view === "reservations") return { reservations: queue.reservations, ad: null, count: queue.reservations.length };
  return { reservations: queue.reservations, ad: queue.ad, count: queue.count };
}
