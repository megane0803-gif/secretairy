// 発信のチームの会議の印と答えを、画面の中の下書き（deskStore の PostDraft）に残す形と変え方。
// ここは形と変え方だけ（どこにも書かない）。書くのは画面の部品（setPostsDesk）。
//   - 下書きの番号（id）・直した版の番号（version）・会議の番号（meetingId）を持ち、答えが戻った時と「入れる」を押した時の両方で照合する。
//   - 会議を始めた時の下書きの中身を印（snapshot）に残し、答えが戻った時に下書きが変わっていたら出さない。
//   - 答えが出た後にオーナーが手で直したら、残りの候補は使えなくする（「下書きが変わったので入れられません」）。
//   - 「入れる」で変わった時だけ版を上げる。元の文がまだ1回だけある時は、続けて次の候補を入れられる。
// 🔒 AI は下書きを書きかえない。直しを入れるのは、オーナーの「入れる」ボタンだけ。

import type { PostDraft } from "../deskStore";
import type { PostsMode } from "../wire";
import { checkEdit, hashText, replaceOnce } from "./gate";
import { draftTooLong } from "./run";
import { researchJournal, type PostResearch } from "./research";
import { CONCERN_LABEL, DRAFT_CHANGED, POST_ROLE_NAME, TOO_LONG, type AidePick, type PostTeamRecord, type PostTeamResult } from "./types";

export type MeetCheck = { ok: true } | { ok: false; reason: "none" | "done" | "empty" | "long"; message: string };

/** 会議にかけられるか（下書きがある・まだかけていない・空でない・長すぎない） */
export function canMeetPost(draft: PostDraft | null | undefined, maxDraftChars: number): MeetCheck {
  if (!draft) return { ok: false, reason: "none", message: "下書きがありません" };
  if (draft.team) return { ok: false, reason: "done", message: "この下書きはもうチームに読んでもらいました（作り直すと、また押せます）" };
  if (!draft.text.trim()) return { ok: false, reason: "empty", message: "下書きが空です" };
  if (draftTooLong(draft.text, maxDraftChars)) return { ok: false, reason: "long", message: TOO_LONG };
  return { ok: true };
}

/** 会議を始める：下書きの中身を印に残す。かけられなければ何も変えない（1つの下書きに1回） */
export function withPostTeamStarted(draft: PostDraft, meetingId: string, nowIso: string, mode: PostsMode, maxDraftChars: number): PostDraft {
  if (!canMeetPost(draft, maxDraftChars).ok) return draft;
  const team: PostTeamRecord = { meetingId, startedAt: nowIso, mode, snapshot: draft.text, version: draft.version ?? 0, picks: {} };
  return { ...draft, team };
}

export type PostTeamArrival = "shown" | "changed" | "missing";

/** どの下書きの、どの会議の答えか（答えが戻った時に照合する） */
export type MeetingRef = { draftId: string | undefined; meetingId: string };

/**
 * 答えが戻った：同じ下書きの同じ会議で、下書きの中身・版が会議を始めた時と同じ時だけ答えを残す。
 * 変わっていたら（手で直した・作り直した）出さずに「changed」。
 */
export function withPostTeamResult(draft: PostDraft | null, ref: MeetingRef, result: PostTeamResult): { draft: PostDraft | null; arrival: PostTeamArrival } {
  if (!draft || draft.id !== ref.draftId || !draft.team || draft.team.meetingId !== ref.meetingId || draft.team.result || draft.team.dropped)
    return { draft, arrival: "missing" };
  const t = draft.team;
  const same = draft.text === t.snapshot && (draft.version ?? 0) === t.version && result.hash === hashText(t.snapshot);
  const team: PostTeamRecord = same ? { ...t, result, text: t.snapshot } : { ...t, dropped: "changed" };
  return { draft: { ...draft, team }, arrival: same ? "shown" : "changed" };
}

/** 答えが戻らなかった。印は残す（1つの下書きに1回） */
export function withPostTeamFailed(draft: PostDraft | null, ref: MeetingRef): PostDraft | null {
  if (!draft || draft.id !== ref.draftId || draft.team?.meetingId !== ref.meetingId || draft.team.result) return draft;
  return { ...draft, team: { ...draft.team, dropped: "failed" } };
}

/** オーナーが手で直した：答えが出ていれば、残りの候補は使えなくする（版は上げない） */
export function withHandEdit(draft: PostDraft, text: string): PostDraft {
  if (text === draft.text) return draft;
  const team = draft.team?.result ? { ...draft.team, edited: true } : draft.team;
  return { ...draft, text, handEdited: true, ...(team ? { team } : {}) };
}

export type PickState = "open" | "applied" | "skipped" | "blocked" | "changed";

/** 補佐の直し1つの今の状態（changed = 手で直したので入れられない） */
export function pickState(draft: PostDraft, no: number): PickState {
  const t = draft.team;
  const c = t?.picks[no];
  if (c) return c;
  if (!t?.result || t.edited || draft.text !== t.text) return "changed";
  return "open";
}

/** 「入れる」「入れない」を押した時に照合する物（どの下書きの、どの版の、どの会議の、どの直しか） */
export type PickRef = { draftId: string | undefined; version: number; meetingId: string; no: number };

export type PickOutcome = "applied" | "skipped" | "changed" | "blocked" | "missing";

