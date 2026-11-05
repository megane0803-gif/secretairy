// 画面から /api/ai/posts/team を呼ぶ。受け取った答えは、画面でももう一度同じ確かめ（gate.ts）に通す。
// 窓口に届かない時（つながらない・答えの形がおかしい）は、この画面の中で決まった返事（AI なし）の会議を開く（4つの声は出す）。
// 長すぎる下書きは、送らずに「長すぎるのでチームにかけられません」（切り捨てない・呼ばない）。

import type { PostMemo } from "../../data/types";
import type { Rule } from "../../rules/types";
import type { PostKind, PostsTeamAiSettings } from "../../settings";
import type { PostDraft } from "../deskStore";
import { meetPost } from "./meet";
import { draftTooLong, gateAidePost, gateOppositionPost, gateTwinPost, numberCandidates, type PostTeamInput, type PostTeamRunLimits } from "./run";
import { scriptPostTeamWriter } from "./script";
import { TOO_LONG, type PostTeamResult } from "./types";
import { parsePostTeamResult, type PostTeamRequest, type PostTeamResponse } from "./wire";

export type PostTeamAskContext = {
  kind: PostKind;
  memos: PostMemo[];
  rules: Rule[];
  gateWords: string[];
  limits: Omit<PostsTeamAiSettings, "model">;
};

export function runLimitsOf(l: Omit<PostsTeamAiSettings, "model">): PostTeamRunLimits {
  return {
    maxTokens: l.maxReplyTokens,
    maxCalls: l.maxCalls,
    maxTwinEdits: l.maxTwinEdits,
    maxPicks: l.maxPicks,
    maxLineChars: l.maxLineChars,
    maxDraftChars: l.maxDraftChars,
  };
}

/** 窓口に送る物（ルールは鍵つきを除いて送る。鍵つきはサーバーで足しなおす。保存した下書きは送らない） */
export function postTeamRequestFor(draft: Pick<PostDraft, "kind" | "text" | "pieces" | "mode">, ctx: PostTeamAskContext): PostTeamRequest {
  return { mode: draft.mode, kind: draft.kind, text: draft.text, pieces: draft.pieces ?? [], memos: ctx.memos, rules: ctx.rules.filter((r) => !r.locked) };
}

/** 受け取った答えを、画面でももう一度同じ確かめに通す（通らない物は出さない。補佐の文は候補の文を入れなおす） */
export function regatePostTeam(r: PostTeamResult, ctx: { text: string; pieces: string[]; gateWords: string[]; limits: PostTeamRunLimits }): PostTeamResult {
  const c = { text: ctx.text, pieces: ctx.pieces, gateWords: ctx.gateWords, limits: ctx.limits };
  const dropped = [...r.dropped];
  const tw = r.twin ? gateTwinPost({ raw: { edits: r.twin.edits }, stop: "end" }, c) : null;
  const op = r.opposition
    ? gateOppositionPost({ raw: { stance: "against", concern: r.opposition.concern, why: r.opposition.why, ...r.opposition.edit }, stop: "end" }, c)
    : null;
  const twin = tw?.voice ?? null;
  const opposition = op?.voice ?? null;
  dropped.push(...(tw?.dropped ?? []), ...(op?.dropped ?? []));
  const candidates = numberCandidates(twin, opposition);
  let aide = null;
  if (r.aide && candidates.length) {
    // サーバーの番号 → 文 → 画面で確かめた候補の番号
    const picks = r.aide.picks.map((p) => {
      const s = r.candidates.find((x) => x.no === p.no);
      const mine = s ? candidates.find((x) => x.from === s.from && x.to === s.to) : undefined;
      return { no: mine?.no ?? -1, reason: p.reason ?? "" };
    });
    const ad = gateAidePost({ raw: { picks }, stop: "end" }, { candidates, gateWords: ctx.gateWords, limits: ctx.limits });
    aide = ad.voice;
    dropped.push(...ad.dropped.filter((d) => !d.problems.every((x) => x === "文がありません")));
  }
  return { ...r, twin, opposition, candidates, aide, dropped };
}

export type PostTeamAsk = { ok: true; result: PostTeamResult; local: boolean } | { ok: false; message: string };

export async function askPostsTeam(draft: Pick<PostDraft, "kind" | "text" | "pieces" | "mode">, ctx: PostTeamAskContext): Promise<PostTeamAsk> {
  const limits = runLimitsOf(ctx.limits);
  if (draftTooLong(draft.text, limits.maxDraftChars)) return { ok: false, message: TOO_LONG };
  const req = postTeamRequestFor(draft, ctx);
  let data: PostTeamResponse | null = null;
  try {
    const res = await fetch("/api/ai/posts/team", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) });
    try {
      data = (await res.json()) as PostTeamResponse;
    } catch {
      data = null;
    }
  } catch {
    data = null;
  }
  if (data && data.ok === false && typeof data.message === "string") return { ok: false, message: data.message };
  const parsed = data && data.ok === true ? parsePostTeamResult(data.result) : null;
  const gateCtx = { text: draft.text, pieces: req.pieces, gateWords: ctx.gateWords, limits };
  if (!parsed) {
    // 窓口に届かない時：この画面で、決まった返事の会議を開く（Claude は呼ばない）
    const input: PostTeamInput = { kind: ctx.kind, text: draft.text, pieces: req.pieces, memos: ctx.memos, rules: ctx.rules, gateWords: ctx.gateWords };
    const local = await meetPost(input, "script", () => scriptPostTeamWriter(limits), limits);
    return local ? { ok: true, result: { ...local, noAi: draft.mode === "ai" }, local: true } : { ok: false, message: TOO_LONG };
  }
  return { ok: true, result: regatePostTeam(parsed, gateCtx), local: false };
}
