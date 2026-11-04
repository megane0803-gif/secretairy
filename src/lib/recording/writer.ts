// 録音の要点を書く物（Claude か、決まった返事か）。流れ（run.ts）はどちらでも同じ。
// テストでは Claude を呼ばず、決まった返事（scriptNotesWriter）に置きかえる。

import Anthropic from "@anthropic-ai/sdk";
import { NoAiError } from "../ai/model";
import type { KarteHeading } from "../settings";
import { notesUserText } from "./prompt";

export type NotesWriteRequest = { system: string; text: string; maxTokens: number };
export type NotesWriteResult = { text: string; stop: "end" | "max_tokens" | "refusal" };

export interface NotesWriter {
  write(req: NotesWriteRequest): Promise<NotesWriteResult>;
}

/** Claude（Haiku）で書く。サーバーの側だけで使う（鍵は .env.local の ANTHROPIC_API_KEY） */
export function claudeNotesWriter(model: string, apiKey: string | undefined = process.env.ANTHROPIC_API_KEY): NotesWriter {
  if (!apiKey) throw new NoAiError("ANTHROPIC_API_KEY がありません");
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 45_000 });
  return {
    async write(req) {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: "user", content: notesUserText(req.text) }],
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

const FILLER = /^(えーと|えっと|ええと|あのー?|あと|それと|それから|で|うん|はい)[、,\s]*/;

/**
 * 決まった返事（AI なし）。文ごとに、カルテの見出しの手がかりの言葉（config/karte.json の hints）が入った文だけを拾う。
 * どれにも当たらない文（雑談）は捨てる。
 */
export function scriptNotesWriter(headings: KarteHeading[]): NotesWriter {
  const hints = headings.flatMap((h) => h.hints ?? []);
  return {
    async write(req) {
      const lines: string[] = [];
      for (const raw of req.text.split(/[。！？!?\n]+/)) {
        const s = raw.trim().replace(FILLER, "").trim();
        if (s && hints.some((w) => s.includes(w))) lines.push(`・${s}`);
      }
      return { text: lines.length ? lines.join("\n") : "・なし", stop: "end" };
    },
  };
}
