// 広告の「効いたかの判定」と「毎週の見直しの報告」の形と、ブラウザに残っていた物の読み方（docs/SPEC.md §1.7.1・§1.7.2）。
// 置き場所は広告の承認の箱と同じ secretairy:ads（state.ts の AdsState の judgements・reports）。
// なので「最初に戻す」「広告を最初に戻す」で、いっしょに消える。

import type { AdWeek } from "../data/types";
import type { AdAction } from "./report";
import type { AdsMode } from "./wire";

/** worked = 効いた / revert = 戻す案（予約が減った）/ unknown = まだ分からない（数が少ない など） */
export type AdVerdict = "worked" | "revert" | "unknown";

export const VERDICT_LABEL: Record<AdVerdict, string> = {
  worked: "効いた",
  revert: "戻す案",
  unknown: "まだ分からない",
};

/** 戻す案（承認の箱の行）。pending = 承認待ち / approved = 戻した / skipped = 戻さなかった */
export type AdRevertState = "pending" | "approved" | "skipped";

/** 判定1つ（止めた・外した言葉1つに1つ。数はどれもプログラムが入れた物） */
export type AdJudgement = {
  /** jd-（承認した案の id） */
  id: string;
  proposalId: string;
  no: number;
  action: AdAction;
  text: string;
  /** 承認した時刻 */
  approvedAt: string;
  /** 判定日（YYYY-MM-DD。ToDo「効いたか見る」の期限） */
  due: string;
  judgedAt: string;
  /** デモ：「判定日まで進める（デモ）」で、判定日まで進めたことにして判定した */
  demo: boolean;
  /** 比べた週の数 */
  weeks: number;
  /** 前：止める前の同じ週の数（広告を出す言葉みんな） */
  before: AdWeek;
  /** 後：止めた後の数（架空。seed/ads.json の after） */
  after: AdWeek;
  /** その言葉の、前の週の数 */
  word: AdWeek;
  verdict: AdVerdict;
  /** プログラムの1文（なぜその判定か） */
  why: string;
  revert?: { state: AdRevertState; decidedAt?: string };
  /** 案を作った物（決まった返事の案には AI の一言を付けない） */
  mode: AdsMode;
  /** AI（Haiku）の一言（数字なし・言葉の門を通った物） */
  note?: string;
  /** 一言を頼んだ（1回だけ） */
  noteTried?: boolean;
};

/** 報告の「止めなかった言葉」1つ。理由はプログラムが決まりから入れる */
export type AdKept = { no: number; text: string; action: AdAction; why: string };

/** 毎週の見直しの報告（見直しを1回するたびに1枚） */
export type AdWeeklyReport = {
  id: string;
  at: string;
  /** 見直した日（「翌日へ」も入れた今日） */
  on: string;
  /** ① 見た数字：期間（YYYY-MM-DD）と、広告を出す言葉みんなの合計 */
  from: string;
  to: string;
  weeks: number;
  seen: AdWeek;
  /** ② 案（承認の箱の行の id。止めたか・見送ったかは、その行から出す） */
  proposalId?: string;
  proposal?: {
    action: AdAction;
    no: number;
    text: string;
    /** AI の案の理由（言葉の門を通った物）。通らなければ無し */
    reason?: string;
    /** 理由を載せなかった訳（言葉の門） */
    reasonHidden?: string;
  };
  /** 案が出なかった（門を通らなかった）ときの一言 */
  failed?: string;
  /** ③ 止めなかった言葉とその理由 */
  kept: AdKept[];
  /** ③ に出しきれなかった数 */
  keptMore: number;
  /** 予約につながっていて、そのままにした言葉の数 */
  booked: number;
  /** ④ 次に見る日（YYYY-MM-DD） */
  next: string;
  mode: AdsMode;
  /** 「AI の仕事」から */
  fromJobs?: boolean;
  note?: string;
  noteTried?: boolean;
};

const isStr = (x: unknown): x is string => typeof x === "string";
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;
const isAction = (x: unknown): x is AdAction => x === "stop" || x === "exclude";
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (x: unknown): x is string => isStr(x) && DATE.test(x);
const VERDICTS: AdVerdict[] = ["worked", "revert", "unknown"];
const REVERTS: AdRevertState[] = ["pending", "approved", "skipped"];

