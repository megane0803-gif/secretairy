// LINE の一言の振り分けを Claude（config/ai.json の line。Haiku）で。サーバーの側だけで使う（鍵は ANTHROPIC_API_KEY）。
// 道具を必ず1つだけ呼ばせる（tool_choice: any・disable_parallel_tool_use）。返事の長さは maxReplyTokens まで。

import Anthropic from "@anthropic-ai/sdk";
import { NoAiError } from "../ai/model";
import { SORT_TOOLS, type SortModel } from "./sort";

export function claudeSortModel(model: string, apiKey: string | undefined = process.env.ANTHROPIC_API_KEY): SortModel {
  if (!apiKey) throw new NoAiError("ANTHROPIC_API_KEY がありません");
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 30_000 });
  return {
    async pick(req) {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: "user", content: `# オーナーの一言\n${req.text}` }],
          tools: SORT_TOOLS.map((t) => ({ ...t, strict: true })),
          tool_choice: { type: "any", disable_parallel_tool_use: true },
        });
      } catch (e) {
        if (e instanceof Anthropic.APIError) throw new NoAiError(`${e.status ?? ""} ${e.message}`.trim());
        throw new NoAiError(e instanceof Error ? e.message : String(e));
      }
      if (message.stop_reason === "refusal" || message.stop_reason === "max_tokens") return null;
      const use = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      return use ? { name: use.name, input: use.input } : null;
    },
  };
}
