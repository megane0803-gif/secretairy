// 画面から来たカルテの頼みを確かめる。メモは長さの上限まで、ルールは鍵つきを先頭に足しなおす。

import { readRules } from "../ai/request";
import type { Rule } from "../rules/types";
import type { KarteMode } from "./wire";

type Parsed = { ok: true; value: { mode: KarteMode; memo: string; rules: Rule[]; source?: "recording" } } | { ok: false; reason: string };

/** maxRecordingMemoChars があれば、録音から作ったメモ（source = recording）の時だけ、その字数まで受ける */
export function parseKarteRequest(body: unknown, maxMemoChars: number, menuIds: string[], maxRecordingMemoChars?: number): Parsed {
  if (!body || typeof body !== "object") return { ok: false, reason: "形がおかしいです" };
  const b = body as Record<string, unknown>;
  const mode: KarteMode = b.mode === "script" ? "script" : "ai";
  if (typeof b.memo !== "string" || !b.memo.trim()) return { ok: false, reason: "施術のメモがありません" };
  const memo = b.memo.trim();
  const recording = b.source === "recording" && typeof maxRecordingMemoChars === "number";
  const limit = recording ? Math.max(maxMemoChars, maxRecordingMemoChars) : maxMemoChars;
  if ([...memo].length > limit) return { ok: false, reason: `${recording ? "録音から作ったメモ" : "施術のメモ"}は${limit}字までです` };
  const rules = readRules(b.rules, menuIds);
  if (!rules) return { ok: false, reason: "ルールの形がおかしいです" };
  return { ok: true, value: recording ? { mode, memo, rules, source: "recording" } : { mode, memo, rules } };
}
