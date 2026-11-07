// 広告の見直しの、画面とサーバー（/api/ai/ads）のあいだの形。
// 表（最初の状態＋このブラウザで止めた・外した分）とルールは画面から毎回送る。サーバーは答えを返すだけで、何も残さない。

import { LOCKED_RULES } from "../rules/locked";
import type { Rule } from "../rules/types";
import { validateOwnerRule } from "../rules/validate";
import type { GateCheck, GatedProposal } from "./gate";
import type { AddPick } from "./add";
import type { AdAction, AdTable, AdTableRow, AddMark } from "./report";
import type { RejectedDraft, ReviewStep } from "./review";

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

/**
 * adds = 足す案（止める・外すの後の別の1回。止める・外すが門を通らなかった時も付く。直す時は付かない）。
 * 止める・外すの中身（proposal・checks・steps など）は足す案があっても今と同じ。
 */
export type AdsResponse =
  | { ok: true; proposal: GatedProposal; checks: GateCheck[]; tries: number; steps: ReviewStep[]; rejected?: RejectedDraft[]; adds?: AddPick }
  | { ok: false; code: "gate"; checks: GateCheck[]; problems: string[]; tries: number; steps: ReviewStep[]; rejected?: RejectedDraft[]; adds?: AddPick }
  | { ok: false; code: "no-ai"; message: string }
  /** 画面の側だけ：窓口が混んでいる（429）。サーバーは返さない */
  | { ok: false; code: "busy"; message: string }
  | { ok: false; code: "bad-request"; message: string };

const MAX_ROWS = 40;
const ADD_MARKS: readonly AddMark[] = ["pending", "added", "skipped"];
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
      // 足す案の印は調べた言葉だけ
      ...(kind === "term" && ADD_MARKS.includes(r.addMark as AddMark) ? { addMark: r.addMark as AddMark } : {}),
    });
  }
  return out;
}

/** 表（画面から送られた物）を確かめる。おかしければ null */
export function parseAdTable(t: unknown): AdTable | null {
  if (!isObj(t)) return null;
  const keywords = parseRows(t.keywords, "keyword");
  const searchTerms = parseRows(t.searchTerms, "term");
  if (!keywords || !searchTerms) return null;
  const nos = [...keywords, ...searchTerms].map((r) => r.no);
  if (new Set(nos).size !== nos.length) return null;
  return { keywords, searchTerms };
}

/** ルール（画面から送られた物）：鍵つきは送られた物を使わず、サーバーで先頭に足しなおす。オーナーのルールは確かめなおす */
export function parseRulesWithLocked(x: unknown, menuIds: string[]): Rule[] | null {
  if (!Array.isArray(x) || x.length > 200) return null;
  const locked = new Set(LOCKED_RULES.map((r) => r.id));
  const own: Rule[] = [];
  for (const r of x) {
    if (isObj(r) && typeof r.id === "string" && locked.has(r.id)) continue; // 鍵つきは送られた物を使わない
    const v = validateOwnerRule(r, menuIds);
    if (v.ok) own.push(v.value);
  }
  return [...LOCKED_RULES, ...own];
}

type Parsed = { ok: true; value: AdsRequest } | { ok: false; reason: string };

/** maxFixChars = 直すときのオーナーの一言の長さの上限（config/ai.json の ads.maxFixChars） */
export function parseAdsRequest(body: unknown, menuIds: string[], maxFixChars: number): Parsed {
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
    fix = { text: f.text.trim().slice(0, maxFixChars), current: { action: c.action, no: c.no } };
  }

  return { ok: true, value: { mode, table: { keywords, searchTerms }, rules: [...LOCKED_RULES, ...own], ...(fix ? { fix } : {}) } };
}
