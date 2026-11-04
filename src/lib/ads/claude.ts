// 広告の見直しの案を Claude（Anthropic の API）で作る。サーバーの側だけで使う（鍵は .env.local の ANTHROPIC_API_KEY）。
// 1回の返事の長さは max_tokens で上限を付ける（config/ai.json の ads.maxReplyTokens）。
// 道具は「止める」「外す」の2つだけ。1回に1つだけ呼ばせる（disable_parallel_tool_use）。

import Anthropic from "@anthropic-ai/sdk";
import { NoAiError, type ToolCall } from "../ai/model";
import type { AdsModel, AdsModelRequest, AdsTurn } from "./model";

export function claudeAdsModel(model: string, apiKey: string | undefined = process.env.ANTHROPIC_API_KEY): AdsModel {
  if (!apiKey) throw new NoAiError("ANTHROPIC_API_KEY がありません");
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 45_000 });

  return {
    async turn(req: AdsModelRequest): Promise<AdsTurn> {
      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await client.beta.messages.create({
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: req.messages,
          // 表を見て1つ選ぶだけなので、考える深さは浅く
          output_config: { effort: "low" },
          // 道具の形（番号と理由だけ）をくずさない
          tools: req.tools.map((t) => ({ ...t, strict: true })),
          tool_choice: { type: "auto", disable_parallel_tool_use: true },
          // 安全のために断られたとき、別のモデルで答えなおす（サーバーの側で）
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        });
      } catch (e) {
        // 鍵・クレジット・止まっている・つながらない、など。画面には「今は AI につながりません」と出す
        if (e instanceof Anthropic.APIError) throw new NoAiError(`${e.status ?? ""} ${e.message}`.trim());
        throw new NoAiError(e instanceof Error ? e.message : String(e));
      }

      const toolCalls: ToolCall[] = message.content
        .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));
      const stop =
        message.stop_reason === "refusal"
          ? "refusal"
          : message.stop_reason === "max_tokens"
            ? "max_tokens"
            : toolCalls.length > 0
              ? "tool"
              : "end";
      // 長さの上限で切れた道具の呼び出しは使わない（中身が途中で切れているかもしれない）
      return {
        assistant: message.content as Anthropic.Beta.BetaContentBlockParam[],
        toolCalls: stop === "max_tokens" ? [] : toolCalls,
        stop,
      };
    },
  };
}
