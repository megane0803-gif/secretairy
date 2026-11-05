// 会議の印と答えを、承認の箱の行（広告の案。secretairy:ads の proposals）に残す形と変え方。
// ここは形と変え方だけ（どこにも書かない）。書くのは画面の部品（useAds の update）。
//   - 会議を始めた時の案の中身を「会議済み」の印（snapshot）として残す。1つの案に会議は1回まで。
//   - 答えが戻った時に、案がまだ承認待ちで中身が同じ時だけ出す（「直す」・LINE・別の画面で変わっていたら出さない）。
// 🔒 会議の答えは読む物。止める・外す・見送るのは、今までどおりオーナーのボタンだけ。

import type { AdProposal, AdsState } from "../state";
import { actionPast, actionVerb, type AdAction } from "../report";
import type { AdsMode } from "../wire";
import { gateAide, gateOpposition, gateTwin, type TeamRunLimits } from "./run";
import { sameSnapshot, snapshotOf } from "./research";
import { ROLE_NAME, type AideVoice, type OppositionVoice, type TeamDropped, type TeamRecord, type TeamResult, type TeamSnapshot, type TwinVoice } from "./types";

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";
const isStr = (x: unknown): x is string => typeof x === "string";
const isAction = (x: unknown): x is AdAction => x === "stop" || x === "exclude";
const cut = (x: unknown, n: number) => (isStr(x) ? x.slice(0, n) : "");

/** 会議にかけられるか：承認待ちのふつうの案で、まだ会議にかけていない（戻す案は別の行なので、ここには来ない） */
export function canMeet(p: AdProposal | null | undefined): boolean {
  return !!p && p.state === "pending" && !p.team;
}

/** 会議を始める：案の中身を「会議済み」の印として残す。もう印があれば何も変えない（1つの案に1回まで） */
export function withTeamStarted(s: AdsState, id: string, nowIso: string, mode: AdsMode): AdsState {
  const p = s.proposals.find((x) => x.id === id);
  if (!p || !canMeet(p)) return s;
  const team: TeamRecord = { snapshot: snapshotOf(p), startedAt: nowIso, mode };
  return { ...s, proposals: s.proposals.map((x) => (x.id === id ? { ...x, team } : x)) };
}

export type TeamArrival = "shown" | "changed" | "decided" | "missing";

/**
 * 答えが戻った：案がまだ承認待ちで、中身が会議を始めた時と同じ時だけ答えを残す。
 * 変わっていたら（直す・別の画面）出さずに「changed」。もう決まっていたら（LINE・別の画面で押した）「decided」。
 */
export function withTeamResult(s: AdsState, id: string, startedAt: string, result: TeamResult): { state: AdsState; arrival: TeamArrival } {
  const p = s.proposals.find((x) => x.id === id);
  if (!p || !p.team || p.team.startedAt !== startedAt || p.team.result || p.team.dropped) return { state: s, arrival: "missing" };
  if (p.state !== "pending") return { state: s, arrival: "decided" };
  const same = sameSnapshot(snapshotOf(p), p.team.snapshot) && sameAction(result.snapshot, p.team.snapshot);
  const team: TeamRecord = same ? { ...p.team, result } : { ...p.team, dropped: "changed" };
  return { state: { ...s, proposals: s.proposals.map((x) => (x.id === id ? { ...x, team } : x)) }, arrival: same ? "shown" : "changed" };
}

/** 答えが戻らなかった（窓口がうまくいかなかった）。印は残す（1つの案に1回まで） */
export function withTeamFailed(s: AdsState, id: string, startedAt: string): AdsState {
  return {
    ...s,
    proposals: s.proposals.map((x) => (x.id === id && x.team?.startedAt === startedAt && !x.team.result ? { ...x, team: { ...x.team, dropped: "failed" } } : x)),
  };
}

function sameAction(a: TeamSnapshot, b: TeamSnapshot): boolean {
  return a.action === b.action && a.no === b.no && a.text === b.text;
}

/** 画面に出してよい会議の答え：案の中身が、会議を始めた時と同じ時だけ */
export function shownTeam(p: AdProposal): TeamResult | null {
  if (!p.team?.result) return null;
  return sameSnapshot(snapshotOf(p), p.team.snapshot) ? p.team.result : null;
}

