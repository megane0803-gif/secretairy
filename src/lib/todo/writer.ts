// メモを ToDo の文に直す物（Claude か、決まった返事か）。流れ（run.ts）はどちらでも同じ。
// テストでは Claude を呼ばず、決まった返事（scriptTodoWriter）に置きかえる。

import Anthropic from "@anthropic-ai/sdk";
import { NoAiError } from "../ai/model";
import { todoUserText } from "./prompt";

export type TodoWriteRequest = {
  system: string;
  memo: string;
  /** 1回の返事の長さの上限（トークン。config/ai.json の todo.maxReplyTokens） */
  maxTokens: number;
  /** タスクの文の長さの上限（字） */
  maxTitleChars: number;
};

/** end = 書き終えた / max_tokens = 長さの上限で切れた / refusal = 安全のために断られた */
export type TodoWriteResult = { text: string; stop: "end" | "max_tokens" | "refusal" };

export interface TodoWriter {
  write(req: TodoWriteRequest): Promise<TodoWriteResult>;
}

/** Claude（Haiku）で直す。サーバーの側だけで使う（鍵は .env.local の ANTHROPIC_API_KEY） */
export function claudeTodoWriter(model: string, apiKey: string | undefined = process.env.ANTHROPIC_API_KEY): TodoWriter {
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
          messages: [{ role: "user", content: todoUserText(req.memo) }],
          // 短い1行に直すだけなので考える深さは浅く（速く・短く）
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

const FILLER = /^(えーと|えっと|ええと|あのー?|あと|それと|それから|そうだ|で)[、,\s]*/;
const TAIL = /[、,\s]*(かな|かも|ね|よ|な|なあ|なー|っと)$/;

/**
 * プログラムが作る ToDo の文：メモの最初の文から、「えーと」などと終わりの「かな」「ね」を外し、長さの上限で切る。
 * 決まった返事（AI なし）と、AI の文が門で止まった時に使う（メモの言葉だけで作るので、足した言葉は無い）。
 */
export function programTitle(memo: string, maxTitleChars: number): string {
  const first = memo
    .split(/[。！？!?\n]+/)
    .map((s) => s.trim())
    .find((s) => s.length > 0) ?? memo.trim();
  let s = first.replace(/\s+/g, " ");
  for (let i = 0; i < 3; i++) s = s.replace(FILLER, "").trim();
  s = s.replace(TAIL, "").trim() || first;
  const chars = [...s];
  return chars.length > maxTitleChars ? `${chars.slice(0, maxTitleChars - 1).join("")}…` : s;
}

/** 決まった返事（AI なし）：programTitle と同じ文を返す */
export function scriptTodoWriter(): TodoWriter {
  return {
    async write(req) {
      return { text: programTitle(req.memo, req.maxTitleChars), stop: "end" };
    },
  };
}
