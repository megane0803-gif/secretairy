// 試験10問（/eval）の見張り（サーバーの側）。「同時に1回だけ」と「1回の試験で窓口を呼ぶ回数の上限」を、
// 画面の中だけでなくサーバーでも守る。別のタブ・別の端末から同時に押しても、印を取れた片方だけが流せる。
// 置き場所は LINE と同じ Upstash の KV（src/lib/line/store.ts）。置くのは「流している印」と「呼んだ回数」だけで、どちらも期限つき。
//   - 印（LOCK）：始める時に「まだ無い時だけ置く」（SET NX EX）。中身は試験の札（画面だけが持つ乱数）のハッシュ
//   - 回数（CALLS）：窓口を呼ぶたびに1つ足す（INCR）。上限をこえたら受けない
//   - 期限：config/ai.json の eval.lockSeconds。窓口を呼ぶたびに付けなおす。止めた・終わった時は消し、途中で落ちた時は期限で消える
// 札そのもの・合言葉・お客様の記録は置かない（ハッシュだけ）。

import { createHash, randomBytes } from "node:crypto";
import { NoStoreError, storeEnv, upstashStore, type KvStore } from "../line/store";

const LOCK = "eval:lock";
const calls = (hash: string) => `eval:calls:${hash}`;

/** 画面とサーバーのあいだで、試験の札を送る見出し（/api/ai/ の窓口が見る） */
export const EVAL_RUN_HEADER = "x-secretairy-eval-run";

const hashOf = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

let override: KvStore | null = null;

/** テストでは memoryStore に置きかえる */
export function setEvalStoreForTest(store: KvStore | null): void {
  override = store;
}

/** 置き場所。つながっていなければ null（その時は試験を流さない） */
export function evalStore(): KvStore | null {
  if (override) return override;
  const conf = storeEnv();
  return conf ? upstashStore(conf) : null;
}

export type StartRun = { ok: true; token: string } | { ok: false; code: "busy" | "no-store" };

/** 始める：印が無い時だけ置き、札を返す。もう印があれば busy（ほかのタブ・端末で流している） */
export async function startRun(store: KvStore | null, lockSeconds: number): Promise<StartRun> {
  if (!store) return { ok: false, code: "no-store" };
  const token = randomBytes(24).toString("hex");
  try {
    const got = await store.set(LOCK, hashOf(token), { ex: lockSeconds, nx: true });
    return got ? { ok: true, token } : { ok: false, code: "busy" };
  } catch (e) {
    if (e instanceof NoStoreError) return { ok: false, code: "no-store" };
    throw e;
  }
}

export type TakeCall = { ok: true; count: number } | { ok: false; code: "not-running" | "limit" | "no-store"; count?: number };

/** 窓口を1回呼ぶ前に：札が今の印と合うか確かめ、回数を1つ足す。上限をこえたら受けない。期限を付けなおす */
export async function takeCall(store: KvStore | null, token: string, maxCalls: number, lockSeconds: number): Promise<TakeCall> {
  if (!store) return { ok: false, code: "no-store" };
  if (!token) return { ok: false, code: "not-running" };
  const hash = hashOf(token);
  try {
    if ((await store.get(LOCK)) !== hash) return { ok: false, code: "not-running" };
    const count = await store.incr(calls(hash), lockSeconds);
    await store.expire(LOCK, lockSeconds);
    await store.expire(calls(hash), lockSeconds);
    return count > maxCalls ? { ok: false, code: "limit", count } : { ok: true, count };
  } catch (e) {
    if (e instanceof NoStoreError) return { ok: false, code: "no-store" };
    throw e;
  }
}

/** 終える（止めた・終わった）：自分の印の時だけ消す（ほかの試験の印は消さない） */
export async function finishRun(store: KvStore | null, token: string): Promise<boolean> {
  if (!store || !token) return false;
  const hash = hashOf(token);
  try {
    if ((await store.get(LOCK)) !== hash) return false;
    await store.del(LOCK);
    await store.del(calls(hash));
    return true;
  } catch (e) {
    if (e instanceof NoStoreError) return false;
    throw e;
  }
}

export const GUARD_MESSAGE: Record<"busy" | "no-store" | "not-running" | "limit", string> = {
  busy: "ほかのタブか端末で試験を流しています（同時に1回だけ）",
  "no-store": "試験の見張り（KV）につながらないので、試験は流せません",
  "not-running": "この試験の印がサーバーにありません（止めた・期限が切れた・ほかの試験が流れている）",
  limit: "1回の試験で窓口を呼べる回数の上限です（サーバーで数えています）",
};

/**
 * /api/ai/ の窓口の頭で呼ぶ。試験の札（見出し）が付いた頼みだけを見張り、受けない時は断りの Response を返す。
 * 札の無いふだんの頼み（予約チャット・カルテ・発信の画面）は今までどおり（null を返す）。
 */
export async function evalGate(request: Request, settings: { maxCallsPerRun: number; lockSeconds: number }): Promise<Response | null> {
  const token = request.headers.get(EVAL_RUN_HEADER);
  if (token === null) return null;
  const r = await takeCall(evalStore(), token, settings.maxCallsPerRun, settings.lockSeconds);
  if (r.ok) return null;
  const status = r.code === "limit" ? 429 : r.code === "no-store" ? 503 : 409;
  return Response.json({ ok: false, t: "error", code: "eval", reason: r.code, message: GUARD_MESSAGE[r.code] }, { status, headers: { "Cache-Control": "no-store" } });
}