/** 分身の「私なら」の言葉（外す・止める・残す） */
export function guessWord(action: AdAction, guess: TwinVoice["guess"]): string {
  return guess === "approve" ? actionVerb(action) : "残す";
}

/** オーナーが押した事の言葉（外した・止めた・残した） */
export function ownerWord(action: AdAction, decision: "approved" | "skipped"): string {
  return decision === "approved" ? actionPast(action) : "残した";
}

/**
 * オーナーが押した後の日誌の1行：「分身の予想：外す／オーナー：残した」。
 * 会議の答えを出していて、分身が確かめられた時だけ（無ければ null）。
 */
export function teamDecisionLine(p: AdProposal, decision: "approved" | "skipped"): string | null {
  const r = shownTeam(p);
  if (!r?.twin) return null;
  return `分身の予想：${guessWord(p.action, r.twin.guess)}／オーナー：${ownerWord(p.action, decision)}`;
}

/** 会議の中身を、役の名前つきで短く日誌に（だれ：Claude の役は AI・決まった返事とリサーチャーはプログラム） */
export function teamJournal(p: Pick<AdProposal, "no" | "text" | "action">, r: TeamResult): { who: "AI" | "プログラム"; text: string }[] {
  const ai = r.mode === "ai" ? ("AI" as const) : ("プログラム" as const);
  const tag = r.mode === "ai" ? "" : "（AI なし）";
  const out: { who: "AI" | "プログラム"; text: string }[] = [
    { who: "プログラム", text: `${ROLE_NAME.researcher}：${p.no}番「${p.text}」の4週の数・予約・お金・前の判定を並べた` },
  ];
  out.push(
    r.twin
      ? { who: ai, text: `${ROLE_NAME.twin}${tag}：${r.twin.noHistory ? "過去の判断はまだありません。" : ""}${r.twin.text}私なら${guessWord(p.action, r.twin.guess)}` }
      : { who: "プログラム", text: `${ROLE_NAME.twin}：意見を確かめられませんでした` },
  );
  out.push(
    r.opposition
      ? { who: ai, text: `${ROLE_NAME.opposition}${tag}：${r.opposition.risk}${r.opposition.alternative}` }
      : { who: "プログラム", text: `${ROLE_NAME.opposition}：反対意見を確かめられませんでした` },
  );
  out.push(
    r.aide
      ? { who: ai, text: `${ROLE_NAME.aide}${tag}：${ROLE_NAME[r.aide.adopt]}の理由を採った。${[r.aide.conclusion, r.aide.reason, r.aide.next].filter(Boolean).join("")}` }
      : { who: "プログラム", text: `${ROLE_NAME.aide}：まとめを確かめられませんでした` },
  );
  for (const d of r.dropped) out.push({ who: "プログラム", text: `言葉の門で外した：${ROLE_NAME[d.role]}の${d.field}（${d.problems.join("。")}）` });
  return out;
}

// ---- 読む（ブラウザに残っていた物・窓口から来た物） ----

function parseSnapshot(x: unknown): TeamSnapshot | null {
  if (!isObj(x) || !isAction(x.action) || typeof x.no !== "number" || !Number.isInteger(x.no) || !isStr(x.text) || !isStr(x.reason)) return null;
  return { action: x.action, no: x.no, text: x.text.slice(0, 40), reason: x.reason.slice(0, 200) };
}

function parseDropped(x: unknown): TeamDropped[] {
  if (!Array.isArray(x)) return [];
  return x
    .filter((d) => isObj(d) && (d.role === "twin" || d.role === "opposition" || d.role === "aide") && isStr(d.field) && Array.isArray(d.problems))
    .slice(0, 12)
    .map((d) => ({ role: d.role, field: cut(d.field, 20), problems: (d.problems as unknown[]).filter(isStr).slice(0, 6).map((s) => s.slice(0, 120)) }));
}

