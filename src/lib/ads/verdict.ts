// 効いたかの判定（プログラム。AI は使わない。docs/SPEC.md §1.7.1）。
// 承認して止めた（外した）言葉ごとに、判定日（承認の checkAfterDays 日後。ToDo「効いたか見る」の期限）に、
// 前（止める前の同じ週の数）と後（止めた後の数。最初の状態に架空の数として置いた seed/ads.json の after）を比べる。
//   数が少なくて分からない → まだ分からない（その言葉の押された回数が少ない・予約が少ない・後の数が無い）
//   予約が減った           → 戻す案（戻すのは取り消せない操作なので、承認BOXに入れる。決めるのは人）
//   お金が減って予約が減っていない → 効いた
//   （お金が減っていない   → まだ分からない）
// 結果は広告タブのカード・日誌・ToDo（判定日の行を済みにする）に出す。
//
// 🔒 確定は人：戻す（approveRevert）を呼ぶのは、人が承認BOXの「承認」を押したときだけ。判定そのものは何も止めも戻しもしない。

import { calDay, shopNow } from "../calendar";
import type { AdReport, AdWeek } from "../data/types";
import { withTodoDone, type BookState } from "../book/state";
import type { JournalWho } from "../journal";
import type { AdSettings, ShopSettings } from "../settings";
import { actionPast, addWeek, yen, ZERO, type AdAction } from "./report";
import { VERDICT_LABEL, type AdJudgement, type AdVerdict } from "./results";
import { AD_TODO_PREFIX, checkDueDate, type AdApplied, type AdsState } from "./state";

type Journal = { who: JournalWho; text: string }[];

export type JudgeSettings = Pick<AdSettings, "checkAfterDays" | "channel" | "judge">;

/** 比べる週の数（判定日までの週。3週間なら3） */
export function compareWeeks(settings: Pick<AdSettings, "checkAfterDays">): number {
  return Math.max(1, Math.round(settings.checkAfterDays / 7));
}

const sum = (weeks: AdWeek[]) => weeks.reduce(addWeek, ZERO);

/** 前：止める前の n 週（広告を出す言葉みんな。表の最後の週から n 週） */
export function beforeTotals(report: AdReport, n: number): AdWeek {
  return sum(report.keywords.flatMap((k) => k.weeks.slice(-n)));
}

/** その言葉の、前の n 週 */
export function wordBefore(report: AdReport, no: number, n: number): AdWeek {
  const row = [...report.keywords, ...report.searchTerms].find((r) => r.no === no);
  return row ? sum(row.weeks.slice(-n)) : ZERO;
}

/** 後：止めた後の n 週（架空。無ければ null） */
export function afterTotals(report: AdReport, no: number, n: number): AdWeek | null {
  const a = report.after?.find((x) => x.no === no);
  if (!a || a.weeks.length < n) return null;
  return sum(a.weeks.slice(0, n));
}

/** 数を比べて、判定とその1文を出す（プログラムの決まり） */
export function judgeNumbers(
  x: { before: AdWeek; after: AdWeek | null; word: AdWeek; action: AdAction },
  rule: AdSettings["judge"],
): { verdict: AdVerdict; why: string } {
  const did = x.action === "stop" ? "止めて" : "外して";
  if (!x.after) return { verdict: "unknown", why: "後の数がまだ無いので、まだ分かりません。" };
  if (x.word.clicks < rule.minWordClicks)
    return { verdict: "unknown", why: `この言葉は押された回数が少なく、${did}も違いが数に出にくいので、まだ分かりません。` };
  if (x.before.bookings + x.after.bookings < rule.minBookings)
    return { verdict: "unknown", why: "予約の数が少なく、違いがたまたまかどうか分からないので、まだ分かりません。" };
  if (x.after.bookings < x.before.bookings)
    return { verdict: "revert", why: `予約が減りました。${x.action === "stop" ? "止める" : "外す"}前に戻す案を、承認BOXに入れました。` };
  if (x.after.cost < x.before.cost) return { verdict: "worked", why: "お金が減って、予約は減っていません。" };
  return { verdict: "unknown", why: "お金が減っていないので、まだ分かりません。" };
}

