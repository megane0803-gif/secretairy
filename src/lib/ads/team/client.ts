// 画面から /api/ai/ads/team を呼ぶ。受け取った答えは、画面でももう一度同じ言葉の門に通す。
// 窓口に届かない時（つながらない・答えの形がおかしい）は、この画面の中で決まった返事（AI なし）の会議を開く（4つの声は出す）。

import type { AdPastDecision } from "../../data/types";
import type { Rule } from "../../rules/types";
import type { AdSettings, AdsTeamAiSettings, ShopSettings } from "../../settings";
import type { AdTable } from "../report";
import type { AdProposal, AdsState } from "../state";
import { meet } from "./meet";
import { judgementsOf, materialText, pastDecisions, research } from "./research";
import { scriptTeamWriter } from "./script";
import { parseTeamResult, regateResult } from "./state";
import type { TeamResult } from "./types";
import type { TeamRequest, TeamResponse } from "./wire";

export type TeamAskContext = {
  table: AdTable;
  rules: Rule[];
  ads: AdsState;
  seedPast: AdPastDecision[];
  anchor: string;
  shop: ShopSettings;
  settings: Pick<AdSettings, "towns" | "gateWords">;
  limits: Omit<AdsTeamAiSettings, "model">;
};

/** 窓口に送る物（ルールは鍵つきを除いて送る。鍵つきはサーバーで足しなおす） */
export function teamRequestFor(p: AdProposal, ctx: TeamAskContext): TeamRequest {
  return {
    mode: p.mode,
    proposal: { action: p.action, no: p.no, reason: p.reason },
    table: ctx.table,
    rules: ctx.rules.filter((r) => !r.locked),
    judgements: judgementsOf(ctx.ads),
    past: pastDecisions(ctx.ads, ctx.seedPast, { shop: ctx.shop, anchor: ctx.anchor, excludeId: p.id, max: ctx.limits.maxHistory }),
  };
}

function runLimits(ctx: TeamAskContext) {
  return {
    maxTokens: ctx.limits.maxReplyTokens,
    maxCalls: ctx.limits.maxCalls,
    maxTwinChars: ctx.limits.maxTwinChars,
    maxLineChars: ctx.limits.maxLineChars,
    gateWords: ctx.settings.gateWords,
  };
}

/** 窓口に届かない時：この画面で、決まった返事の会議を開く（Claude は呼ばない） */
async function localScript(req: TeamRequest, ctx: TeamAskContext, snapshotText: string): Promise<TeamResult | null> {
  const input = {
    table: req.table,
    snapshot: { ...req.proposal, text: snapshotText },
    rules: ctx.rules,
    past: req.past,
    judgements: req.judgements,
    towns: ctx.settings.towns,
    shop: ctx.shop,
  };
  const r = await meet(input, "script", scriptTeamWriter, runLimits(ctx));
  return r ? { ...r, noAi: req.mode === "ai" } : null;
}

export type TeamAsk = { ok: true; result: TeamResult; local: boolean } | { ok: false; message: string };

export async function askAdsTeam(p: AdProposal, ctx: TeamAskContext): Promise<TeamAsk> {
  const req = teamRequestFor(p, ctx);
  let data: TeamResponse | null = null;
  try {
    const res = await fetch("/api/ai/ads/team", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) });
    try {
      data = (await res.json()) as TeamResponse;
    } catch {
      data = null;
    }
  } catch {
    data = null;
  }
  if (data && data.ok === false && typeof data.message === "string") return { ok: false, message: data.message };
  const parsed = data && data.ok === true ? parseTeamResult(data.result) : null;
  if (!parsed) {
    const local = await localScript(req, ctx, p.text);
    return local ? { ok: true, result: local, local: true } : { ok: false, message: "案の言葉が表にありません" };
  }
  // 画面でも、同じ材料で同じ門に通す
  const r = research(ctx.table, parsed.snapshot, req.judgements, ctx.settings.towns);
  if (!r) return { ok: false, message: "案の言葉が表にありません" };
  const material = materialText(r, parsed.snapshot, req.past, ctx.shop);
  return { ok: true, result: regateResult(parsed, { material, noHistory: req.past.length === 0, limits: runLimits(ctx) }), local: false };
}
