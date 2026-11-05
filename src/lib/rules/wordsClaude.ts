// ルールの文を Claude（config/ai.json の ruleWords。Haiku）で読む。サーバーの側だけで使う（鍵は .env.local の ANTHROPIC_API_KEY）。
// 返させるのは足す欄に当てはめた「読み」の JSON だけ（structured outputs）。道具は渡さない（保存も確定もできない）。

import Anthropic from "@anthropic-ai/sdk";
import { NoAiError } from "../ai/model";
import { parseReading, READING_SCHEMA, ruleWordsUserText, type RuleReader } from "./words";

export function claudeRuleReader(model: string, apiKey: string | undefined = process.env.ANTHROPIC_API_KEY): RuleReader {
  if (!apiKey) throw new NoAiError("ANTHROPIC_API_KEY がありません");
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 20_000 });
  return {
    async read(req) {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: "user", content: ruleWordsUserText(req.text) }],
          // 欄に当てはめるだけなので考える深さは浅く。形は JSON Schema で決める
          output_config: { effort: "low", format: { type: "json_schema", schema: READING_SCHEMA as unknown as Record<string, unknown> } },
        });
      } catch (e) {
        // 鍵・クレジット・止まっている・つながらない、など。画面では言葉の欄を出さなくする
        if (e instanceof Anthropic.APIError) throw new NoAiError(`${e.status ?? ""} ${e.message}`.trim());
        throw new NoAiError(e instanceof Error ? e.message : String(e));
      }
      if (message.stop_reason === "refusal") return { reading: null, stop: "refusal" };
      if (message.stop_reason === "max_tokens") return { reading: null, stop: "max_tokens" };
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      let raw: unknown = null;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = null;
      }
      return { reading: parseReading(raw), stop: "end" };
    },
  };
}
