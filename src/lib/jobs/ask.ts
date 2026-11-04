// ホームの「AI の仕事」が呼ぶ AI の窓口（画面の側）。今の /api/ai/ の窓口をそのまま使う（上限も窓口の側の今の物）。
// つながらない・サーバーがうまくいかない時は「今は AI につながりません」として返す（投げない）。

import { askAdsReview } from "../ads/client";
import { NO_AI_MESSAGE, type ReserveEvent } from "../ai/wire";
import type { TodoResponse } from "../todo/wire";
import type { JobAsk } from "./run";

const NO_AI: ReserveEvent = { t: "error", code: "no-ai", message: NO_AI_MESSAGE };

/** 予約チャットと同じ /api/ai/reserve。1行ずつの JSON を全部読んでから返す */
async function askReserve(body: unknown): Promise<ReserveEvent[]> {
  try {
    const res = await fetch("/api/ai/reserve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok || !res.body) {
      let msg = "";
      try {
        msg = ((await res.json()) as { message?: string }).message ?? "";
      } catch {}
      return res.status >= 500 || !msg ? [NO_AI] : [{ t: "error", code: "bad-request", message: msg }];
    }
    const text = await res.text();
    const out: ReserveEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ReserveEvent);
      } catch {
        // 形の崩れた行は読み飛ばす
      }
    }
    return out;
  } catch {
    return [NO_AI];
  }
}

/** メモを投げると同じ /api/ai/todo */
async function askTodo(body: unknown): Promise<TodoResponse> {
  try {
    const res = await fetch("/api/ai/todo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = (await res.json()) as TodoResponse;
    if (out && typeof out === "object" && "ok" in out) return out;
  } catch {}
  return { ok: false, code: "no-ai", message: NO_AI_MESSAGE };
}

export const browserJobAsk: JobAsk = { reserve: askReserve, ads: askAdsReview, todo: askTodo };
