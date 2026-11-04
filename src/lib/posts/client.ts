// 画面から /api/ai/posts を呼ぶ。つながらない・サーバーがうまくいかない時は「今は AI につながりません」として返す。

import { NO_AI_MESSAGE } from "../ai/wire";
import type { PostsRequest, PostsResponse } from "./wire";

export async function askPostDraft(body: PostsRequest): Promise<PostsResponse> {
  try {
    const res = await fetch("/api/ai/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let data: PostsResponse | null = null;
    try {
      data = (await res.json()) as PostsResponse;
    } catch {
      data = null;
    }
    if (data && typeof data === "object" && "ok" in data) return data;
    return { ok: false, code: "no-ai", message: NO_AI_MESSAGE };
  } catch {
    return { ok: false, code: "no-ai", message: NO_AI_MESSAGE };
  }
}
