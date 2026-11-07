// 画面から /api/ai/ads/note を呼ぶ。一言は飾りなので、つながらない・門に当たった時は null（画面は何も出さない）。
// 受け取った一言は、画面でももう一度言葉の門に通す。

import type { AdsNoteFacts, AdsNoteResponse } from "./note";
import type { AdJudgement, AdWeeklyReport } from "./results";
import type { AdsState } from "./state";
import { KEPT_WHY } from "./weekly";
import { gateAdSentence } from "./words";

export async function askAdsNote(facts: AdsNoteFacts, gateWords: string[]): Promise<string | null> {
  try {
    const res = await fetch("/api/ai/ads/note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ facts }),
    });
    const data = (await res.json()) as AdsNoteResponse;
    if (!data || data.ok !== true || typeof data.note !== "string") return null;
    const g = gateAdSentence(data.note, gateWords);
    return g.ok ? g.text : null;
  } catch {
    return null;
  }
}

/** 判定の事実（数字は持たない） */
export function judgementFacts(j: AdJudgement): AdsNoteFacts {
  return {
    kind: "judgement",
    verdict: j.verdict,
    action: j.action,
    word: j.text,
    costDown: j.after.cost < j.before.cost,
    bookingsDown: j.after.bookings < j.before.bookings,
    fewNumbers: j.verdict === "unknown",
  };
}

/** 報告の事実（いまの承認BOXの行から） */
export function reportFacts(r: AdWeeklyReport, ads: AdsState): AdsNoteFacts {
  const row = r.proposalId ? ads.proposals.find((p) => p.id === r.proposalId) : undefined;
  const outcome = !r.proposal ? "none" : row?.state === "approved" ? "approved" : row?.state === "skipped" ? "skipped" : row ? "pending" : "none";
  return {
    kind: "report",
    outcome,
    ...(row ? { action: row.action, word: row.text } : r.proposal ? { action: r.proposal.action, word: r.proposal.text } : {}),
    keptTown: r.kept.some((k) => k.why === KEPT_WHY.town),
    keptFeatured: r.kept.some((k) => k.why === KEPT_WHY.featured),
  };
}

/**
 * 一言をまだ頼んでいない物（AI で作った案の物だけ。決まった返事の物には付けない）。新しい順に1つ。
 * 報告は、案が承認BOXで決まってから（承認待ちの間は頼まない）。
 */
export function nextNoteTarget(ads: AdsState): { kind: "judgement"; item: AdJudgement } | { kind: "report"; item: AdWeeklyReport } | null {
  const j = (ads.judgements ?? []).find((x) => x.mode === "ai" && !x.noteTried);
  if (j) return { kind: "judgement", item: j };
  const decided = (x: AdWeeklyReport) => !x.proposalId || ads.proposals.find((p) => p.id === x.proposalId)?.state !== "pending";
  const r = (ads.reports ?? []).find((x) => x.mode === "ai" && !x.noteTried && decided(x));
  if (r) return { kind: "report", item: r };
  return null;
}
