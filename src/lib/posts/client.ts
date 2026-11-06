// 画面から /api/ai/posts を呼ぶ。つながらない・サーバーがうまくいかない時は「今は AI につながりません」として返す。
// 窓口が混んでいる時（429）は code: "busy"（ai/busy.ts。「今は AI につながりません」とは分ける）。理由の文が無い失敗は message が ""。

import { answerOf, postAi } from "../ai/busy";
import type { PostsRequest, PostsResponse } from "./wire";

export async function askPostDraft(body: PostsRequest): Promise<PostsResponse> {
  return answerOf<PostsResponse>(await postAi("/api/ai/posts", body));
}
