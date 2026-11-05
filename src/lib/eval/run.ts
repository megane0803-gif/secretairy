// 試験10問（/eval。docs/SPEC.md §1.13）を順に流す。1問ずつ窓口に送り、答えをプログラムで判定する。
// 守り：同時に1回だけ（ここは画面の中。サーバーでも guard.ts で見張る）・1問ごとに config/ai.json の eval.minIntervalSeconds 秒あける・1回の試験で窓口を呼ぶのは eval.maxCallsPerRun 回まで・止めるボタン。
// 合格・不合格に数えない物（流せなかった）：AI につながらない・通信のまちがい・空の返事・途中で止まった・決まった返事（AI なし）・窓口が受けなかった・上限・止めた。
// AI につながらなかったら、そこで止める（残りは流さない）。結果は返すだけで、どこにも残さない・送らない。

import { answerText, judgeQuestion, readReserve, type CheckResult, type EvalAnswer, type EvalEndpoint, type EvalMode, type EvalQuestion } from "./questions";

/** pass = 合格 / fail = 不合格 / unrun = 流せなかった（合格にも不合格にも数えない） */
export type EvalStatus = "pass" | "fail" | "unrun";

/** 流せなかった訳 */
export type UnrunCode = "no-ai" | "network" | "empty" | "cut" | "script" | "bad-request" | "limit" | "server" | "stopped" | "after-no-ai" | "after-server";

export const UNRUN_LABEL: Record<UnrunCode, string> = {
  "no-ai": "AI につながらない",
  network: "通信のまちがい",
  empty: "空の返事",
  cut: "途中で止まった",
  script: "決まった返事（AI なし）",
  "bad-request": "窓口が受けなかった",
  limit: "1回の試験で呼べる回数の上限",
  server: "サーバーが受けなかった（同時に1回だけ・呼べる回数）",
  stopped: "止めた",
  "after-no-ai": "AI につながらないので流していない",
  "after-server": "サーバーが受けないので流していない",
};

export type EvalResult = {
  no: number;
  id: string;
  title: string;
  prompt: string;
  status: EvalStatus;
  /** 流せなかった時の訳（message はまちがいの中身。合言葉は入らない） */
  unrun?: { code: UnrunCode; message: string };
  /** 合格の条件ごとの ✓ / ✗（決まった返事の時も、形を見るために出す） */
  checks: CheckResult[];
  /** 答えの文（表に出す） */
  answer: string;
  /** 答えが来るまでの時間（ミリ秒） */
  ms: number;
};

/** 窓口に届かなかった・答えが読めなかった（通信のまちがい） */
export class EvalNetworkError extends Error {}

/** サーバーの見張りが断った（ほかで流している・呼べる回数の上限・印の期限切れ） */
export class EvalServerRefusedError extends Error {}

/** もう流している（同時に1回だけ） */
export class EvalBusyError extends Error {
  constructor() {
    super("もう試験を流しています（同時に1回だけ）");
  }
}

export type EvalAsk = (endpoint: EvalEndpoint, body: unknown) => Promise<EvalAnswer>;