function findPick(draft: PostDraft | null, ref: PickRef): AidePick | null {
  if (!draft || draft.id !== ref.draftId || draft.team?.meetingId !== ref.meetingId || !draft.team.result) return null;
  if (draft.team.picks[ref.no]) return null;
  return draft.team.result.aide?.picks.find((p) => p.no === ref.no) ?? null;
}

/**
 * 🔒 オーナーが「入れる」を押した時だけ呼ぶ。照合して、元の文がまだ1回だけある時に、その1文だけを候補の文に置きかえる。
 * 置きかえた後の全文も確かめなおす（使わない言葉・プログラムが入れた所・印）。通らなければ入れない（blocked）。
 */
export function applyPostPick(
  draft: PostDraft | null,
  ref: PickRef,
  ctx: { gateWords: string[]; maxLineChars: number },
): { draft: PostDraft | null; outcome: PickOutcome; problems: string[] } {
  const pick = findPick(draft, ref);
  if (!draft || !pick) return { draft, outcome: "missing", problems: [] };
  const t = draft.team!;
  if (t.edited || (draft.version ?? 0) !== ref.version || (draft.version ?? 0) !== t.version || draft.text !== t.text) {
    return { draft: { ...draft, team: { ...t, edited: true } }, outcome: "changed", problems: [DRAFT_CHANGED] };
  }
  const g = checkEdit(draft.text, pick, { pieces: draft.pieces ?? [], gateWords: ctx.gateWords, maxChars: ctx.maxLineChars });
  if (!g.ok) return { draft: { ...draft, team: { ...t, picks: { ...t.picks, [pick.no]: "blocked" } } }, outcome: "blocked", problems: g.problems };
  const text = replaceOnce(draft.text, pick.from, pick.to);
  const version = (draft.version ?? 0) + 1;
  return {
    draft: { ...draft, text, version, team: { ...t, text, version, picks: { ...t.picks, [pick.no]: "applied" } } },
    outcome: "applied",
    problems: [],
  };
}

/** オーナーが「入れない」を押した */
export function skipPostPick(draft: PostDraft | null, ref: PickRef): { draft: PostDraft | null; outcome: PickOutcome } {
  const pick = findPick(draft, ref);
  if (!draft || !pick) return { draft, outcome: "missing" };
  const t = draft.team!;
  return { draft: { ...draft, team: { ...t, picks: { ...t.picks, [pick.no]: "skipped" } } }, outcome: "skipped" };
}

/**
 * オーナーが選び終わった時の日誌の1行（「補佐の直し：入れた2・入れなかった1」）。まだ選んでいない直しがあれば null。
 * 手で直して入れられなくなった物・確かめで入れられなかった物は「入れられなかった」に数える。
 */
export function pickSummary(draft: PostDraft | null): { draft: PostDraft; line: string } | null {
  const t = draft?.team;
  const picks = t?.result?.aide?.picks ?? [];
  if (!draft || !t || t.summarized || picks.length === 0) return null;
  const states = picks.map((p) => pickState(draft, p.no));
  if (states.includes("open")) return null;
  const n = (s: PickState[]) => states.filter((x) => s.includes(x)).length;
  const could = n(["blocked", "changed"]);
  const line = `${POST_ROLE_NAME.aide}の直し：入れた${n(["applied"])}・入れなかった${n(["skipped"])}${could ? `・入れられなかった${could}` : ""}`;
  return { draft: { ...draft, team: { ...t, summarized: true } }, line };
}

const q = (s: string) => `「${s}」`;

/** 会議の中身を、役の名前つきで短く日誌に（Claude の役は AI・決まった返事とリサーチャーはプログラム） */
export function postTeamJournal(r: PostTeamResult, research: PostResearch): { who: "AI" | "プログラム"; text: string }[] {
  const ai = r.mode === "ai" ? ("AI" as const) : ("プログラム" as const);
  const tag = r.mode === "ai" ? "" : "（AI なし）";
  const N = POST_ROLE_NAME;
  const out: { who: "AI" | "プログラム"; text: string }[] = [{ who: "プログラム", text: researchJournal(research) }];
  out.push(
    r.twin
      ? { who: ai, text: `${N.twin}${tag}：${r.twin.edits.length ? r.twin.edits.map((e) => `${q(e.from)}→${q(e.to)}`).join("・") : "直したい所はありません"}` }
      : { who: "プログラム", text: `${N.twin}：直しを確かめられませんでした` },
  );
  out.push(
    r.opposition
      ? { who: ai, text: `${N.opposition}${tag}：${CONCERN_LABEL[r.opposition.concern]}所。${r.opposition.why}${q(r.opposition.edit.from)}→${q(r.opposition.edit.to)}` }
      : { who: "プログラム", text: `${N.opposition}：反対意見を確かめられませんでした` },
  );
  out.push(
    r.aide
      ? { who: ai, text: `${N.aide}${tag}：${r.aide.picks.length ? `${r.aide.picks.map((p) => `${p.no}番`).join("・")}を選んだ（入れるかはオーナーが選ぶ）` : "入れたい直しは選びませんでした"}` }
      : { who: "プログラム", text: `${N.aide}：${r.candidates.length ? "まとめを確かめられませんでした" : "確かめ済みの候補が無いので、呼ばなかった"}` },
  );
  for (const d of r.dropped) out.push({ who: "プログラム", text: `確かめで外した：${N[d.role]}の${d.field}（${d.problems.join("。")}）` });
  return out;
}
