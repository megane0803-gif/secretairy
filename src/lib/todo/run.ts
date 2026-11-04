// メモを投げる流れ：メモ → 書く物（Claude か決まった返事）→ 門（プログラム）→ ToDo の文。
// サーバーの窓口（/api/ai/todo）とテストが同じここを使う。受け取った物はどこにも残さない。
// 門：1行・長さの上限・メモに無い体や判断の言葉と数字（カルテの言葉の門と同じ gateLine）。通らなければ、プログラムがメモから作る。

import { gateLine } from "../karte/gate";
import type { Rule } from "../rules/types";
import { todoSystem } from "./prompt";
import type { TodoMode, TodoTitle } from "./wire";
import { programTitle, type TodoWriter } from "./writer";

export type RunTodoOptions = {
  memo: string;
  mode: TodoMode;
  writer: TodoWriter;
  rules: Rule[];
  maxTokens: number;
  maxTitleChars: number;
};

export class TodoRefusedError extends Error {}

/** 返ってきた文を1行にそろえる（前の記号・かぎかっこ・「ToDo：」を外す） */
export function cleanTitle(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? "";
  return line
    .replace(/^(ToDo|TODO|タスク|やること)\s*[:：]\s*/i, "")
    .replace(/^[・\-*•●○◯\d.)）\s]+/, "")
    .replace(/^[「『"']+|[」』"']+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** AI の文を使ってよいか。使えないときは理由（1文） */
export function gateTitle(title: string, memo: string, maxTitleChars: number): string | null {
  if (!title) return "文が空でした";
  if ([...title].length > maxTitleChars) return `${maxTitleChars}字より長い文でした`;
  return gateLine(title, memo);
}

export async function runTodo(o: RunTodoOptions): Promise<TodoTitle> {
  const out = await o.writer.write({ system: todoSystem(o.rules, o.maxTitleChars), memo: o.memo, maxTokens: o.maxTokens, maxTitleChars: o.maxTitleChars });
  if (out.stop === "refusal") throw new TodoRefusedError("断られました");
  const fallback = (note: string): TodoTitle => ({ mode: o.mode, title: programTitle(o.memo, o.maxTitleChars), via: "program", note });
  if (o.mode === "script") return { mode: "script", title: cleanTitle(out.text) || programTitle(o.memo, o.maxTitleChars), via: "program" };
  if (out.stop === "max_tokens") return fallback("AI の文が長さの上限で切れたので、メモから作りました");
  const title = cleanTitle(out.text);
  const why = gateTitle(title, o.memo, o.maxTitleChars);
  if (why) return fallback(`AI の文を使いませんでした（${why}）。メモから作りました`);
  return { mode: "ai", title, via: "ai" };
}