export type EvalRunOptions = {
  ask: EvalAsk;
  /** 1問ごとにあける長さ（ミリ秒） */
  intervalMs: number;
  /** 1回の試験で窓口を呼ぶ回数の上限 */
  maxCalls: number;
  /** 流した形（script = 決まった返事。合否には数えない） */
  mode: EvalMode;
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

function unrunResult(q: EvalQuestion, code: UnrunCode, message = UNRUN_LABEL[code], answer = "", ms = 0, checks: CheckResult[] = []): EvalResult {
  return { no: q.no, id: q.id, title: q.title, prompt: q.prompt, status: "unrun", unrun: { code, message }, checks, answer, ms };
}

/** 答えが「流せなかった」物か（そうなら訳）。合否はその後で見る */
export function unrunOf(a: EvalAnswer, mode: EvalMode): { code: UnrunCode; message: string } | null {
  if (a.kind === "reserve") {
    const s = readReserve(a.events);
    if (s.error) return { code: s.error.code === "no-ai" ? "no-ai" : "bad-request", message: s.error.message };
    if (!a.events.some((e) => e.t === "done")) return { code: "cut", message: "返事が途中で止まった（終わりの印が無い）" };
    if (!s.text.trim() && s.holds.length === 0 && s.candidates.length === 0) return { code: "empty", message: "返事が空" };
  } else if (a.kind === "karte") {
    const r = a.res;
    if (!r || typeof r !== "object" || !("ok" in r)) return { code: "network", message: "答えの形が読めない" };
    if (!r.ok && (r.code === "no-ai" || r.code === "bad-request")) return { code: r.code, message: r.message };
    if (r.ok) {
      if (r.mode === "script" && mode === "ai") return { code: "script", message: "決まった返事（AI なし）に切りかわった" };
      if (r.cut) return { code: "cut", message: "カルテの案が途中まで（返事の長さの上限）" };
      if (Object.values(r.sections).every((l) => l.length === 0)) return { code: "empty", message: "カルテの案が空" };
    }
  } else {
    const r = a.res;
    if (!r || typeof r !== "object" || !("ok" in r)) return { code: "network", message: "答えの形が読めない" };
    if (!r.ok && (r.code === "no-ai" || r.code === "bad-request")) return { code: r.code, message: r.message };
    if (r.ok && !r.text.trim()) return { code: "empty", message: "下書きが空" };
    if (r.ok && r.cut) return { code: "cut", message: "下書きが途中まで（返事の長さの上限）" };
  }
  if (mode === "script") return { code: "script", message: "決まった返事（AI なし）で形だけ試した（合否に数えない）" };
  return null;
}

/** 1問の答えを判定する（AI は使わない） */
export function resultOf(q: EvalQuestion, a: EvalAnswer, ms: number, mode: EvalMode = "ai", labels: Record<string, string> = {}): EvalResult {
  const answer = answerText(a, labels);
  const un = unrunOf(a, mode);
  // 決まった返事の時は、形を見るために条件も出す（数えない）。それ以外の流せなかった物は条件を見ない
  if (un) return unrunResult(q, un.code, un.message, answer, ms, un.code === "script" ? judgeQuestion(q, a) : []);
  const checks = judgeQuestion(q, a);
  return { no: q.no, id: q.id, title: q.title, prompt: q.prompt, status: checks.every((c) => c.ok) ? "pass" : "fail", checks, answer, ms };
}

// 同時に1回だけ（この画面の中。ほかの画面とは、画面の側で Web Locks を使って分ける）
let running = false;

export function isEvalRunning(): boolean {
  return running;
}

export async function runEval(questions: EvalQuestion[], opt: EvalRunOptions): Promise<EvalResult[]> {
  if (running) throw new EvalBusyError();
  running = true;
  try {
    return await runAll(questions, opt);
  } finally {
    running = false;
  }
}

async function runAll(questions: EvalQuestion[], opt: EvalRunOptions): Promise<EvalResult[]> {
  const sleep = opt.sleep ?? realSleep;
  const clock = opt.clock ?? (() => Date.now());
  const out: EvalResult[] = [];
  const push = (r: EvalResult) => {
    out.push(r);
    opt.onResult?.(r);
  };
  let stop: UnrunCode | null = null;
  let calls = 0;
  for (const [i, q] of questions.entries()) {
    if (!stop && opt.shouldStop?.()) stop = "stopped";
    if (stop) {
      push(unrunResult(q, stop));
      continue;
    }
    if (calls >= opt.maxCalls) {
      push(unrunResult(q, "limit", `${UNRUN_LABEL.limit}（${opt.maxCalls}回）`));
      continue;
    }
    // 前の問いの答えが来てから、決まった秒数あける（1分10回の上限のため）
    if (i > 0) await sleep(opt.intervalMs);
    if (opt.shouldStop?.()) {
      stop = "stopped";
      push(unrunResult(q, stop));
      continue;
    }
    calls += 1;
    const t0 = clock();
    let r: EvalResult;
    try {
      const answer = await opt.ask(q.endpoint, q.body);
      r = resultOf(q, answer, Math.max(0, clock() - t0), opt.mode, opt.labels);
    } catch (e) {
      const msg = e instanceof Error && e.message ? e.message : String(e);
      r =
        e instanceof EvalServerRefusedError
          ? unrunResult(q, "server", msg, "", Math.max(0, clock() - t0))
          : unrunResult(q, "network", `${UNRUN_LABEL.network}：${msg}`, "", Math.max(0, clock() - t0));
    }
    push(r);
    if (r.unrun?.code === "no-ai") stop = "after-no-ai";
    if (r.unrun?.code === "server") stop = "after-server";
  }
  return out;
}

/** 数（流せなかった物は合格にも不合格にも数えない） */
export function tally(results: EvalResult[]): { pass: number; fail: number; unrun: number; total: number } {
  const pass = results.filter((r) => r.status === "pass").length;
  const fail = results.filter((r) => r.status === "fail").length;
  return { pass, fail, unrun: results.length - pass - fail, total: results.length };
}
