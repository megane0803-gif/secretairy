// 「AI の一言」の流れ：材料 → 書く物（Claude か決まった返事）→ 門（プログラム）→ 一言（印のまま）。
// サーバーの窓口（/api/ai/brief）とテストが同じここを使う。受け取った物はどこにも残さない。

import type { Rule } from "../rules/types";
import { gateBrief } from "./gate";
import { briefSystem } from "./prompt";
import type { BriefItem, BriefMode, BriefResult } from "./wire";
import type { BriefWriter } from "./writer";

export type RunBriefOptions = {
  items: BriefItem[];
  mode: BriefMode;
  writer: BriefWriter;
  rules: Rule[];
  maxTokens: number;
  maxNotes: number;
  maxNoteChars: number;
};

export class BriefRefusedError extends Error {}

export async function runBrief(o: RunBriefOptions): Promise<BriefResult> {
  const out = await o.writer.write({ system: briefSystem(o.rules, o.maxNotes, o.maxNoteChars), items: o.items, maxTokens: o.maxTokens });
  if (out.stop === "refusal") throw new BriefRefusedError("断られました");
  let text = out.text;
  // 長さの上限で切れたときは、最後の1行（途中で切れているかもしれない）を使わない
  if (out.stop === "max_tokens") text = text.split(/\r?\n/).slice(0, -1).join("\n");
  const { notes, dropped } = gateBrief(text, o.items, o.maxNotes, o.maxNoteChars);
  return { mode: o.mode, notes, dropped };
}
