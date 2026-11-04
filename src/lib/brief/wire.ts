// 朝の要点の「AI の一言」：画面とサーバー（/api/ai/brief）のあいだの形。
// 画面が今日の予約・承認待ち・ToDo を「印（【予約1】など）＋名前と日時を抜いた文」にして送る。
// サーバーは受け取った物を残さない。Claude が書いた一言（印のまま）を、門を通して返すだけ。
// 印を日時・お名前に置きかえるのは画面のプログラム（items.ts の fillMarks）。

import { readRules } from "../ai/request";
import type { Rule } from "../rules/types";

/** ai = Claude（Haiku）に聞く / script = 決まった返事（AI なし。テストで使う） */
export type BriefMode = "ai" | "script";

export type BriefKind = "reservation" | "approval" | "todo";

/** 材料の1つ。mark は【予約1】のような印、text は名前を〔お客様〕にした文 */
export type BriefItem = { mark: string; kind: BriefKind; text: string };

export type BriefRequest = { mode: BriefMode; items: BriefItem[]; rules: Rule[] };

export type BriefDropped = { line: string; reason: string };

export type BriefResult = { mode: BriefMode; notes: string[]; dropped: BriefDropped[] };

export type BriefResponse = ({ ok: true } & BriefResult) | { ok: false; code: "no-ai" | "bad-request" | "refused"; message: string };

/** 印の形：【予約1】【承認1】【ToDo1】 */
export const MARK_RE = /【(予約|承認|ToDo)(\d{1,2})】/g;
const MARK_ONE = /^【(予約|承認|ToDo)\d{1,2}】$/;
const KIND_OF: Record<string, BriefKind> = { 予約: "reservation", 承認: "approval", ToDo: "todo" };

export function markFor(kind: BriefKind, n: number): string {
  return `【${kind === "reservation" ? "予約" : kind === "approval" ? "承認" : "ToDo"}${n}】`;
}

type Parsed = { ok: true; value: BriefRequest } | { ok: false; reason: string };

export function parseBriefRequest(body: unknown, limits: { maxItems: number; maxItemChars: number }, menuIds: string[]): Parsed {
  if (!body || typeof body !== "object") return { ok: false, reason: "形がおかしいです" };
  const b = body as Record<string, unknown>;
  const mode: BriefMode = b.mode === "script" ? "script" : "ai";
  if (!Array.isArray(b.items)) return { ok: false, reason: "材料がありません" };
  if (b.items.length > limits.maxItems) return { ok: false, reason: `材料は${limits.maxItems}個までです` };
  const items: BriefItem[] = [];
  const seen = new Set<string>();
  for (const x of b.items) {
    if (!x || typeof x !== "object") return { ok: false, reason: "材料の形がおかしいです" };
    const it = x as Record<string, unknown>;
    if (typeof it.mark !== "string" || !MARK_ONE.test(it.mark) || seen.has(it.mark)) return { ok: false, reason: "印の形がおかしいです" };
    if (typeof it.text !== "string") return { ok: false, reason: "材料の文がありません" };
    const kind = KIND_OF[it.mark.slice(1).replace(/\d+】$/, "")];
    if (it.kind !== kind) return { ok: false, reason: "材料の種類がおかしいです" };
    seen.add(it.mark);
    items.push({ mark: it.mark, kind, text: [...it.text.replace(/\s+/g, " ").trim()].slice(0, limits.maxItemChars).join("") });
  }
  if (items.length === 0) return { ok: false, reason: "材料がありません" };
  const rules = readRules(b.rules ?? [], menuIds);
  if (!rules) return { ok: false, reason: "ルールの形がおかしいです" };
  return { ok: true, value: { mode, items, rules } };
}
