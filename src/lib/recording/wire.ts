// 録音の要点づくりの、画面とサーバー（/api/ai/recording）のあいだの形。
// 送るのは1つの区切りの文字だけ（声は送らない。お客様の名字は画面で〔お客様〕に置きかえてから送る）。
// サーバーは受け取った物を残さない。

import { readRules } from "../ai/request";
import type { KarteMode } from "../karte/wire";
import type { Rule } from "../rules/types";
import type { NoteRemoved } from "./notes";

export type NotesRequest = {
  mode: KarteMode;
  /** 1つの区切りの文字（名字は〔お客様〕に置きかえた物） */
  text: string;
  rules: Rule[];
};

export type NotesResult = {
  mode: KarteMode;
  /** 言葉の門を通った要点 */
  notes: string[];
  /** 言葉の門で外した要点 */
  removed: NoteRemoved[];
  /** 長さの上限で途中まで */
  cut: boolean;
};

export type NotesResponse = ({ ok: true } & NotesResult) | { ok: false; code: "no-ai" | "bad-request" | "refused"; message: string };

type Parsed = { ok: true; value: NotesRequest } | { ok: false; reason: string };

/** 画面から来た頼みを確かめる。文字は maxTextChars を超えたら受けない */
export function parseNotesRequest(body: unknown, maxTextChars: number, menuIds: string[]): Parsed {
  if (!body || typeof body !== "object") return { ok: false, reason: "形がおかしいです" };
  const b = body as Record<string, unknown>;
  const mode: KarteMode = b.mode === "script" ? "script" : "ai";
  if (typeof b.text !== "string" || !b.text.trim()) return { ok: false, reason: "文字がありません" };
  const text = b.text.trim();
  if ([...text].length > maxTextChars) return { ok: false, reason: `1つの区切りの文字は${maxTextChars}字までです` };
  const rules = readRules(b.rules, menuIds);
  if (!rules) return { ok: false, reason: "ルールの形がおかしいです" };
  return { ok: true, value: { mode, text, rules } };
}

/** 送る前に、文字を上限の字数までにする（超えた分は送らない） */
export function clipText(text: string, maxTextChars: number): string {
  const chars = [...text];
  return chars.length > maxTextChars ? chars.slice(0, maxTextChars).join("") : text;
}
