// 発信の下書きの、画面とサーバー（/api/ai/posts）のあいだの形。
// 材料・お店のメモ・ルールは画面から毎回送る。サーバーは答えを返すだけで、何も残さない。
// 日時・数字は送らない（AI に見せない。画面が台帳と設定から入れる）。お客様の名前も送らない。

import { readRules } from "../ai/request";
import type { PostMemo } from "../data/types";
import type { Rule } from "../rules/types";
import type { PostKind } from "../settings";
import type { PostGateCheck } from "./gate";
import type { PostStep } from "./write";

/** ai = Claude に聞く / script = 決まった返事（AI なし。テストと、AI につながらないときのお試し用） */
export type PostsMode = "ai" | "script";

export type PostsRequest = {
  mode: PostsMode;
  kind: string;
  materials: Record<string, string>;
  memos: PostMemo[];
  /** そのブラウザのルール（鍵つきはサーバーで先頭に足しなおす） */
  rules: Rule[];
};

export type PostsResponse =
  | { ok: true; text: string; checks: PostGateCheck[]; tries: number; cut: boolean; steps: PostStep[] }
  | { ok: false; code: "gate"; checks: PostGateCheck[]; problems: string[]; tries: number; steps: PostStep[] }
  | { ok: false; code: "no-ai"; message: string }
  | { ok: false; code: "bad-request"; message: string };

const MAX_MEMOS = 10;
const MAX_MEMO_CHARS = 400;
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

type Parsed = { ok: true; value: PostsRequest & { kindDef: PostKind } } | { ok: false; reason: string };

/** maxMaterialChars = 材料の1つの欄の長さの上限（config/ai.json の posts.maxMaterialChars） */
export function parsePostsRequest(body: unknown, kinds: PostKind[], maxMaterialChars: number, menuIds: string[]): Parsed {
  if (!isObj(body)) return { ok: false, reason: "形がおかしいです" };
  const mode: PostsMode = body.mode === "script" ? "script" : "ai";
  const kindDef = kinds.find((k) => k.id === body.kind);
  if (!kindDef) return { ok: false, reason: "種類がわかりません" };

  const raw = isObj(body.materials) ? body.materials : {};
  const materials: Record<string, string> = {};
  for (const f of kindDef.materials) {
    const v = raw[f.id];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if ([...t].length > maxMaterialChars) return { ok: false, reason: `${f.label}は${maxMaterialChars}字までです` };
    if (t) materials[f.id] = t;
  }
  const first = kindDef.materials[0];
  if (first && !materials[first.id]) return { ok: false, reason: `${first.label}を入れてください` };

  if (!Array.isArray(body.memos) || body.memos.length > MAX_MEMOS) return { ok: false, reason: "お店のメモの形がおかしいです" };
  const memos: PostMemo[] = [];
  for (const m of body.memos) {
    if (!isObj(m) || typeof m.id !== "string" || typeof m.title !== "string" || typeof m.text !== "string") return { ok: false, reason: "お店のメモの形がおかしいです" };
    memos.push({ id: m.id.slice(0, 40), title: m.title.slice(0, 40), text: m.text.slice(0, MAX_MEMO_CHARS) });
  }

  const rules = readRules(body.rules, menuIds);
  if (!rules) return { ok: false, reason: "ルールの形がおかしいです" };
  return { ok: true, value: { mode, kind: kindDef.id, kindDef, materials, memos, rules } };
}