/** 答えの形を読む（中身の文はここでは確かめない。確かめるのは regateResult） */
export function parseTeamResult(x: unknown): TeamResult | null {
  if (!isObj(x)) return null;
  const snapshot = parseSnapshot(x.snapshot);
  if (!snapshot) return null;
  const tw = isObj(x.twin) && (x.twin.guess === "approve" || x.twin.guess === "skip") && isStr(x.twin.text) ? x.twin : null;
  const op = isObj(x.opposition) && isStr(x.opposition.risk) && isStr(x.opposition.alternative) ? x.opposition : null;
  const ad = isObj(x.aide) && (x.aide.adopt === "twin" || x.aide.adopt === "opposition") ? x.aide : null;
  const twin: TwinVoice | null = tw ? { guess: tw.guess as TwinVoice["guess"], text: cut(tw.text, 200), noHistory: tw.noHistory === true } : null;
  const opposition: OppositionVoice | null = op ? { risk: cut(op.risk, 200), alternative: cut(op.alternative, 200) } : null;
  const aide: AideVoice | null = ad
    ? {
        adopt: ad.adopt as AideVoice["adopt"],
        ...(isStr(ad.conclusion) ? { conclusion: cut(ad.conclusion, 200) } : {}),
        ...(isStr(ad.reason) ? { reason: cut(ad.reason, 200) } : {}),
        ...(isStr(ad.next) ? { next: cut(ad.next, 200) } : {}),
      }
    : null;
  return {
    snapshot,
    mode: x.mode === "ai" ? "ai" : "script",
    noAi: x.noAi === true,
    twin,
    opposition,
    aide,
    dropped: parseDropped(x.dropped),
    calls: typeof x.calls === "number" && Number.isInteger(x.calls) && x.calls >= 0 ? x.calls : 0,
  };
}

/** 窓口から受け取った答えを、画面でももう一度同じ門に通す（通らない欄は出さない） */
export function regateResult(r: TeamResult, ctx: { material: string; noHistory: boolean; limits: Pick<TeamRunLimits, "maxTwinChars" | "maxLineChars" | "gateWords"> }): TeamResult {
  const dropped = [...r.dropped];
  const tw = r.twin ? gateTwin({ raw: r.twin, stop: "end" }, { material: ctx.material, noHistory: ctx.noHistory, limits: ctx.limits }) : null;
  const op = r.opposition
    ? gateOpposition({ raw: { stance: "against", ...r.opposition }, stop: "end" }, { material: ctx.material, snapshot: r.snapshot, limits: ctx.limits })
    : null;
  const twin = tw?.voice ?? null;
  const opposition = op?.voice ?? null;
  dropped.push(...(tw?.dropped ?? []), ...(op?.dropped ?? []));
  let aide: AideVoice | null = null;
  if (r.aide && (twin || opposition)) {
    const material = [twin?.text ?? "", opposition?.risk ?? "", opposition?.alternative ?? ""].join("\n");
    const raw = { adopt: r.aide.adopt, conclusion: r.aide.conclusion ?? "", reason: r.aide.reason ?? "", next: r.aide.next ?? "" };
    const ad = gateAide({ raw, stop: "end" }, { material, have: { twin: !!twin, opposition: !!opposition }, limits: ctx.limits });
    aide = ad.voice;
    // 空で来た行（サーバーで外した行）は、もう日誌に書いてあるので足さない
    dropped.push(...ad.dropped.filter((d) => !(d.problems.length === 1 && d.problems[0] === "文がありません")));
  }
  return { ...r, twin, opposition, aide, dropped };
}

/** ブラウザに残っていた会議の印を読む */
export function parseTeamRecord(x: unknown): TeamRecord | undefined {
  if (!isObj(x) || !isStr(x.startedAt)) return undefined;
  const snapshot = parseSnapshot(x.snapshot);
  if (!snapshot) return undefined;
  const result = x.result === undefined ? undefined : parseTeamResult(x.result) ?? undefined;
  return {
    snapshot,
    startedAt: x.startedAt,
    mode: x.mode === "script" ? "script" : "ai",
    ...(result ? { result } : {}),
    ...(x.dropped === "changed" || x.dropped === "failed" ? { dropped: x.dropped } : {}),
  };
}
