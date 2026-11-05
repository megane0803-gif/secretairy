// 発信のチームの会議の流れ（サーバーの側で動く。受け取った物は残さない。テストでも同じ物を使う）。
//   分身と野党を、同じ材料で別々に呼ぶ（おたがいの答えは見せない）→ 直しを1つずつプログラムが確かめる（gate.ts）
//   → 確かめ済みの候補に番号を付ける → 補佐は番号つきの候補だけを読み、3つまで番号で選ぶ（文は候補の文をそのまま使う）
// Claude を呼ぶのは1回の会議で maxCalls（3）まで。作り直しはしない。下書きを書きかえない（入れるかはオーナーが選ぶ）。
// 🔒 道具は渡さない（保存・送信・公開もできない）。リサーチャー（プログラム）は画面が今の台帳と設定から出す（research.ts）。

import type { TeamJsonRequest, TeamJsonResult } from "../../ads/team/claude";
import type { PostMemo } from "../../data/types";
import type { Rule } from "../../rules/types";
import type { PostKind } from "../../settings";
import type { PostsMode } from "../wire";
import { checkEdit, editableSentences, hashText, lineProblems } from "./gate";
import {
  POST_AIDE_SCHEMA,
  POST_OPPOSITION_SCHEMA,
  POST_TWIN_SCHEMA,
  postAideSystem,
  postAideUserText,
  postMaterialText,
  postOppositionSystem,
  postOppositionUserText,
  postTwinSystem,
  postTwinUserText,
  SHOP_FILLS,
} from "./prompt";
import type { AidePick, AidePostVoice, OppositionPostVoice, PostCandidate, PostConcern, PostEdit, PostTeamDropped, PostTeamResult, TwinPostVoice } from "./types";

export type PostTeamRoleCall = "twin" | "opposition" | "aide";

/** 役に答えさせる時に渡す物。Claude は system と user だけを読む。決まった返事は material と candidates を読む */
export type PostTeamWriteRequest = TeamJsonRequest & {
  role: PostTeamRoleCall;
  material: { text: string; sentences: string[]; memos: PostMemo[] };
  /** 補佐だけ：確かめ済みの候補 */
  candidates?: PostCandidate[];
};

export interface PostTeamWriter {
  /** 本物の Claude か（数える回数に入れるか） */
  readonly claude: boolean;
  write(req: PostTeamWriteRequest): Promise<TeamJsonResult>;
}

export type PostTeamInput = {
  kind: Pick<PostKind, "id" | "label">;
  /** 下書きの今の文（会議を始めた時の中身） */
  text: string;
  /** プログラムが入れた文字（fillPost の pieces） */
  pieces: string[];
  memos: PostMemo[];
  rules: Rule[];
  gateWords: string[];
  menuName?: (id: string) => string;
};

export type PostTeamRunLimits = {
  maxTokens: number;
  maxCalls: number;
  maxTwinEdits: number;
  maxPicks: number;
  maxLineChars: number;
  maxDraftChars: number;
};

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";
const CONCERNS: PostConcern[] = ["unclear", "misleading", "pushy"];

/** 長すぎて会議にかけられない（切り捨てない） */
export function draftTooLong(text: string, maxDraftChars: number): boolean {
  return [...text].length > maxDraftChars;
}

/** AI に見せる下書き：プログラムが入れた所（日時など）を印に置きかえる（長い物から） */
export function maskPieces(text: string, pieces: string[]): string {
  let t = text;
  for (const p of [...pieces].filter(Boolean).sort((a, b) => b.length - a.length)) t = t.split(p).join(SHOP_FILLS);
  return t;
}

function stopProblem(stop: TeamJsonResult["stop"]): string | null {
  if (stop === "refusal") return "AI が答えませんでした";
  if (stop === "max_tokens") return "長くなって途中で切れました";
  return null;
}

type Ctx = { text: string; pieces: string[]; gateWords: string[]; limits: Pick<PostTeamRunLimits, "maxLineChars" | "maxTwinEdits" | "maxPicks"> };
const editCtx = (c: Ctx) => ({ pieces: c.pieces, gateWords: c.gateWords, maxChars: c.limits.maxLineChars });

