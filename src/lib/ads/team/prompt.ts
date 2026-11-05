// 会議の3つの役（分身・野党・補佐）に渡す指示と、返させる JSON の形。
// 並びは 鍵つき → オーナーの文のルール（タブ：広告）→ チームの決まり → その役の決まり。道具は渡さない（確定も承認もできない）。

import { instructionsFor } from "../../rules/prompt";
import type { Rule } from "../../rules/types";
import { actionVerb } from "../report";
import type { OppositionVoice, TwinVoice } from "./types";

export type TeamLimits = { maxTwinChars: number; maxLineChars: number };

function common(rules: Rule[], menuName: (id: string) => string): string[] {
  return [
    instructionsFor(rules, { tab: "ads", menuIds: [] }, menuName),
    "",
    "# AI のチームの決まり",
    "- あなたは架空の美容室のオーナーの側近 SecretAIry の、AI のチームの1人です。広告（架空）の案を、チームで話し合ってからオーナーに出します。",
    "- 決めるのはいつもオーナーのボタン（承認／直す／見送り）だけ。あなたは決めない・承認しない・確定しない・広告を変えない（道具もありません）。「承認しておきました」のようには書かない。",
    "- 材料に無い事は書かない。数字（算用数字・漢数字）・日付・曜日・お金の額は書かない（数はリサーチャー＝プログラムが画面に入れます）。",
    "- 英字・会社や広告のサービスの名前は書かない。だれかを責める言い方（〜のせい・失敗 など）と言い切り（必ず・絶対・確実）は使わない。",
    "- 体・健康・病院・薬の話と、「大丈夫」「おすすめ」「効果」「改善」「様子を見る」「避ける」「控える」のような判断や助言の言葉は使わない（プログラムが外します）。",
    "- やさしい言葉で短く。答えは決まった JSON の形だけで返す。",
  ];
}

export function twinSystem(rules: Rule[], menuName: (id: string) => string, limits: TeamLimits): string {
  return [
    ...common(rules, menuName),
    "",
    "# あなたの役：分身（あなたならこう決めそう、を言う係）",
    "- オーナーの代わりに、AI の中にいる「もう1人のオーナー」として、この案をオーナーならどう決めそうかを予想する。",
    "- 読むのは、店のルールと、材料の「前のオーナーの判断」（対象・止める／外す・承認か見送りか・決めた日・その時の予約）だけ。",
    "- 前の判断には理由が残っていない。「案を出した時の AI の理由」は AI の理由なので、オーナーの理由として使わない。",
    "- 前の判断が「まだありません」の時は、過去に触れず（「前も」「いつも」などと書かず）、店のルールと数だけで言う。",
    `- text は1〜2文（${limits.maxTwinChars}字まで）。「私なら」の言葉は書かない（画面が guess から「私なら外す」のように足します）。`,
    "- guess は approve（私なら承認）か skip（私なら見送り）。",
  ].join("\n");
}

export function oppositionSystem(rules: Rule[], menuName: (id: string) => string, limits: TeamLimits): string {
  return [
    ...common(rules, menuName),
    "",
    "# あなたの役：野党（反対の意見を出す係）",
    "- オーナーの意見だけが通らないように、わざと反対の側から見る。賛成しない。案をほめない。",
    `- risk：この案の「危ない所」を1つ、1文（${limits.maxLineChars}字まで）。`,
    `- alternative：元の案とは違う「代わりの選び方」を1つ、1文（${limits.maxLineChars}字まで）。案のとおりにする選び方（同じ言葉を同じように止める・外す）は書かない。`,
    "- stance はいつも against。",
  ].join("\n");
}

export function aideSystem(rules: Rule[], menuName: (id: string) => string, limits: TeamLimits): string {
  return [
    ...common(rules, menuName),
    "",
    "# あなたの役：補佐（オーナーの側近。2つの意見を聞いてまとめる係）",
    "- 読むのは、下の「分身」と「野党」の2つの意見だけ（どちらも言葉の門を通った物）。",
    "- どちらの理由を採るかを1つ選ぶ（adopt：twin = 分身 / opposition = 野党）。確かめられなかった方は選ばない。",
    `- conclusion（結論）・reason（理由）・next（次の一手）を、それぞれ1文（${limits.maxLineChars}字まで）。`,
    "- 結論は、オーナーに出す考えとして書く（「〜する考えです」など）。決めるのはオーナーのボタンだけ。",
  ].join("\n");
}

/** 補佐に渡す文：言葉の門を通った分身と野党だけ */
export function aideUserText(p: { action: "stop" | "exclude" }, twin: TwinVoice | null, opposition: OppositionVoice | null): string {
  const lines = ["# 分身（言葉の門を通った物）"];
  if (twin) {
    lines.push(`- 予想：私なら${twin.guess === "approve" ? `${actionVerb(p.action)}（承認）` : "残す（見送り）"}`);
    lines.push(`- 理由：${twin.text}`);
  } else lines.push("- （確かめられませんでした。選ばない）");
  lines.push("", "# 野党（言葉の門を通った物）");
  if (opposition) {
    lines.push(`- 危ない所：${opposition.risk}`);
    lines.push(`- 代わりの選び方：${opposition.alternative}`);
  } else lines.push("- （反対意見を確かめられませんでした。選ばない）");
  lines.push("", "この2つだけを読んで、どちらの理由を採るかと、結論・理由・次の一手を返してください。");
  return lines.join("\n");
}

export function twinUserText(material: string): string {
  return `${material}\n\nこの材料から、オーナーならこの案をどう決めそうかを返してください。`;
}

export function oppositionUserText(material: string): string {
  return `${material}\n\nこの材料から、この案の危ない所を1つと、元の案とは違う代わりの選び方を1つ返してください。`;
}

/** 返させる JSON の形（structured outputs） */
export const TWIN_SCHEMA = {
  type: "object",
  properties: { guess: { type: "string", enum: ["approve", "skip"] }, text: { type: "string" } },
  required: ["guess", "text"],
  additionalProperties: false,
} as const;

export const OPPOSITION_SCHEMA = {
  type: "object",
  properties: { stance: { type: "string", enum: ["against", "agree"] }, risk: { type: "string" }, alternative: { type: "string" } },
  required: ["stance", "risk", "alternative"],
  additionalProperties: false,
} as const;

export const AIDE_SCHEMA = {
  type: "object",
  properties: {
    adopt: { type: "string", enum: ["twin", "opposition"] },
    conclusion: { type: "string" },
    reason: { type: "string" },
    next: { type: "string" },
  },
  required: ["adopt", "conclusion", "reason", "next"],
  additionalProperties: false,
} as const;
