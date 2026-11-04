// 画面から /api/ai/ads を呼ぶ。つながらない・サーバーがうまくいかない時は「今は AI につながりません」として返す。

import { NO_AI_MESSAGE } from "../ai/wire";
import type { AdsRequest, AdsResponse } from "./wire";

export async function askAdsReview(body: AdsRequest): Promise<AdsResponse> {
  try {
    const res = await fetch("/api/ai/ads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data: AdsResponse | null = null;
    try {
      data = (await res.json()) as AdsResponse;
    } catch {
      data = null;
    }
    if (data && typeof data === "object" && "ok" in data) return data;
    return { ok: false, code: "no-ai", message: NO_AI_MESSAGE };
  } catch {
    return { ok: false, code: "no-ai", message: NO_AI_MESSAGE };
  }
}
