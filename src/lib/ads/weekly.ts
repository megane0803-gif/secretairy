// 毎週の見直しの報告（docs/SPEC.md §1.7.2）。見直しを1回するたびに、広告タブに4行のカードを1枚残す：
//   ① 見た数字（期間・押された回数・お金・予約）… プログラムが表から入れる
//   ② 止めた言葉・外した言葉 … 承認BOXの行（承認・見送り）から。理由の文は AI の案の理由を言葉の門（words.ts）に通した物
//   ③ 止めなかった言葉とその理由 … 予約につながっていないのに止めなかった言葉。理由はプログラムが決まりから入れる
//   ④ 次に見る日 … 次の見直し（oncePerDays 日後）と、止めた言葉の判定日
// AI は数を書かない。報告を作るのも残すのもプログラム。前の週のカードも一覧で見られる（listCount 枚まで）。

import { addDays, calDay } from "../calendar";
import type { AdWeek } from "../data/types";
import type { BookState } from "../book/state";
import type { AdSettings, ShopSettings } from "../settings";
import type { GatedProposal } from "./gate";
import { actionPast, actionVerb, addWeek, allRows, totalOf, townIn, weeklyTotals, yen, ZERO, type AdAction, type AdTable, type AdTableRow } from "./report";
import type { AdKept, AdWeeklyReport } from "./results";
import type { RejectedDraft } from "./review";
import { checkDueDate, type AdsState } from "./state";
import { judgeDueOf } from "./verdict";
import { gateAdSentence } from "./words";
import type { AdsMode } from "./wire";

export type ReportSettings = Pick<AdSettings, "towns" | "oncePerDays" | "report" | "gateWords">;

/** ③ の理由（プログラムの決まり。数字は入れない） */
export const KEPT_WHY = {
  town: "町の名前の言葉は、近くのお客様の言葉なので外しません。",
  featured: "売りのメニューの言葉なので、止める前によく考えます。",
  gate: "プログラムの確認を通らなかったので、案にしませんでした。",
  later: "案は1週間に1つまでなので、次の見直しで見ます。",
} as const;

function keptWhy(r: AdTableRow, towns: string[], rejected: boolean): string {
  if (r.kind === "term" && townIn(r.text, towns)) return KEPT_WHY.town;
  if (r.featured) return KEPT_WHY.featured;
  return rejected ? KEPT_WHY.gate : KEPT_WHY.later;
}

/**
 * 見直し1回の報告を作る（table は見直したときの表。止める前）。
 * proposal があれば ②、無ければ failed（案が出なかった訳）。
 */
export function buildWeeklyReport(input: {
  id: string;
  nowIso: string;
  /** 「翌日へ」も入れた今日 */
  today: string;
  table: AdTable;
  shop: ShopSettings;
  settings: ReportSettings;
  mode: AdsMode;
  proposal?: GatedProposal & { id: string };
  failed?: string;
  rejected?: RejectedDraft[];
  fromJobs?: boolean;
}): AdWeeklyReport {
  const { table, settings } = input;
  const weeks = weeklyTotals(table.keywords);
  const seen: AdWeek = weeks.reduce(addWeek, ZERO);
  const n = weeks.length;

  // ② AI の案の理由は、言葉の門を通った物だけ載せる
  let proposal: AdWeeklyReport["proposal"];
  if (input.proposal) {
    const g = gateAdSentence(input.proposal.reason, settings.gateWords);
    proposal = {
      action: input.proposal.action,
      no: input.proposal.no,
      text: input.proposal.text,
      ...(g.ok ? { reason: g.text } : { reasonHidden: g.problems.join("。") }),
    };
  }

  // ③ 止めなかった言葉：門で弾かれた言葉を先に、あとは予約につながっていないのに出している言葉（お金の多い順）
  const rejectedNos = new Set((input.rejected ?? []).map((r) => r.no));
  const live = allRows(table).filter((r) => !r.off && r.no !== input.proposal?.no);
  const rejectedRows = live.filter((r) => rejectedNos.has(r.no));
  const idle = live
    .filter((r) => !rejectedNos.has(r.no) && totalOf(r).bookings === 0 && totalOf(r).cost > 0)
    .sort((a, b) => totalOf(b).cost - totalOf(a).cost || a.no - b.no);
  const all = [...rejectedRows, ...idle];
  const max = Math.max(0, settings.report.maxKeptWords);
  const kept: AdKept[] = all.slice(0, max).map((r) => ({
    no: r.no,
    text: r.text,
    action: r.kind === "keyword" ? "stop" : "exclude",
    why: keptWhy(r, settings.towns, rejectedNos.has(r.no)),
  }));
  // 予約につながっていて、そのままにした言葉（広告を出す言葉だけ数える）
  const booked = table.keywords.filter((r) => !r.off && r.no !== input.proposal?.no && totalOf(r).bookings > 0).length;

  return {
    id: input.id,
    at: input.nowIso,
    on: input.today,
    from: addDays(input.today, -7 * n),
    to: addDays(input.today, -1),
    weeks: n,
    seen,
    ...(input.proposal ? { proposalId: input.proposal.id, proposal } : {}),
    ...(!input.proposal ? { failed: input.failed ?? "案はプログラムの確認を通らなかったので、出しませんでした。" } : {}),
    kept,
    keptMore: Math.max(0, all.length - kept.length),
    booked,
    next: checkDueDate(input.shop, input.today, settings.oncePerDays),
    mode: input.mode,
    ...(input.fromJobs ? { fromJobs: true } : {}),
  };
}

