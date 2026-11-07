// ホームの「AI の仕事」：どの行が済んだかと、その結果（短い1行）を、見ている人のブラウザの中だけに残す形（docs/SPEC.md §1.12・§5.1）。
// ここは形と変え方だけ（どこにも書かない）。書くのは jobs/browserStore.ts（画面）と、テストのメモリの置き場所。
// 1回動かした行は「済み」になり、2回は動かない。「最初に戻す」で消える（reset.ts）。

import type { TabId } from "../tabs";
import { withoutOldMark } from "../guestName";

/** 上から順に動かす行（4行＋予約サイトから予約が入る） */
export const JOB_IDS = ["reserve", "card", "ads", "memo", "site"] as const;
export type JobId = (typeof JOB_IDS)[number];

/** 済んだ行の結果（例「承認待ち1件」）と、結果が届いたタブ */
export type JobDone = { at: string; result: string; tab: TabId };

export type JobsState = { v: 1; done: Partial<Record<JobId, JobDone>> };

/** 承認の箱に入った時の結果の言葉（予約の相談・広告の見直し。広告は足す案の行も数える） */
export function jobApprovalResult(n: number): string {
  return `承認待ち${n}件`;
}

/** 承認の箱に1行入った時の結果の言葉 */
export const JOB_APPROVAL_RESULT = jobApprovalResult(1);

/**
 * 済んだ行の結果のリンクの先。承認の箱に入った物は、同じページ（ホーム）の承認の箱へ（予約・広告のタブへは行かない）。
 * ほかは結果が届いたタブへ。
 */
export function jobDoneLink(done: Pick<JobDone, "result" | "tab">): { kind: "approvals" } | { kind: "tab"; tab: TabId } {
  return /^承認待ち\d+件$/.test(done.result) ? { kind: "approvals" } : { kind: "tab", tab: done.tab };
}

export const EMPTY_JOBS: JobsState = { v: 1, done: {} };

const TAB_OF: Record<JobId, readonly TabId[]> = {
  reserve: ["reservations", "todo"],
  card: ["accounting"],
  ads: ["ads"],
  memo: ["todo"],
  site: ["reservations", "todo"],
};

export const isJobId = (x: unknown): x is JobId => typeof x === "string" && (JOB_IDS as readonly string[]).includes(x);

/** ブラウザに残っていた文字を読む。形のおかしい物は落とす */
export function parseJobs(raw: string | null): JobsState {
  if (!raw) return EMPTY_JOBS;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(raw);
  } catch {
    return EMPTY_JOBS;
  }
  if (!d || typeof d !== "object" || !d.done || typeof d.done !== "object") return EMPTY_JOBS;
  const done: JobsState["done"] = {};
  for (const [k, v] of Object.entries(d.done as Record<string, unknown>)) {
    if (!isJobId(k) || !v || typeof v !== "object") continue;
    const x = v as Record<string, unknown>;
    if (typeof x.at !== "string" || typeof x.result !== "string" || !TAB_OF[k].includes(x.tab as TabId)) continue;
    done[k] = { at: x.at, result: withoutOldMark(x.result).slice(0, 80), tab: x.tab as TabId };
  }
  return { v: 1, done };
}

export function isJobDone(s: JobsState, id: JobId): boolean {
  return !!s.done[id];
}

/** 済みにする。もう済んだ行は変えない（2回は動かない） */
export function withJobDone(s: JobsState, id: JobId, done: JobDone): JobsState {
  if (s.done[id]) return s;
  return { ...s, done: { ...s.done, [id]: done } };
}

/** まだ済んでいない行（上から順） */
export function openJobs(s: JobsState, ids: readonly JobId[] = JOB_IDS): JobId[] {
  return ids.filter((id) => !s.done[id]);
}
