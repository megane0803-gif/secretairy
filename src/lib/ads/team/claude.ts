// 会議の役（分身・野党・補佐）を Claude（config/ai.json の adsTeam）で答えさせる。サーバーの側だけで使う（鍵は .env.local の ANTHROPIC_API_KEY）。
// 返させるのは JSON だけ（structured outputs）。道具は渡さない（確定も承認もできない）。1回の呼び出しは1つの役だけ。
// Claude を呼ぶ薄い所だけ。発信のチーム（src/lib/posts/team/）も同じ物を使う（指示・流れ・門はそれぞれが持つ）。

import Anthropic from "@anthropic-ai/sdk";
import { NoAiError } from "../../ai/model";

/** 1つの役に答えさせる時に Claude が読む物（指示・材料・返させる JSON の形・返事の長さ）だけ */
export type TeamJsonRequest = { system: string; user: string; schema: Record<string, unknown>; maxTokens: number };
export type TeamJsonResult = { raw: unknown; stop: "end" | "max_tokens" | "refusal" };

/** 本物の Claude で役に答えさせる物。広告のチームの TeamWriter にも、発信のチームの PostTeamWriter にも合う形 */
export type ClaudeJsonWriter = { readonly claude: true; write(req: TeamJsonRequest): Promise<TeamJsonResult> };

export function claudeTeamWriter(model: string, apiKey: string | undefined = process.env.ANTHROPIC_API_KEY): ClaudeJsonWriter {
  if (!apiKey) throw new NoAiError("ANTHROPIC_API_KEY がありません");
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 25_000 });
  return {
    claude: true,
    async write(req) {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          // 短い文を決まった形で返すだけなので、考える深さは浅く。形は JSON Schema で決める
          output_config: { effort: "low", format: { type: "json_schema", schema: req.schema } },
        });
      } catch (e) {
        // 鍵・クレジット・止まっている・つながらない、など。窓口は決まった返事（AI なし）に切りかえる
        if (e instanceof Anthropic.APIError) throw new NoAiError(`${e.status ?? ""} ${e.message}`.trim());
        throw new NoAiError(e instanceof Error ? e.message : String(e));
      }
      if (message.stop_reason === "refusal") return { raw: null, stop: "refusal" };
      if (message.stop_reason === "max_tokens") return { raw: null, stop: "max_tokens" };
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
      // 形と言葉は run.ts の門が確かめる
      return { raw, stop: "end" };
    },
  };
}
