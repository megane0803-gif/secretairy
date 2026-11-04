// Claude（Anthropic の API）で返事を作る。サーバーの側だけで使う（鍵は .env.local の ANTHROPIC_API_KEY）。
// 文は少しずつ流す。1回の返事の長さは max_tokens で上限を付ける。

import Anthropic from "@anthropic-ai/sdk";
import { NoAiError, type ModelRequest, type ModelTurn, type ReplyModel, type ToolCall } from "./model";

export function claudeModel(model: string, apiKey: string | undefined = process.env.ANTHROPIC_API_KEY): ReplyModel {
  if (!apiKey) throw new NoAiError("ANTHROPIC_API_KEY がありません");
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 45_000 });

  return {
    async turn(req: ModelRequest, onText): Promise<ModelTurn> {
      let message: Anthropic.Beta.BetaMessage;
      try {
        const stream = client.beta.messages.stream({
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: req.messages,
          // おしゃべりなので考える深さは浅く（返事を速く・短く）
          output_config: { effort: "low" },
          tools: req.tools.map((t) => ({ ...t, eager_input_streaming: true })),
          // 安全のために断られたとき、別のモデルで答えなおす（サーバーの側で）
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        });
        stream.on("text", (d) => onText(d));
        message = await stream.finalMessage();
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
      if (stop === "max_tokens") return { assistant: message.content as Anthropic.Beta.BetaContentBlockParam[], toolCalls: [], stop };
      return { assistant: message.content as Anthropic.Beta.BetaContentBlockParam[], toolCalls, stop };
    },
  };
}