/** 分身の答えを確かめる（直しは1つずつ。通った物だけ） */
export function gateTwinPost(out: TeamJsonResult, ctx: Ctx): { voice: TwinPostVoice | null; dropped: PostTeamDropped[] } {
  const stop = stopProblem(out.stop);
  if (stop) return { voice: null, dropped: [{ role: "twin", field: "答え", problems: [stop] }] };
  const raw = isObj(out.raw) ? out.raw : {};
  if (!Array.isArray(raw.edits)) return { voice: null, dropped: [{ role: "twin", field: "答え", problems: ["直しの形がありません"] }] };
  const dropped: PostTeamDropped[] = [];
  if (raw.edits.length > ctx.limits.maxTwinEdits)
    dropped.push({ role: "twin", field: "答え", problems: [`${ctx.limits.maxTwinEdits}つより多く出していたので、後ろは外しました`] });
  const edits: PostEdit[] = [];
  raw.edits.slice(0, ctx.limits.maxTwinEdits).forEach((e, i) => {
    const g = checkEdit(ctx.text, e, editCtx(ctx));
    if (g.ok) edits.push(g.edit);
    else dropped.push({ role: "twin", field: `直し${i + 1}`, problems: g.problems });
  });
  if (raw.edits.length > 0 && edits.length === 0) return { voice: null, dropped };
  return { voice: { edits }, dropped };
}

/** 賛成の言いかえ（野党の答えが、反対になっていない） */
const AGREE = /(賛成|同意|異論|その通り|そのとおり|このままで(よい|いい|大丈夫|十分)|直す所は(ない|無い|ありません)|問題(ない|無い|ありません)|良い文|よい文|いい文|よく書けて)/;

/** 野党の答えを確かめる。欠けた・賛成の言いかえの時は出さない */
export function gateOppositionPost(out: TeamJsonResult, ctx: Ctx): { voice: OppositionPostVoice | null; dropped: PostTeamDropped[] } {
  const stop = stopProblem(out.stop);
  if (stop) return { voice: null, dropped: [{ role: "opposition", field: "答え", problems: [stop] }] };
  const raw = isObj(out.raw) ? out.raw : {};
  if (raw.stance !== "against") return { voice: null, dropped: [{ role: "opposition", field: "答え", problems: ["反対の意見になっていませんでした"] }] };
  const concern = CONCERNS.find((c) => c === raw.concern);
  if (!concern) return { voice: null, dropped: [{ role: "opposition", field: "引っかかる所", problems: ["種類がありません"] }] };
  const why = typeof raw.why === "string" ? raw.why.trim() : "";
  const whyProblems = lineProblems(why, { maxChars: ctx.limits.maxLineChars, gateWords: ctx.gateWords, material: typeof raw.from === "string" ? raw.from : "" });
  if (whyProblems.length) return { voice: null, dropped: [{ role: "opposition", field: "理由", problems: whyProblems }] };
  if (AGREE.test(why) || (typeof raw.to === "string" && AGREE.test(raw.to)))
    return { voice: null, dropped: [{ role: "opposition", field: "答え", problems: ["賛成の言いかえになっていました"] }] };
  const g = checkEdit(ctx.text, { from: raw.from, to: raw.to }, editCtx(ctx));
  if (!g.ok) return { voice: null, dropped: [{ role: "opposition", field: "代わりの言い方", problems: g.problems }] };
  return { voice: { concern, why, edit: g.edit }, dropped: [] };
}

/** 確かめ済みの候補に番号を付ける（分身 → 野党の順。同じ直しは1つに） */
export function numberCandidates(twin: TwinPostVoice | null, opposition: OppositionPostVoice | null): PostCandidate[] {
  const out: PostCandidate[] = [];
  const add = (e: PostEdit, source: PostCandidate["source"]) => {
    if (out.some((c) => c.from === e.from && c.to === e.to)) return;
    out.push({ no: out.length + 1, source, from: e.from, to: e.to });
  };
  for (const e of twin?.edits ?? []) add(e, "twin");
  if (opposition) add(opposition.edit, "opposition");
  return out;
}

/**
 * 補佐の答えを確かめる：確かめ済みの候補に無い番号は捨てる・同じ元の文への候補は1つに絞る・maxPicks まで。
 * 文は候補の文をそのまま使う（補佐が書きかえて返しても使わない）。理由は門を通った時だけ付ける。
 */
