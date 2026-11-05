// 発信のチームの、画面とサーバー（/api/ai/posts/team）のあいだの形。
// 下書き・プログラムが入れた文字・お店のメモ・ルールは画面から毎回送る。サーバーは答えを返すだけで、何も残さない。
// 前に保存した下書きは送らない（AI が書いた所とオーナーが書いた所の区別が無いので、分身の材料にしない）。
// 鍵つきのルールはサーバーで先頭に足しなおす。長すぎる下書きは切り捨てずに断る（呼ばない）。

import { readRules } from "../../ai/request";
import type { PostMemo } from "../../data/types";
import type { Rule } from "../../rules/types";
import type { PostKind } from "../../settings";
import type { PostsMode } from "../wire";
import { TOO_LONG, type PostConcern, type PostTeamResult } from "./types";

export type PostTeamRequest = {
  mode: PostsMode;
  kind: string;
  text: string;
  pieces: string[];
  memos: PostMemo[];
  rules: Rule[];
};

export type PostTeamResponse =
  | { ok: true; result: PostTeamResult }
  | { ok: false; code: "long" | "bad-request"; message: string };

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const MAX_MEMOS = 10;
const MAX_MEMO_CHARS = 400;
const MAX_PIECES = 10;
const MAX_PIECE_CHARS = 400;

type Parsed = { ok: true; value: PostTeamRequest & { kindDef: PostKind } } | { ok: false; code: "long" | "bad-request"; reason: string };

export function parsePostTeamRequest(body: unknown, kinds: PostKind[], maxDraftChars: number, menuIds: string[]): Parsed {
  if (!isObj(body)) return { ok: false, code: "bad-request", reason: "形がおかしいです" };
  const mode: PostsMode = body.mode === "script" ? "script" : "ai";
  const kindDef = kinds.find((k) => k.id === body.kind);
  if (!kindDef) return { ok: false, code: "bad-request", reason: "種類がわかりません" };
  if (typeof body.text !== "string" || !body.text.trim()) return { ok: false, code: "bad-request", reason: "下書きがありません" };
  // 切り捨てずに断る
  if ([...body.text].length > maxDraftChars) return { ok: false, code: "long", reason: TOO_LONG };
  const text = body.text.replace(/\r\n?/g, "\n");

  if (!Array.isArray(body.pieces) || body.pieces.length > MAX_PIECES) return { ok: false, code: "bad-request", reason: "入れた所の形がおかしいです" };
  const pieces = body.pieces.filter((p): p is string => typeof p === "string" && p.length > 0 && p.length <= MAX_PIECE_CHARS);

  if (!Array.isArray(body.memos) || body.memos.length > MAX_MEMOS) return { ok: false, code: "bad-request", reason: "お店のメモの形がおかしいです" };
  const memos: PostMemo[] = [];
  for (const m of body.memos) {
    if (!isObj(m) || typeof m.id !== "string" || typeof m.title !== "string" || typeof m.text !== "string")
      return { ok: false, code: "bad-request", reason: "お店のメモの形がおかしいです" };
    memos.push({ id: m.id.slice(0, 40), title: m.title.slice(0, 40), text: m.text.slice(0, MAX_MEMO_CHARS) });
  }

  const rules = readRules(body.rules, menuIds);
  if (!rules) return { ok: false, code: "bad-request", reason: "ルールの形がおかしいです" };
  return { ok: true, value: { mode, kind: kindDef.id, kindDef, text, pieces, memos, rules } };
}

// ---- 答えを読む（窓口から来た物。中身はもう一度確かめる：regatePostTeam） ----

const isStr = (x: unknown): x is string => typeof x === "string";
const cut = (x: unknown, n: number) => (isStr(x) ? x.slice(0, n) : "");

function parseEdit(x: unknown): { from: string; to: string } | null {
  return isObj(x) && isStr(x.from) && isStr(x.to) ? { from: cut(x.from, 400), to: cut(x.to, 400) } : null;
}

export function parsePostTeamResult(x: unknown): PostTeamResult | null {
  if (!isObj(x) || !isStr(x.hash)) return null;
  const twin = isObj(x.twin) && Array.isArray(x.twin.edits) ? { edits: x.twin.edits.map(parseEdit).filter((e): e is NonNullable<typeof e> => !!e).slice(0, 6) } : null;
  const o = x.opposition;
  const oe = isObj(o) ? parseEdit(o.edit) : null;
  const opposition =
    isObj(o) && oe && (o.concern === "unclear" || o.concern === "misleading" || o.concern === "pushy") && isStr(o.why)
      ? { concern: o.concern as PostConcern, why: cut(o.why, 200), edit: oe }
      : null;
  const candidates = Array.isArray(x.candidates)
    ? x.candidates
        .filter((c) => isObj(c) && Number.isInteger(c.no) && (c.source === "twin" || c.source === "opposition") && parseEdit(c))
        .slice(0, 8)
        .map((c) => ({ no: c.no as number, source: c.source as "twin" | "opposition", ...parseEdit(c)! }))
    : [];
  const aide =
    isObj(x.aide) && Array.isArray(x.aide.picks)
      ? {
          picks: x.aide.picks
            .filter((p) => isObj(p) && Number.isInteger(p.no))
            .slice(0, 6)
            .map((p) => ({ no: p.no as number, ...(isStr(p.reason) ? { reason: cut(p.reason, 200) } : {}) })),
        }
      : null;
  const dropped = Array.isArray(x.dropped)
    ? x.dropped
        .filter((d) => isObj(d) && (d.role === "twin" || d.role === "opposition" || d.role === "aide") && isStr(d.field) && Array.isArray(d.problems))
        .slice(0, 12)
        .map((d) => ({ role: d.role, field: cut(d.field, 20), problems: (d.problems as unknown[]).filter(isStr).slice(0, 6).map((s) => s.slice(0, 160)) }))
    : [];
  return {
    hash: x.hash.slice(0, 40),
    mode: x.mode === "ai" ? "ai" : "script",
    noAi: x.noAi === true,
    twin,
    opposition,
    candidates,
    // 補佐の番号は、下の regatePostTeam が確かめ済みの候補と照らして文を入れなおす
    aide: aide ? { picks: aide.picks.map((p) => ({ ...p, source: "twin" as const, from: "", to: "" })) } : null,
    dropped,
    calls: typeof x.calls === "number" && Number.isInteger(x.calls) && x.calls >= 0 ? x.calls : 0,
  };
}
