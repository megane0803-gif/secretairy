// 画面から /api/ai/ads を呼ぶ。つながらない・サーバーがうまくいかない時は「今は AI につながりません」として返す。
// 窓口が混んでいる時（429）は code: "busy"（ai/busy.ts）。理由の文が無い失敗は message が ""（画面は failText で決まった1文に）。

import { answerOf, postAi } from "../ai/busy";
import type { AdsRequest, AdsResponse } from "./wire";

export async function askAdsReview(body: AdsRequest): Promise<AdsResponse> {
  return answerOf<AdsResponse>(await postAi("/api/ai/ads", body));
}