export function gateAidePost(
  out: TeamJsonResult,
  ctx: { candidates: PostCandidate[]; gateWords: string[]; limits: Pick<PostTeamRunLimits, "maxLineChars" | "maxPicks"> },
): { voice: AidePostVoice | null; dropped: PostTeamDropped[] } {
  const stop = stopProblem(out.stop);
  if (stop) return { voice: null, dropped: [{ role: "aide", field: "答え", problems: [stop] }] };
  const raw = isObj(out.raw) ? out.raw : {};
  if (!Array.isArray(raw.picks)) return { voice: null, dropped: [{ role: "aide", field: "答え", problems: ["選んだ番号の形がありません"] }] };
  const picks: AidePick[] = [];
  const dropped: PostTeamDropped[] = [];
  for (const p of raw.picks) {
    const no = isObj(p) && typeof p.no === "number" && Number.isInteger(p.no) ? p.no : null;
    const c = no === null ? undefined : ctx.candidates.find((x) => x.no === no);
    if (!c) {
      dropped.push({ role: "aide", field: "選んだ番号", problems: [`確かめ済みの候補に無い番号（${no ?? "なし"}）でした`] });
      continue;
    }
    if (picks.some((x) => x.from === c.from)) {
      dropped.push({ role: "aide", field: `${c.no}番`, problems: ["同じ元の文への候補は1つに絞りました"] });
      continue;
    }
    if (picks.length >= ctx.limits.maxPicks) {
      dropped.push({ role: "aide", field: `${c.no}番`, problems: [`${ctx.limits.maxPicks}つより多く選んでいました`] });
      continue;
    }
    const reason = isObj(p) && typeof p.reason === "string" ? p.reason.trim() : "";
    const rp = lineProblems(reason, { maxChars: ctx.limits.maxLineChars, gateWords: ctx.gateWords, material: `${c.from}\n${c.to}` });
    if (/入れました|直しました|書きかえました/.test(reason)) rp.push("🔒 入れるかどうかはオーナーが選びます");
    // 文は候補の文をそのまま（補佐の返した文は使わない）
    const pick: AidePick = { ...c };
    if (rp.length === 0) pick.reason = reason;
    else dropped.push({ role: "aide", field: `${c.no}番の理由`, problems: rp });
    picks.push(pick);
  }
  return { voice: { picks }, dropped };
}

/** 会議を1回開く。下書きが長すぎる時は null（切り捨てずに、呼ばない） */
export async function runPostTeam(
  input: PostTeamInput,
  writer: PostTeamWriter,
  limits: PostTeamRunLimits,
  mode: PostsMode,
  noAi = false,
): Promise<PostTeamResult | null> {
  if (draftTooLong(input.text, limits.maxDraftChars)) return null;
  const menuName = input.menuName ?? ((id: string) => id);
  const sentences = editableSentences(input.text, input.pieces);
  const material = postMaterialText(input.kind, maskPieces(input.text, input.pieces), sentences, input.memos);
  const pl = { maxLineChars: limits.maxLineChars, maxTwinEdits: limits.maxTwinEdits, maxPicks: limits.maxPicks };
  const base = { maxTokens: limits.maxTokens, material: { text: input.text, sentences, memos: input.memos } };
  let calls = 0;
  const call = async (req: PostTeamWriteRequest): Promise<TeamJsonResult | null> => {
    if (writer.claude) {
      if (calls >= limits.maxCalls) return null;
      calls += 1;
    }
    return writer.write(req);
  };
  const schema = (s: unknown) => s as Record<string, unknown>;

  // 分身と野党は、同じ材料を別々に読む（おたがいの答えは渡さない）
  const [twinOut, oppOut] = await Promise.all([
    call({ ...base, role: "twin", system: postTwinSystem(input.rules, menuName, input.gateWords, pl), user: postTwinUserText(material), schema: schema(POST_TWIN_SCHEMA) }),
    call({
      ...base,
      role: "opposition",
      system: postOppositionSystem(input.rules, menuName, input.gateWords, pl),
      user: postOppositionUserText(material),
      schema: schema(POST_OPPOSITION_SCHEMA),
    }),
  ]);
  const over = (role: PostTeamDropped["role"]): PostTeamDropped => ({ role, field: "答え", problems: ["1回の会議で AI を呼ぶ回数の上限に来ました"] });
  const ctx: Ctx = { text: input.text, pieces: input.pieces, gateWords: input.gateWords, limits };
  const tw = twinOut ? gateTwinPost(twinOut, ctx) : { voice: null, dropped: [over("twin")] };
  const op = oppOut ? gateOppositionPost(oppOut, ctx) : { voice: null, dropped: [over("opposition")] };
  const dropped: PostTeamDropped[] = [...tw.dropped, ...op.dropped];
  const candidates = numberCandidates(tw.voice, op.voice);

  // 補佐は、確かめ済みの候補（番号つき）だけを読む（候補が無ければ呼ばない）
  let aide: AidePostVoice | null = null;
  if (candidates.length) {
    const aideOut = await call({
      ...base,
      role: "aide",
      system: postAideSystem(input.rules, menuName, input.gateWords, pl),
      user: postAideUserText(candidates),
      schema: schema(POST_AIDE_SCHEMA),
      candidates,
    });
    const ad = aideOut ? gateAidePost(aideOut, { candidates, gateWords: input.gateWords, limits }) : { voice: null, dropped: [over("aide")] };
    aide = ad.voice;
    dropped.push(...ad.dropped);
  }

  return { hash: hashText(input.text), mode, noAi, twin: tw.voice, opposition: op.voice, candidates, aide, dropped, calls };
}
