// ホームの「AI の仕事」が呼ぶ AI の窓口（画面の側）。今の /api/ai/ の窓口をそのまま使う（上限も窓口の側の今の物）。
// つながらない・サーバーがうまくいかない時は「今は AI につながりません」として返す（投げない）。
// 窓口が混んでいる時（429）は code: "busy"（ai/busy.ts）。理由の文が無い失敗は message が ""。

import { askAdsReview } from "../ads/client";
import { AI_BUSY_MESSAGE, isBusyStatus, reasonOf } from "../ai/busy";
import { NO_AI_MESSAGE, type ReserveEvent } from "../ai/wire";
import { askTodoTitle } from "../todo/client";
import type { JobAsk } from "./run";

const NO_AI: ReserveEvent = { t: "error", code: "no-ai", message: NO_AI_MESSAGE };
const BUSY: ReserveEvent = { t: "error", code: "busy", message: AI_BUSY_MESSAGE };

/** 予約チャットと同じ /api/ai/reserve。1行ずつの JSON を全部読んでから返す */
async function askReserve(body: unknown): Promise<ReserveEvent[]> {
  try {
    const res = await fetch("/api/ai/reserve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (isBusyStatus(res.status)) return [BUSY];
    if (!res.ok || !res.body) {
      let msg: string | null = null;
      try {
        msg = reasonOf(await res.json());
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

export const browserJobAsk: JobAsk = { reserve: askReserve, ads: askAdsReview, todo: askTodoTitle };
