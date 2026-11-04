// 「AI の一言」を書く物（Claude か、決まった返事か）。流れ（run.ts）はどちらでも同じ。
// テストでは Claude を呼ばず、決まった返事（scriptBriefWriter）に置きかえる。

import Anthropic from "@anthropic-ai/sdk";
import { NoAiError } from "../ai/model";
import { briefUserText } from "./prompt";
import type { BriefItem } from "./wire";

export type BriefWriteRequest = { system: string; items: BriefItem[]; maxTokens: number };

/** end = 書き終えた / max_tokens = 長さの上限で切れた / refusal = 安全のために断られた */
export type BriefWriteResult = { text: string; stop: "end" | "max_tokens" | "refusal" };

export interface BriefWriter {
  write(req: BriefWriteRequest): Promise<BriefWriteResult>;
}

/** Claude（Haiku）で書く。サーバーの側だけで使う（鍵は .env.local の ANTHROPIC_API_KEY） */
export function claudeBriefWriter(model: string, apiKey: string | undefined = process.env.ANTHROPIC_API_KEY): BriefWriter {
  if (!apiKey) throw new NoAiError("ANTHROPIC_API_KEY がありません");
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 20_000 });
  return {
    async write(req) {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: "user", content: briefUserText(req.items) }],
          // 短い数行なので考える深さは浅く（速く・短く）
          output_config: { effort: "low" },
        });
      } catch (e) {
        if (e instanceof Anthropic.APIError) throw new NoAiError(`${e.status ?? ""} ${e.message}`.trim());
        throw new NoAiError(e instanceof Error ? e.message : String(e));
      }
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const stop = message.stop_reason === "refusal" ? "refusal" : message.stop_reason === "max_tokens" ? "max_tokens" : "end";
      return { text, stop };
    },
  };
}

/**
 * 決まった返事（AI なし）：材料の文の手がかりだけで、決まった形の行を作る。
 * 初めての方の予約・仮押さえの予約・前回の注意点がある予約・承認待ち・お客様への連絡の ToDo の順。
 */
export function scriptBriefWriter(): BriefWriter {
  return {
    async write(req) {
      const out: string[] = [];
      for (const i of req.items) {
        if (i.kind === "reservation" && i.text.includes("初めての方")) out.push(`・${i.mark}は初めての方です。ご希望をゆっくり聞く`);
        if (i.kind === "reservation" && i.text.includes("仮押さえ")) out.push(`・${i.mark}はまだ仮押さえです。承認の箱で見る`);
        if (i.kind === "reservation" && i.text.includes("前回の注意点")) out.push(`・${i.mark}は前回の注意点・申し送りを見てから始める`);
      }
      if (req.items.some((i) => i.kind === "approval")) out.push(`・${req.items.find((i) => i.kind === "approval")!.mark}は承認待ちです。見て押す`);
      const contact = req.items.find((i) => i.kind === "todo" && i.text.includes("今日中"));
      if (contact) out.push(`・${contact.mark}はお客様への連絡です。今日のうちに`);
      return { text: out.length ? out.join("\n") : "・特にありません", stop: "end" };
    },
  };
}
