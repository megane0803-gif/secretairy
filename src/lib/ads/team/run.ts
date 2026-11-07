// 会議の流れ（サーバーの側で動く。受け取った物は残さない。テストでも同じ物を使う）。
//   リサーチャー（プログラム）が材料を作る
//   → 分身と野党を、同じ材料で別々に呼ぶ（おたがいの答えは見ない）→ 欄ごとに言葉の門
//   → 補佐は、門を通った分身と野党の2つだけを読む → 欄ごとに言葉の門
// Claude を呼ぶのは1回の会議で maxCalls（3）まで。作り直しはしない（当たった欄は出さない）。
// 🔒 ここでは広告も承認BOXも変えない。道具も渡さない。決めるのはオーナーのボタンだけ。

import type { Rule } from "../../rules/types";
import type { ShopSettings } from "../../settings";
import type { AdTable } from "../report";
import type { AdsMode } from "../wire";
import { claimsPast, gateTeamText, notOpposition } from "./gate";
import {
  AIDE_SCHEMA,
  aideSystem,
  aideUserText,
  OPPOSITION_SCHEMA,
  oppositionSystem,
  oppositionUserText,
  TWIN_SCHEMA,
  twinSystem,
  twinUserText,
} from "./prompt";
import { materialText, research } from "./research";
import type { AideVoice, OppositionVoice, PastDecision, PastJudgement, Research, TeamDropped, TeamResult, TeamSnapshot, TwinVoice } from "./types";

export type TeamRoleCall = "twin" | "opposition" | "aide";

/** 役に答えさせる時に渡す物。Claude は system と user だけを読む。決まった返事は材料の形（material）を読む */
export type TeamWriteRequest = {
  role: TeamRoleCall;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  material: { research: Research; snapshot: TeamSnapshot; past: PastDecision[] };
  /** 補佐だけ：門を通った分身と野党 */
  voices?: { twin: TwinVoice | null; opposition: OppositionVoice | null };
};

export type TeamWriteResult = { raw: unknown; stop: "end" | "max_tokens" | "refusal" };

export interface TeamWriter {
  /** 本物の Claude か（数える回数に入れるか） */
  readonly claude: boolean;
  write(req: TeamWriteRequest): Promise<TeamWriteResult>;
}

export type TeamInput = {
  table: AdTable;
  snapshot: TeamSnapshot;
  rules: Rule[];
  past: PastDecision[];
  judgements: PastJudgement[];
  towns: string[];
  shop: ShopSettings;
  menuName?: (id: string) => string;
};

export type TeamRunLimits = { maxTokens: number; maxCalls: number; maxTwinChars: number; maxLineChars: number; gateWords: string[] };

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";

/** 答えの形が足りない・止まった時の理由 */
function stopProblem(stop: TeamWriteResult["stop"]): string | null {
  if (stop === "refusal") return "AI が答えませんでした";
  if (stop === "max_tokens") return "長くなって途中で切れました";
  return null;
}

/** 分身の答えを門に通す */
export function gateTwin(
  out: TeamWriteResult,
  ctx: { material: string; noHistory: boolean; limits: Pick<TeamRunLimits, "maxTwinChars" | "gateWords"> },
): { voice: TwinVoice | null; dropped: TeamDropped[] } {
  const stop = stopProblem(out.stop);
  if (stop) return { voice: null, dropped: [{ role: "twin", field: "答え", problems: [stop] }] };
  const raw = isObj(out.raw) ? out.raw : {};
  if (raw.guess !== "approve" && raw.guess !== "skip") return { voice: null, dropped: [{ role: "twin", field: "予想", problems: ["承認か見送りかがありません"] }] };
  const g = gateTeamText(raw.text, { maxSentences: 2, maxChars: ctx.limits.maxTwinChars, gateWords: ctx.limits.gateWords, material: ctx.material });
  if (!g.ok) return { voice: null, dropped: [{ role: "twin", field: "分身の文", problems: g.problems }] };
  if (ctx.noHistory && claimsPast(g.text))
    return { voice: null, dropped: [{ role: "twin", field: "分身の文", problems: ["過去の判断はまだないのに、過去の話をしていました"] }] };
  return { voice: { guess: raw.guess, text: g.text, noHistory: ctx.noHistory }, dropped: [] };
}

/** 野党の答えを門に通す。どちらかが欠けた時・賛成の言いかえの時は出さない */
export function gateOpposition(
  out: TeamWriteResult,
  ctx: { material: string; snapshot: TeamSnapshot; limits: Pick<TeamRunLimits, "maxLineChars" | "gateWords"> },
): { voice: OppositionVoice | null; dropped: TeamDropped[] } {
  const stop = stopProblem(out.stop);
  if (stop) return { voice: null, dropped: [{ role: "opposition", field: "答え", problems: [stop] }] };
  const raw = isObj(out.raw) ? out.raw : {};
  const opts = { maxSentences: 1, maxChars: ctx.limits.maxLineChars, gateWords: ctx.limits.gateWords, material: ctx.material };
  const risk = gateTeamText(raw.risk, opts);
  const alt = gateTeamText(raw.alternative, opts);
  const dropped: TeamDropped[] = [];
  if (!risk.ok) dropped.push({ role: "opposition", field: "危ない所", problems: risk.problems });
  if (!alt.ok) dropped.push({ role: "opposition", field: "代わりの選び方", problems: alt.problems });
  if (!risk.ok || !alt.ok) return { voice: null, dropped };
  if (raw.stance !== "against") return { voice: null, dropped: [{ role: "opposition", field: "答え", problems: ["反対の意見になっていませんでした"] }] };
  const why = notOpposition(risk.text, alt.text, ctx.snapshot);
  if (why) return { voice: null, dropped: [{ role: "opposition", field: "答え", problems: [why] }] };
  return { voice: { risk: risk.text, alternative: alt.text }, dropped: [] };
}

