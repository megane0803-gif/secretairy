// 画面から /api/ai/todo を呼ぶ（メモを投げる・ホームの「AI の仕事」のメモ）。
// つながらない・JSON でない → no-ai / 混んでいる（429）→ busy / 理由の文が無い失敗 → message が ""（画面は failText で決まった1文に）。

import { answerOf, postAi } from "../ai/busy";
import type { TodoRequest, TodoResponse } from "./wire";

export async function askTodoTitle(body: TodoRequest): Promise<TodoResponse> {
  return answerOf<TodoResponse>(await postAi("/api/ai/todo", body));
}
