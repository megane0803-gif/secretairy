// 録音の要点づくりの流れ：1つの区切りの文字 → 書く物（Claude か決まった返事）→ 「・」の行に分ける → 言葉の門（その区切りの文字と照らす）。
// サーバーの窓口（/api/ai/recording）とテストが同じここを使う。受け取った物はどこにも残さない。

import type { Rule } from "../rules/types";
import type { KarteHeading } from "../settings";
import type { KarteMode } from "../karte/wire";
import { gateNotes, parseNotes } from "./notes";
import { notesSystem } from "./prompt";
import type { NotesResult } from "./wire";
import type { NotesWriter } from "./writer";

export class NotesRefusedError extends Error {}

export type RunNotesOptions = {
  text: string;
  mode: KarteMode;
  writer: NotesWriter;
  headings: KarteHeading[];
  rules: Rule[];
  maxTokens: number;
  maxNotes: number;
  maxNoteChars: number;
  menuName?: (id: string) => string;
};

export async function runNotes(o: RunNotesOptions): Promise<NotesResult> {
  const out = await o.writer.write({ system: notesSystem(o.headings, o.rules, o.maxNotes, o.maxNoteChars, o.menuName), text: o.text, maxTokens: o.maxTokens });
  if (out.stop === "refusal") throw new NotesRefusedError("断られました");
  let text = out.text;
  const cut = out.stop === "max_tokens";
  if (cut) text = text.split(/\r?\n/).slice(0, -1).join("\n");
  const gated = gateNotes(parseNotes(text, o.maxNotes, o.maxNoteChars), o.text);
  return { mode: o.mode, notes: gated.notes, removed: gated.removed, cut };
}
