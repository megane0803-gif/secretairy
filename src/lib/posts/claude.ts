// 発信の下書きを Claude（Anthropic の API）で作る。サーバーの側だけで使う（鍵は .env.local の ANTHROPIC_API_KEY）。
// 1回の返事の長さは max_tokens で上限を付ける（config/ai.json の posts.maxReplyTokens）。道具は渡さない（文を書くだけ）。

import Anthropic from "@anthropic-ai/sdk";
import { NoAiError } from "../ai/model";
import type { PostsModel, PostsModelRequest, PostsTurn } from "./model";

export function claudePostsModel(model: string, apiKey: string | undefined = process.env.ANTHROPIC_API_KEY): PostsModel {
  if (!apiKey) throw new NoAiError("ANTHROPIC_API_KEY がありません");
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 50_000 });

  return {
    async turn(req: PostsModelRequest): Promise<PostsTurn> {
      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await client.beta.messages.create({
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: req.messages,
          // 短い文を1つ書くだけなので、考える深さは浅く
          output_config: { effort: "low" },
          // 安全のために断られたとき、別のモデルで答えなおす（サーバーの側で）
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        });
      } catch (e) {
        // 鍵・クレジット・止まっている・つながらない、など。画面には「今は AI につながりません」と出す
        if (e instanceof Anthropic.APIError) throw new NoAiError(`${e.status ?? ""} ${e.message}`.trim());
        throw new NoAiError(e instanceof Error ? e.message : String(e));
      }
      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      const stop = message.stop_reason === "refusal" ? "refusal" : message.stop_reason === "max_tokens" ? "max_tokens" : "end";
      return { text, stop };
    },
  };
}
