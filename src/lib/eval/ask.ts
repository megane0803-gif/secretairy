// 試験10問の窓口（画面の側）。今の /api/ai/ の窓口をそのまま呼ぶ（上限も窓口の側の今の物）。
// 答えは画面の表に出すだけで、ほかには送らない・残さない。

import { NO_AI_MESSAGE } from "../ai/wire";
import { browserJobAsk } from "../jobs/ask";
import type { KarteResponse } from "../karte/wire";
import { askPostDraft } from "../posts/client";
import type { PostsRequest } from "../posts/wire";
import type { ReserveRequest } from "../ai/wire";
import { EVAL_PATHS } from "./questions";
import type { EvalAsk } from "./run";

async function askKarte(body: unknown): Promise<KarteResponse> {
  try {
    const res = await fetch(EVAL_PATHS.karte, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = (await res.json()) as KarteResponse;
    if (out && typeof out === "object" && "ok" in out) return out;
  } catch {}
  return { ok: false, code: "no-ai", message: NO_AI_MESSAGE };
}

export const browserEvalAsk: EvalAsk = async (endpoint, body) => {
  if (endpoint === "reserve") return { kind: "reserve", events: await browserJobAsk.reserve(body as ReserveRequest) };
  if (endpoint === "karte") return { kind: "karte", res: await askKarte(body) };
  return { kind: "posts", res: await askPostDraft(body as PostsRequest) };
};