/** 判定日：ToDo「効いたか見る」の期限（無ければ承認した日から数えなおす） */
export function judgeDueOf(book: BookState, a: AdApplied, shop: ShopSettings, settings: Pick<AdSettings, "checkAfterDays">): string {
  const todo = book.todos.find((t) => t.id === `${AD_TODO_PREFIX}${a.proposalId}`);
  if (todo?.due) return todo.due;
  return checkDueDate(shop, shopNow(shop, new Date(a.at)).date, settings.checkAfterDays);
}

/** まだ判定していない、止めた・外した言葉（判定日の早い順） */
export function waitingJudge(ads: AdsState, book: BookState, shop: ShopSettings, settings: Pick<AdSettings, "checkAfterDays">): { applied: AdApplied; due: string }[] {
  const done = new Set((ads.judgements ?? []).map((j) => j.proposalId));
  return ads.applied
    .filter((a) => !done.has(a.proposalId))
    .map((a) => ({ applied: a, due: judgeDueOf(book, a, shop, settings) }))
    .sort((a, b) => a.due.localeCompare(b.due) || a.applied.at.localeCompare(b.applied.at));
}

/** 判定日が来た物（today は「翌日へ」も入れた今日） */
export function dueToJudge(ads: AdsState, book: BookState, ctx: { shop: ShopSettings; today: string; settings: Pick<AdSettings, "checkAfterDays"> }) {
  return waitingJudge(ads, book, ctx.shop, ctx.settings).filter((w) => w.due <= ctx.today);
}

/** 判定1つを作る（数はどれもプログラムが入れる） */
export function makeJudgement(
  report: AdReport,
  ads: AdsState,
  item: { applied: AdApplied; due: string },
  ctx: { nowIso: string; demo: boolean; settings: JudgeSettings },
): AdJudgement {
  const a = item.applied;
  const p = ads.proposals.find((x) => x.id === a.proposalId);
  const n = compareWeeks(ctx.settings);
  const before = beforeTotals(report, n);
  const after = afterTotals(report, a.no, n);
  const word = wordBefore(report, a.no, n);
  const v = judgeNumbers({ before, after, word, action: a.action }, ctx.settings.judge);
  const text = p?.text ?? [...report.keywords, ...report.searchTerms].find((r) => r.no === a.no)?.text ?? `${a.no}番`;
  return {
    id: `jd-${a.proposalId}`,
    proposalId: a.proposalId,
    no: a.no,
    action: a.action,
    text,
    approvedAt: a.at,
    due: item.due,
    judgedAt: ctx.nowIso,
    demo: ctx.demo,
    weeks: n,
    before,
    after: after ?? ZERO,
    word,
    verdict: v.verdict,
    why: v.why,
    ...(v.verdict === "revert" ? { revert: { state: "pending" as const } } : {}),
    mode: p?.mode ?? "ai",
  };
}

/** 日誌の1行：「判定：10番「…」を外した後の3週 → 効いた（お金 21,580円 → 19,650円・予約 9件 → 9件）」 */
export function judgementLine(j: AdJudgement, channel: string): string {
  const nums = `お金 ${yen(j.before.cost)} → ${yen(j.after.cost)}・予約 ${j.before.bookings}件 → ${j.after.bookings}件`;
  return `判定${j.demo ? "（デモ：判定日まで進めた）" : ""}：${channel}の ${j.no}番「${j.text}」を${actionPast(j.action)}後の${j.weeks}週 → ${VERDICT_LABEL[j.verdict]}（${nums}）。${j.why}`;
}

/**
 * 判定を入れる：判定（広告タブのカード）・ToDo（判定日の行を済みに）・日誌。戻す案なら承認BOXに1行（judgement.revert）。
 * 同じ言葉（承認した案）は2回判定しない。止めた・外した言葉そのものは変えない。
 */