/** 補佐の答えを門に通す（3行は1行ずつ。通った行だけ出す）。確かめられなかった方を採っていたら出さない */
export function gateAide(
  out: TeamWriteResult,
  ctx: { material: string; have: { twin: boolean; opposition: boolean }; limits: Pick<TeamRunLimits, "maxLineChars" | "gateWords"> },
): { voice: AideVoice | null; dropped: TeamDropped[] } {
  const stop = stopProblem(out.stop);
  if (stop) return { voice: null, dropped: [{ role: "aide", field: "答え", problems: [stop] }] };
  const raw = isObj(out.raw) ? out.raw : {};
  if ((raw.adopt !== "twin" && raw.adopt !== "opposition") || !ctx.have[raw.adopt])
    return { voice: null, dropped: [{ role: "aide", field: "採った理由", problems: ["読んでいない意見を採っていました"] }] };
  const opts = { maxSentences: 1, maxChars: ctx.limits.maxLineChars, gateWords: ctx.limits.gateWords, material: ctx.material };
  const voice: AideVoice = { adopt: raw.adopt };
  const dropped: TeamDropped[] = [];
  for (const [key, field] of [
    ["conclusion", "結論"],
    ["reason", "理由"],
    ["next", "次の一手"],
  ] as const) {
    const g = gateTeamText(raw[key], opts);
    if (g.ok) voice[key] = g.text;
    else dropped.push({ role: "aide", field, problems: g.problems });
  }
  if (!voice.conclusion && !voice.reason && !voice.next) return { voice: null, dropped };
  return { voice, dropped };
}

/** 補佐の門の材料：補佐が読んだ物（材料に無い体の言葉を外すため、分身と野党の文） */
function aideMaterial(twin: TwinVoice | null, opposition: OppositionVoice | null): string {
  return [twin?.text ?? "", opposition?.risk ?? "", opposition?.alternative ?? ""].join("\n");
}

/** 会議を1回開く。案の言葉が表に無い時は null */
export async function runTeam(input: TeamInput, writer: TeamWriter, limits: TeamRunLimits, mode: AdsMode, noAi = false): Promise<TeamResult | null> {
  const r = research(input.table, input.snapshot, input.judgements, input.towns);
  if (!r) return null;
  const snapshot: TeamSnapshot = { ...input.snapshot, text: r.text };
  const material = materialText(r, snapshot, input.past, input.shop);
  const menuName = input.menuName ?? ((id: string) => id);
  const tl = { maxTwinChars: limits.maxTwinChars, maxLineChars: limits.maxLineChars };
  const base = { maxTokens: limits.maxTokens, material: { research: r, snapshot, past: input.past } };
  let calls = 0;
  const call = async (req: TeamWriteRequest): Promise<TeamWriteResult | null> => {
    if (writer.claude) {
      if (calls >= limits.maxCalls) return null;
      calls += 1;
    }
    return writer.write(req);
  };

  // 分身と野党は、同じ材料を別々に読む（おたがいの答えは渡さない）
  const [twinOut, oppOut] = await Promise.all([
    call({ ...base, role: "twin", system: twinSystem(input.rules, menuName, tl), user: twinUserText(material), schema: TWIN_SCHEMA as unknown as Record<string, unknown> }),
    call({ ...base, role: "opposition", system: oppositionSystem(input.rules, menuName, tl), user: oppositionUserText(material), schema: OPPOSITION_SCHEMA as unknown as Record<string, unknown> }),
  ]);
  const dropped: TeamDropped[] = [];
  const over = (role: TeamDropped["role"]): TeamDropped => ({ role, field: "答え", problems: ["1回の会議で AI を呼ぶ回数の上限に来ました"] });
  const tw = twinOut ? gateTwin(twinOut, { material, noHistory: input.past.length === 0, limits }) : { voice: null, dropped: [over("twin")] };
  const op = oppOut ? gateOpposition(oppOut, { material, snapshot, limits }) : { voice: null, dropped: [over("opposition")] };
  dropped.push(...tw.dropped, ...op.dropped);

  // 補佐は、門を通った分身と野党の2つだけを読む（どちらも無ければ呼ばない）
  let aide: AideVoice | null = null;
  if (tw.voice || op.voice) {
    const aideOut = await call({
      ...base,
      role: "aide",
      system: aideSystem(input.rules, menuName, tl),
      user: aideUserText(snapshot, tw.voice, op.voice),
      schema: AIDE_SCHEMA as unknown as Record<string, unknown>,
      voices: { twin: tw.voice, opposition: op.voice },
    });
    const ad = aideOut
      ? gateAide(aideOut, { material: aideMaterial(tw.voice, op.voice), have: { twin: !!tw.voice, opposition: !!op.voice }, limits })
      : { voice: null, dropped: [over("aide")] };
    aide = ad.voice;
    dropped.push(...ad.dropped);
  }

  return { snapshot, mode, noAi, twin: tw.voice, opposition: op.voice, aide, dropped, calls };
}
