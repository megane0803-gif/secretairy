// 広告の見直しの、画面とサーバー（/api/ai/ads）のあいだの形。
// 表（最初の状態＋このブラウザで止めた・外した分）とルールは画面から毎回送る。サーバーは答えを返すだけで、何も残さない。

import { LOCKED_RULES } from "../rules/locked";
import type { Rule } from "../rules/types";
import { validateOwnerRule } from "../rules/validate";
import type { GateCheck, GatedProposal } from "./gate";
import type { AdAction, AdTable, AdTableRow } from "./report";
import type { ReviewStep } from "./review";

/** ai = Claude に聞く / script = 決まった返事（AI なし。テストと、AI につながらないときのお試し用） */
export type AdsMode = "ai" | "script";

export type AdsRequest = {
  mode: AdsMode;
  table: AdTable;
  /** そのブラウザのルール（鍵つきはサーバーで先頭に足しなおす） */
  rules: Rule[];
  /** 直す：オーナーの一言と、いまの案 */
  fix?: { text: string; current: { action: AdAction; no: number } };
};

export type AdsResponse =
  | { ok: true; proposal: GatedProposal; checks: GateCheck[]; tries: number; steps: ReviewStep[] }
  | { ok: false; code: "gate"; checks: GateCheck[]; problems: string[]; tries: number; steps: ReviewStep[] }
  | { ok: false; code: "no-ai"; message: string }
  | { ok: false; code: "bad-request"; message: string };

/** 直すときのオーナーの一言の長さ（字） */
export const MAX_FIX_CHARS = 100;

const MAX_ROWS = 40;
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";
const count = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x < 1e9;

function parseRows(x: unknown, kind: AdTableRow["kind"]): AdTableRow[] | null {
  if (!Array.isArray(x) || x.length > MAX_ROWS) return null;
  const out: AdTableRow[] = [];
  for (const r of x) {
    if (!isObj(r) || typeof r.no !== "number" || !Number.isInteger(r.no) || r.no < 1 || r.no > 999 || typeof r.text !== "string") return null;
    if (!Array.isArray(r.weeks) || r.weeks.length === 0 || r.weeks.length > 8) return null;
    const weeks = [];
    for (const w of r.weeks) {
      if (!isObj(w) || !count(w.clicks) || !count(w.cost) || !count(w.bookings)) return null;
      weeks.push({ clicks: w.clicks as number, cost: w.cost as number, bookings: w.bookings as number });
    }
    out.push({
      no: r.no,
      text: r.text.slice(0, 40),
      kind,
      featured: kind === "keyword" && r.featured === true,
      ...(typeof r.menuId === "string" ? { menuId: r.menuId.slice(0, 40) } : {}),
      weeks,
      off: r.off === true,
    });
  }
  return out;
}

type Parsed = { ok: true; value: AdsRequest } | { ok: false; reason: string };

export function parseAdsRequest(body: unknown, menuIds: string[]): Parsed {
  if (!isObj(body)) return { ok: false, reason: "形がおかしいです" };
  const mode: AdsMode = body.mode === "script" ? "script" : "ai";
  const t = body.table;
  if (!isObj(t)) return { ok: false, reason: "表がありません" };
  const keywords = parseRows(t.keywords, "keyword");
  const searchTerms = parseRows(t.searchTerms, "term");
  if (!keywords || !searchTerms) return { ok: false, reason: "表の形がおかしいです" };
  const nos = [...keywords, ...searchTerms].map((r) => r.no);
  if (new Set(nos).size !== nos.length) return { ok: false, reason: "表の番号が重なっています" };

  if (!Array.isArray(body.rules) || body.rules.length > 200) return { ok: false, reason: "ルールの形がおかしいです" };
  const locked = new Set(LOCKED_RULES.map((r) => r.id));
  const own: Rule[] = [];
  for (const r of body.rules) {
    if (isObj(r) && typeof r.id === "string" && locked.has(r.id)) continue; // 鍵つきは送られた物を使わない
    const v = validateOwnerRule(r, menuIds);
    if (v.ok) own.push(v.value);
  }

  let fix: AdsRequest["fix"];
  if (body.fix !== undefined) {
    const f = body.fix;
    if (!isObj(f) || typeof f.text !== "string" || !f.text.trim() || !isObj(f.current)) return { ok: false, reason: "直す一言がありません" };
    const c = f.current;
    if ((c.action !== "stop" && c.action !== "exclude") || typeof c.no !== "number") return { ok: false, reason: "いまの案がわかりません" };
    fix = { text: f.text.trim().slice(0, MAX_FIX_CHARS), current: { action: c.action, no: c.no } };
  }

  return { ok: true, value: { mode, table: { keywords, searchTerms }, rules: [...LOCKED_RULES, ...own], ...(fix ? { fix } : {}) } };
}