export function withJudged(
  ads: AdsState,
  book: BookState,
  report: AdReport,
  items: { applied: AdApplied; due: string }[],
  ctx: { nowIso: string; demo: boolean; settings: JudgeSettings },
): { ads: AdsState; book: BookState; journal: Journal; made: AdJudgement[] } {
  const done = new Set((ads.judgements ?? []).map((j) => j.proposalId));
  const made: AdJudgement[] = [];
  let nextBook = book;
  const journal: Journal = [];
  for (const it of items) {
    if (done.has(it.applied.proposalId) || !ads.applied.some((a) => a.proposalId === it.applied.proposalId)) continue;
    done.add(it.applied.proposalId);
    const j = makeJudgement(report, ads, it, ctx);
    made.push(j);
    journal.push({ who: "プログラム", text: judgementLine(j, ctx.settings.channel) });
    const todoId = `${AD_TODO_PREFIX}${j.proposalId}`;
    const todo = nextBook.todos.find((t) => t.id === todoId);
    if (todo && !todo.done) {
      nextBook = withTodoDone(nextBook, todoId, true, ctx.nowIso);
      journal.push({ who: "プログラム", text: `ToDo「${todo.title}」を済みにした（判定した）` });
    }
  }
  if (made.length === 0) return { ads, book, journal: [], made };
  return { ads: { ...ads, judgements: [...made, ...(ads.judgements ?? [])] }, book: nextBook, journal, made };
}

/** 承認BOXの「戻す案」（承認待ちの物があれば、古い順に1つ） */
export function pendingRevert(ads: AdsState): AdJudgement | null {
  const list = (ads.judgements ?? []).filter((j) => j.revert?.state === "pending");
  return list.sort((a, b) => a.judgedAt.localeCompare(b.judgedAt))[0] ?? null;
}

/** 「元に戻す」の言葉：「10番「…」をまた出す（外すのをやめる）」 */
export function revertLabel(j: Pick<AdJudgement, "no" | "text" | "action">): string {
  return `${j.no}番「${j.text}」を${j.action === "stop" ? "また出す" : "外すのをやめる"}`;
}

/**
 * 🔒 戻す案の「承認」：広告の管理画面で、止めた（外した）言葉を元に戻す。人が承認BOXの「承認」を押したときだけ呼ぶ。
 * 戻すと判定はそのまま残る（日誌にも）。止めた言葉の一覧から外れるので、次の見直しでまた選べる。
 */
export function approveRevert(ads: AdsState, id: string, nowIso: string, channel: string): { ads: AdsState; journal: Journal } {
  const j = (ads.judgements ?? []).find((x) => x.id === id && x.revert?.state === "pending");
  if (!j) return { ads, journal: [] };
  return {
    ads: {
      ...ads,
      applied: ads.applied.filter((a) => a.proposalId !== j.proposalId),
      judgements: (ads.judgements ?? []).map((x) => (x.id === id ? { ...x, revert: { state: "approved", decidedAt: nowIso } } : x)),
    },
    journal: [{ who: "オーナー", text: `承認：${channel}で ${revertLabel(j)}（戻す案。予約が減ったため）` }],
  };
}

/** 戻す案の「見送り」：止めた（外した）ままにする */
export function skipRevert(ads: AdsState, id: string, nowIso: string): { ads: AdsState; journal: Journal } {
  const j = (ads.judgements ?? []).find((x) => x.id === id && x.revert?.state === "pending");
  if (!j) return { ads, journal: [] };
  return {
    ads: { ...ads, judgements: (ads.judgements ?? []).map((x) => (x.id === id ? { ...x, revert: { state: "skipped", decidedAt: nowIso } } : x)) },
    journal: [{ who: "オーナー", text: `見送り：戻す案「${revertLabel(j)}」を閉じた（${actionPast(j.action)}ままにする）` }],
  };
}

/** 判定日の見出し（11/25（水）） */
export function dueLabel(shop: ShopSettings, date: string): string {
  return calDay(shop, date).label;
}
