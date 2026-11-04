// メモを投げる：画面とサーバー（/api/ai/todo）のあいだの形。
// サーバーは受け取った物を残さない。直したタスクの文を返すだけ（足すのは画面）。
// お客様の名字は画面で〔お客様〕に置きかえてから送る（名前は AI に送らない）。

import { readRules } from "../ai/request";
import type { Rule } from "../rules/types";

/** ai = Claude（Haiku）に聞く / script = 決まった返事（AI なし） */
export type TodoMode = "ai" | "script";

export type TodoRequest = {
  mode: TodoMode;
  /** 投げたメモ（100字まで。config/ai.json の todo.maxMemoChars。お客様の名字は〔お客様〕に置きかえ済み） */
  memo: string;
  /** そのブラウザのルール（鍵つきはサーバーで先頭に足しなおす） */
  rules: Rule[];
};

/** via = だれが文を決めたか（ai = Claude / program = 決まった返事、または門で止めたのでメモから作った） */
export type TodoTitle = { mode: TodoMode; title: string; via: "ai" | "program"; note?: string };

export type TodoResponse = ({ ok: true } & TodoTitle) | { ok: false; code: "no-ai" | "bad-request" | "refused"; message: string };

type Parsed = { ok: true; value: TodoRequest } | { ok: false; reason: string };

export function parseTodoRequest(body: unknown, maxMemoChars: number, menuIds: string[]): Parsed {
  if (!body || typeof body !== "object") return { ok: false, reason: "形がおかしいです" };
  const b = body as Record<string, unknown>;
  const mode: TodoMode = b.mode === "script" ? "script" : "ai";
  if (typeof b.memo !== "string" || !b.memo.trim()) return { ok: false, reason: "メモがありません" };
  const memo = b.memo.replace(/\s+/g, " ").trim();
  if ([...memo].length > maxMemoChars) return { ok: false, reason: `メモは${maxMemoChars}字までです` };
  const rules = readRules(b.rules ?? [], menuIds);
  if (!rules) return { ok: false, reason: "ルールの形がおかしいです" };
  return { ok: true, value: { mode, memo, rules } };
}
