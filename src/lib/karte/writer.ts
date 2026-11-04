// カルテの下書きを書く物（Claude か、決まった返事か）。流れ（run.ts）はどちらでも同じ。
// テストでは Claude を呼ばず、決まった返事（scriptKarteWriter）に置きかえる。

import Anthropic from "@anthropic-ai/sdk";
import { NoAiError } from "../ai/model";
import type { KarteExample } from "../data/types";
import type { KarteHeading } from "../settings";
import { emptySections, formatKarte, MAX_LINE_CHARS } from "./format";
import { karteUserText } from "./prompt";

export type KarteWriteRequest = {
  system: string;
  memo: string;
  /** 1回の返事の長さの上限（トークン。config/ai.json の karte.maxReplyTokens） */
  maxTokens: number;
};

/** end = 書き終えた / max_tokens = 長さの上限で切れた / refusal = 安全のために断られた */
export type KarteWriteResult = { text: string; stop: "end" | "max_tokens" | "refusal" };

export interface KarteWriter {
  write(req: KarteWriteRequest): Promise<KarteWriteResult>;
}

/** Claude（Haiku）で書く。サーバーの側だけで使う（鍵は .env.local の ANTHROPIC_API_KEY） */
export function claudeKarteWriter(model: string, apiKey: string | undefined = process.env.ANTHROPIC_API_KEY): KarteWriter {
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
          messages: [{ role: "user", content: karteUserText(req.memo) }],
          // 分けるだけなので考える深さは浅く（速く・短く）
          output_config: { effort: "low" },
        });
      } catch (e) {
        // 鍵・クレジット・止まっている・つながらない、など。画面には「今は AI につながりません」と出す
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

/** 同じメモか（空白・全角半角の違いは見ない） */
function sameMemo(a: string, b: string): boolean {
  const n = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");
  return n(a) === n(b);
}

const FILLER = /^(えーと|えっと|ええと|あと|それと|それから|で)[、,\s]*/;

/**
 * 決まった返事（AI なし）。
 * - 例文のメモ：例文に付けた決まった下書き（seed/karte-examples.json の scripted）をそのまま返す。
 * - ほかのメモ：文ごとに、見出しの手がかりの言葉（config/karte.json の hints）で見出しに分ける。どれにも当たらない文は会話メモ（いちばん最後の見出し）へ。
 */
export function scriptKarteWriter(examples: KarteExample[], headings: KarteHeading[]): KarteWriter {
  return {
    async write(req) {
      const ex = examples.find((e) => sameMemo(e.memo, req.memo));
      if (ex) return { text: ex.scripted, stop: "end" };
      const sections = emptySections(headings);
      const fallback = headings[headings.length - 1];
      for (const raw of req.memo.split(/[。！？!?\n]+/)) {
        const s = raw.trim().replace(FILLER, "").trim();
        if (!s) continue;
        const h = headings.find((x) => (x.hints ?? []).some((w) => s.includes(w))) ?? fallback;
        if (h) sections[h.id].push(s.slice(0, MAX_LINE_CHARS));
      }
      return { text: formatKarte(sections, headings), stop: "end" };
    },
  };
}
