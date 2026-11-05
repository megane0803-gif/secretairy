// 試験10問の窓口（画面の側）。今の /api/ai/ の窓口をそのまま呼ぶ（上限も窓口の側の今の物）。
// 届かない・答えが読めない時は EvalNetworkError を投げる（「流せなかった：通信のまちがい」になる）。
// 予約チャットの流れる返事は全部読み、終わりの印（done）が無ければ「途中で止まった」として判定する。
// 答えは画面の表に出すだけで、ほかには送らない・残さない。合言葉はここでは扱わない（/api/eval で1回だけ確かめる）。

import type { ReserveEvent } from "../ai/wire";
import type { KarteResponse } from "../karte/wire";
import type { PostsResponse } from "../posts/wire";
import { EVAL_PATHS, type EvalEndpoint } from "./questions";
import { EvalNetworkError, type EvalAsk } from "./run";

async function post(endpoint: EvalEndpoint, body: unknown): Promise<Response> {
  try {
    return await fetch(EVAL_PATHS[endpoint], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw new EvalNetworkError(`届かなかった（${e instanceof Error ? e.message : String(e)}）`);
  }
}

async function readText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (e) {
    throw new EvalNetworkError(`読んでいる途中で切れた（${e instanceof Error ? e.message : String(e)}）`);
  }
}

/** 1つの JSON（カルテ・発信）。形の読めない答えは通信のまちがい */
async function askJson<T extends { ok: boolean }>(endpoint: EvalEndpoint, body: unknown): Promise<T> {
  const res = await post(endpoint, body);
  const text = await readText(res);
  let out: unknown;
  try {
    out = JSON.parse(text);
  } catch {
    throw new EvalNetworkError(`答えが読めない（HTTP ${res.status}）`);
  }
  if (!out || typeof out !== "object" || !("ok" in out)) throw new EvalNetworkError(`答えの形がちがう（HTTP ${res.status}）`);
  return out as T;
}

/** 予約チャット：1行ずつの JSON。窓口が断った時（400 など）は1つの JSON で来る */
async function askReserve(body: unknown): Promise<ReserveEvent[]> {
  const res = await post("reserve", body);
  const text = await readText(res);
  if (!res.ok) {
    try {
      const e = JSON.parse(text) as { message?: string };
      return [{ t: "error", code: res.status >= 500 ? "no-ai" : "bad-request", message: e.message ?? `HTTP ${res.status}` }, { t: "done" }];
    } catch {
      throw new EvalNetworkError(`答えが読めない（HTTP ${res.status}）`);
    }
  }
  const out: ReserveEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ReserveEvent);
    } catch {
      // 形の崩れた行（途中で切れた最後の行など）は読み飛ばす。done が無ければ「途中で止まった」になる
    }
  }
  return out;
}

export const browserEvalAsk: EvalAsk = async (endpoint, body) => {
  if (endpoint === "reserve") return { kind: "reserve", events: await askReserve(body) };
  if (endpoint === "karte") return { kind: "karte", res: await askJson<KarteResponse>("karte", body) };
  return { kind: "posts", res: await askJson<PostsResponse>("posts", body) };
};

/** 合言葉を確かめて、表の上に出すコミットとモデルを受け取る（/api/eval。AI は呼ばない） */
export type EvalStart = { ok: true; commit: string; models: { reserve: string; karte: string; posts: string } } | { ok: false; message: string };

export async function startEval(passcode: string): Promise<EvalStart> {
  let res: Response;
  try {
    res = await fetch("/api/eval", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passcode }) });
  } catch {
    return { ok: false, message: "通信のまちがいで、合言葉を確かめられませんでした" };
  }
  try {
    const out = (await res.json()) as EvalStart & { message?: string };
    if (out && out.ok === true) return { ok: true, commit: out.commit, models: out.models };
    return { ok: false, message: out?.message ?? `HTTP ${res.status}` };
  } catch {
    return { ok: false, message: `合言葉の答えが読めませんでした（HTTP ${res.status}）` };
  }
}