/** 報告を1枚残す（新しい順。listCount 枚まで） */
export function withReport(s: AdsState, r: AdWeeklyReport, settings: Pick<AdSettings, "report">): AdsState {
  if ((s.reports ?? []).some((x) => x.id === r.id)) return s;
  return { ...s, reports: [r, ...(s.reports ?? [])].slice(0, Math.max(1, settings.report.listCount)) };
}

/** 一言のまとめを付ける（null = 付けなかった。頼んだ印だけ残す） */
export function withNote(s: AdsState, kind: "judgement" | "report", id: string, note: string | null): AdsState {
  const put = <T extends { id: string; note?: string; noteTried?: boolean }>(x: T): T =>
    x.id === id ? { ...x, noteTried: true, ...(note ? { note } : {}) } : x;
  return kind === "judgement" ? { ...s, judgements: (s.judgements ?? []).map(put) } : { ...s, reports: (s.reports ?? []).map(put) };
}

/** 画面に出す4行（① 見た数字 ② 止めた・外した ③ 止めなかった ④ 次に見る日） */
export type ReportLines = { seen: string; changed: string; changedReason?: string; kept: string[]; next: string };

/** 4行を、いまの承認BOXの行（承認・見送り）と判定から組み立てる。数はどれもプログラムが入れる */
export function reportLines(r: AdWeeklyReport, ads: AdsState, book: BookState, shop: ShopSettings, settings: Pick<AdSettings, "checkAfterDays">): ReportLines {
  const d = (x: string) => calDay(shop, x).label;
  const seen = `${d(r.from)}〜${d(r.to)}（${r.weeks}週）：押された ${r.seen.clicks.toLocaleString("ja-JP")}回・お金 ${yen(r.seen.cost)}・予約 ${r.seen.bookings}件（広告を出す言葉みんな）`;

  let changed: string;
  let changedReason: string | undefined;
  let judgeOn: string | null = null;
  if (r.proposal) {
    const p = r.proposal;
    const word = `${p.no}番「${p.text}」`;
    const row = r.proposalId ? ads.proposals.find((x) => x.id === r.proposalId) : undefined;
    const state = row?.state;
    // 直したときは、承認BOXの行のほうの言葉を出す
    const now = row ? { action: row.action, no: row.no, text: row.text } : p;
    const nowWord = `${now.no}番「${now.text}」`;
    if (state === "approved") {
      changed = `${actionPast(now.action)}：${nowWord}`;
      const a = ads.applied.find((x) => x.proposalId === r.proposalId);
      const j = (ads.judgements ?? []).find((x) => x.proposalId === r.proposalId);
      judgeOn = j?.due ?? (a ? judgeDueOf(book, a, shop, settings) : null);
      if (j?.revert?.state === "approved") changed += "（判定のあと元に戻した）";
    } else if (state === "skipped") changed = `なし（${nowWord}を${actionVerb(now.action)}案は見送った）`;
    else if (state === "pending") changed = `承認待ち：${nowWord}を${actionVerb(now.action)}案`;
    else changed = `なし（${word}を${actionVerb(p.action)}案は、もう承認BOXにありません）`;
    if (row && (row.no !== p.no || row.action !== p.action)) changedReason = "（直したので、理由は承認BOXの行を見てください）";
    else changedReason = p.reason ? `理由（AI）：${p.reason}` : `理由の文は言葉の門で載せていません（${p.reasonHidden ?? ""}）`;
  } else changed = `なし（${r.failed ?? "案は出ませんでした"}）`;

  const kept = r.kept.map((k) => `${k.no}番「${k.text}」：${k.why}`);
  if (r.keptMore > 0) kept.push(`ほかに予約につながっていない言葉が${r.keptMore}つ（次の見直しで見ます）`);
  if (r.booked > 0) kept.push(`予約につながっている広告を出す言葉 ${r.booked}つは、そのまま出しています`);
  if (kept.length === 0) kept.push("ありません");

  const next = `次の見直し：${d(r.next)}から${judgeOn ? `／効いたかの判定：${d(judgeOn)}` : ""}`;
  return { seen, changed, ...(changedReason ? { changedReason } : {}), kept, next };
}
