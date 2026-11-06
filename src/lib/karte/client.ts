// 画面から /api/ai/karte を呼ぶ（カルテの「カルテにする」）。お客様の名前は送らない（送る中身は KarteMemo.tsx が作る）。
// つながらない・JSON でない → no-ai / 混んでいる（429）→ busy / 理由の文が無い失敗 → message が ""（画面は failText で決まった1文に）。

import { answerOf, postAi } from "../ai/busy";
import type { KarteRequest, KarteResponse } from "./wire";

export async function askKarte(body: KarteRequest): Promise<KarteResponse> {
  return answerOf<KarteResponse>(await postAi("/api/ai/karte", body));
}
