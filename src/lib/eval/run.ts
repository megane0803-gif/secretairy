// 試験10問（/eval。docs/SPEC.md §1.13）を順に流す。1問ずつ窓口に送り、答えをプログラムで判定する。
// 1問ごとに config/ai.json の eval.minIntervalSeconds 秒あける（/api/ai/ は1分10回まで）。
// AI につながらなかったら、そこで止める（残りは流さない）。結果は返すだけで、どこにも残さない・送らない。

import { NO_AI_MESSAGE } from "../ai/wire";
import { answerProblem, answerText, judgeQuestion, type CheckResult, type EvalAnswer, type EvalEndpoint, type EvalQuestion } from "./questions";

/** pass = 合格 / fail = 不合格 / no-ai = AI につながらない / error = 窓口が受けなかった / skipped = 流していない */
export type EvalStatus = "pass" | "fail" | "no-ai" | "error" | "skipped";

export type EvalResult = {
  no: number;
  id: string;
  title: string;
  prompt: string;
  status: EvalStatus;
  checks: CheckResult[];
  /** 答えの文（表に出す） */
  answer: string;
  /** 答えが来るまでの時間（ミリ秒） */
  ms: number;
};

export type EvalAsk = (endpoint: EvalEndpoint, body: unknown) => Promise<EvalAnswer>;

export type EvalRunOptions = {
  ask: EvalAsk;
  /** 1問ごとにあける長さ（ミリ秒） */
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  /** 1問の結果が出るたび（表を少しずつ出すため） */
  onResult?: (r: EvalResult) => void;
  /** 次の問いを流す前に呼ぶ。true なら止める */
  shouldStop?: () => boolean;
  /** カルテの見出しの id → 名前（答えの文に出す） */
  labels?: Record<string, string>;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function skippedResult(q: EvalQuestion, why: string): EvalResult {
  return { no: q.no, id: q.id, title: q.title, prompt: q.prompt, status: "skipped", checks: [], answer: why, ms: 0 };
}

export const STOPPED_NO_AI = "AI につながらないので流していません";
export const STOPPED_BY_HAND = "止めたので流していません";

/** 1問の答えを判定する（AI は使わない） */
export function resultOf(q: EvalQuestion, a: EvalAnswer, ms: number, labels: Record<string, string> = {}): EvalResult {
  const base = { no: q.no, id: q.id, title: q.title, prompt: q.prompt, answer: answerText(a, labels), ms };
  const problem = answerProblem(a);
  if (problem) return { ...base, status: problem.code === "no-ai" ? "no-ai" : "error", checks: [] };
  const checks = judgeQuestion(q, a);
  return { ...base, status: checks.every((c) => c.ok) ? "pass" : "fail", checks };
}

/** 窓口に届かなかった時の答え（AI につながらない） */
export function noAiAnswer(endpoint: EvalEndpoint): EvalAnswer {
  const no = { code: "no-ai" as const, message: NO_AI_MESSAGE };
  if (endpoint === "reserve") return { kind: "reserve", events: [{ t: "error", ...no }] };
  return endpoint === "karte" ? { kind: "karte", res: { ok: false, ...no } } : { kind: "posts", res: { ok: false, ...no } };
}

export async function runEval(questions: EvalQuestion[], opt: EvalRunOptions): Promise<EvalResult[]> {
  const sleep = opt.sleep ?? realSleep;
  const clock = opt.clock ?? (() => Date.now());
  const out: EvalResult[] = [];
  let stop: string | null = null;
  for (const [i, q] of questions.entries()) {
    if (!stop && opt.shouldStop?.()) stop = STOPPED_BY_HAND;
    if (stop) {
      const r = skippedResult(q, stop);
      out.push(r);
      opt.onResult?.(r);
      continue;
    }
    // 前の問いの答えが来てから、決まった秒数あける（1分10回の上限のため）
    if (i > 0) await sleep(opt.intervalMs);
    if (opt.shouldStop?.()) {
      stop = STOPPED_BY_HAND;
      const r = skippedResult(q, stop);
      out.push(r);
      opt.onResult?.(r);
      continue;
    }
    const t0 = clock();
    let answer: EvalAnswer;
    try {
      answer = await opt.ask(q.endpoint, q.body);
    } catch {
      answer = noAiAnswer(q.endpoint);
    }
    const r = resultOf(q, answer, Math.max(0, clock() - t0), opt.labels);
    out.push(r);
    opt.onResult?.(r);
    if (r.status === "no-ai") stop = STOPPED_NO_AI;
  }
  return out;
}

/** 合格の数 */
export function tally(results: EvalResult[]): { pass: number; fail: number; other: number; total: number } {
  const pass = results.filter((r) => r.status === "pass").length;
  const fail = results.filter((r) => r.status === "fail").length;
  return { pass, fail, other: results.length - pass - fail, total: results.length };
}