function week(x: unknown): AdWeek | null {
  if (!isObj(x) || !isInt(x.clicks) || !isInt(x.cost) || !isInt(x.bookings)) return null;
  return { clicks: x.clicks, cost: x.cost, bookings: x.bookings };
}

const clip = (s: string, n: number) => s.slice(0, n);

export function parseJudgements(x: unknown): AdJudgement[] {
  if (!Array.isArray(x)) return [];
  const out: AdJudgement[] = [];
  for (const j of x.slice(0, 100)) {
    if (!isObj(j)) continue;
    const before = week(j.before);
    const after = week(j.after);
    const word = week(j.word);
    if (
      !isStr(j.id) ||
      !isStr(j.proposalId) ||
      !isInt(j.no) ||
      !isAction(j.action) ||
      !isStr(j.text) ||
      !isStr(j.approvedAt) ||
      !isDate(j.due) ||
      !isStr(j.judgedAt) ||
      !isInt(j.weeks) ||
      !before ||
      !after ||
      !word ||
      !VERDICTS.includes(j.verdict as AdVerdict) ||
      !isStr(j.why)
    )
      continue;
    const r = isObj(j.revert) && REVERTS.includes(j.revert.state as AdRevertState) ? j.revert : null;
    out.push({
      id: j.id,
      proposalId: j.proposalId,
      no: j.no,
      action: j.action,
      text: clip(j.text, 40),
      approvedAt: j.approvedAt,
      due: j.due,
      judgedAt: j.judgedAt,
      demo: j.demo === true,
      weeks: j.weeks,
      before,
      after,
      word,
      verdict: j.verdict as AdVerdict,
      why: clip(j.why, 200),
      ...(r ? { revert: { state: r.state as AdRevertState, ...(isStr(r.decidedAt) ? { decidedAt: r.decidedAt } : {}) } } : {}),
      mode: j.mode === "script" ? "script" : "ai",
      ...(isStr(j.note) ? { note: clip(j.note, 200) } : {}),
      ...(j.noteTried === true ? { noteTried: true } : {}),
    });
  }
  return out;
}

export function parseReports(x: unknown): AdWeeklyReport[] {
  if (!Array.isArray(x)) return [];
  const out: AdWeeklyReport[] = [];
  for (const r of x.slice(0, 50)) {
    if (!isObj(r)) continue;
    const seen = week(r.seen);
    if (!isStr(r.id) || !isStr(r.at) || !isDate(r.on) || !isDate(r.from) || !isDate(r.to) || !isInt(r.weeks) || !seen || !isDate(r.next)) continue;
    const p = isObj(r.proposal) && isAction(r.proposal.action) && isInt(r.proposal.no) && isStr(r.proposal.text) ? r.proposal : null;
    const kept: AdKept[] = Array.isArray(r.kept)
      ? r.kept
          .filter((k): k is Record<string, unknown> => isObj(k) && isInt(k.no) && isStr(k.text) && isAction(k.action) && isStr(k.why))
          .slice(0, 20)
          .map((k) => ({ no: k.no as number, text: clip(k.text as string, 40), action: k.action as AdAction, why: clip(k.why as string, 120) }))
      : [];
    out.push({
      id: r.id,
      at: r.at,
      on: r.on,
      from: r.from,
      to: r.to,
      weeks: r.weeks,
      seen,
      ...(isStr(r.proposalId) ? { proposalId: r.proposalId } : {}),
      ...(p
        ? {
            proposal: {
              action: p.action as AdAction,
              no: p.no as number,
              text: clip(p.text as string, 40),
              ...(isStr(p.reason) ? { reason: clip(p.reason, 200) } : {}),
              ...(isStr(p.reasonHidden) ? { reasonHidden: clip(p.reasonHidden, 200) } : {}),
            },
          }
        : {}),
      ...(isStr(r.failed) ? { failed: clip(r.failed, 200) } : {}),
      kept,
      keptMore: isInt(r.keptMore) ? r.keptMore : 0,
      booked: isInt(r.booked) ? r.booked : 0,
      next: r.next,
      mode: r.mode === "script" ? "script" : "ai",
      ...(r.fromJobs === true ? { fromJobs: true } : {}),
      ...(isStr(r.note) ? { note: clip(r.note, 200) } : {}),
      ...(r.noteTried === true ? { noteTried: true } : {}),
    });
  }
  return out;
}
