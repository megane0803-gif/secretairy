// 会議の、画面とサーバー（/api/ai/ads/team）のあいだの形。
// 表・案・前の判定・前のオーナーの判断・ルールは画面から毎回送る。サーバーは答えを返すだけで、何も残さない。
// 案の言葉は送られた文を使わず、表から入れなおす。鍵つきのルールはサーバーで先頭に足しなおす。

import type { Rule } from "../../rules/types";
import { actionFor, findRow, type AdAction, type AdTable } from "../report";
import type { AdVerdict } from "../results";
import { parseAdTable, parseRulesWithLocked, type AdsMode } from "../wire";
import type { PastDecision, PastJudgement, TeamResult, TeamSnapshot } from "./types";

export type TeamRequest = {
  mode: AdsMode;
  proposal: { action: AdAction; no: number; reason: string };
  table: AdTable;
  rules: Rule[];
  judgements: PastJudgement[];
  past: PastDecision[];
};

export type TeamResponse = { ok: true; result: TeamResult } | { ok: false; code: "bad-request"; message: string };

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";
const isAction = (x: unknown): x is AdAction => x === "stop" || x === "exclude";
const isVerdict = (x: unknown): x is AdVerdict => x === "worked" || x === "revert" || x === "unknown";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
const MAX_LIST = 20;

type Parsed = { ok: true; value: TeamRequest & { snapshot: TeamSnapshot } } | { ok: false; reason: string };

export function parseTeamRequest(body: unknown, menuIds: string[], maxHistory: number): Parsed {
  if (!isObj(body)) return { ok: false, reason: "形がおかしいです" };
  const mode: AdsMode = body.mode === "script" ? "script" : "ai";
  const table = parseAdTable(body.table);
  if (!table) return { ok: false, reason: "表の形がおかしいです" };
  const rules = parseRulesWithLocked(body.rules, menuIds);
  if (!rules) return { ok: false, reason: "ルールの形がおかしいです" };

  const p = body.proposal;
  if (!isObj(p) || !isAction(p.action) || typeof p.no !== "number" || typeof p.reason !== "string") return { ok: false, reason: "案がわかりません" };
  const row = findRow(table, p.no);
  if (!row || actionFor(row.kind) !== p.action) return { ok: false, reason: "案の言葉が表にありません" };
  const proposal = { action: p.action, no: row.no, reason: clean(p.reason, 200) };

  if (!Array.isArray(body.judgements) || body.judgements.length > MAX_LIST) return { ok: false, reason: "前の判定の形がおかしいです" };
  const judgements: PastJudgement[] = [];
  for (const j of body.judgements) {
    if (!isObj(j) || typeof j.no !== "number" || !isAction(j.action) || !isVerdict(j.verdict)) continue;
    const r = findRow(table, j.no);
    if (r) judgements.push({ no: r.no, text: r.text, action: j.action, verdict: j.verdict });
  }

  if (!Array.isArray(body.past) || body.past.length > MAX_LIST) return { ok: false, reason: "前の判断の形がおかしいです" };
  const past: PastDecision[] = [];
  for (const d of body.past) {
    if (!isObj(d) || typeof d.text !== "string" || !d.text.trim() || !isAction(d.action)) continue;
    if ((d.decision !== "approved" && d.decision !== "skipped") || typeof d.date !== "string" || !DATE.test(d.date)) continue;
    if (typeof d.bookings !== "number" || !Number.isInteger(d.bookings) || d.bookings < 0 || d.bookings > 1e6) continue;
    past.push({ text: clean(d.text, 40), action: d.action, decision: d.decision, date: d.date, bookings: d.bookings });
  }
  past.sort((a, b) => b.date.localeCompare(a.date));

  return {
    ok: true,
    value: {
      mode,
      proposal,
      table,
      rules,
      judgements,
      past: past.slice(0, maxHistory),
      snapshot: { ...proposal, text: row.text },
    },
  };
}
