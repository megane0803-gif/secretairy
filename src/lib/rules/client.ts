// 画面から /api/ai/rules を呼ぶ（ルールを言葉で書いて欄を埋める）。
// つながらない・JSON でない → no-ai / 混んでいる（429）→ busy / 理由の文が無い失敗 → message が ""（画面は failText で決まった1文に）。

import { answerOf, postAi } from "../ai/busy";
import type { RuleWordsRequest, RuleWordsResponse } from "./words";

export async function askRuleWords(body: RuleWordsRequest): Promise<RuleWordsResponse> {
  return answerOf<RuleWordsResponse>(await postAi("/api/ai/rules", body));
}
