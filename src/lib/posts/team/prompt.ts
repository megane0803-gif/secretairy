// 発信のチームの3つの役（分身・野党・補佐）に渡す指示と、返させる JSON の形。発信用（広告のチームの指示は使わない）。
// 並びは 鍵つき → オーナーの文のルール（タブ：発信）→ チームの決まり → 書き方 → その役の決まり。道具は渡さない（保存・送信・公開もできない）。
// 日時はプログラムが入れた所なので、AI には見せない（「【お店が入れる所】」に置きかえて渡す）。

import type { PostMemo } from "../../data/types";
import { instructionsFor } from "../../rules/prompt";
import type { Rule } from "../../rules/types";
import type { PostKind } from "../../settings";
import { CONCERN_LABEL, type PostCandidate } from "./types";

export type PostTeamPromptLimits = { maxLineChars: number; maxTwinEdits: number; maxPicks: number };

/** 日時など、プログラムが入れた所を AI に見せない時の印 */
export const SHOP_FILLS = "【お店が入れる所】";

/** 書き方の決まり（プログラムの門に合う書き方。3つの役で同じ） */
export function writingRules(gateWords: string[], maxLineChars: number): string[] {
  return [
    "# 書き方（プログラムが1つずつ確かめます。外れた物は画面に出ません）",
    "- from には、下の「直してよい文」の中の1文を、1字も変えずに写す（「。」「！」「？」も含めて）。ほかの文・文の一部は from にしない。",
    `- to は from を直した1文だけ（「。」「！」「？」で終わる1つの文・${maxLineChars}字まで）。改行しない。2文にしない。`,
    "- 数字（算用数字・漢数字の数え方）・日付・曜日・時刻・値段・【…】の印・URL は書かない。日時はリサーチャー（プログラム）が確かめます。",
    "- 下書きとお店のメモに無い事（メニュー・値段・効き目・キャンペーンなど）は足さない。",
    "- 髪・頭皮・肌の具合や体調について、判断や助言の言葉（大丈夫・良くなる・おすすめ・効果・改善・控える など）は書かない。",
    `- 次の言葉は使わない：${gateWords.map((w) => `「${w}」`).join("")}。急がせる言い方・こわがらせる言い方もしない。`,
    "- 答えは決まった JSON の形だけ。欄の外に文を書かない。",
  ];
}

function common(rules: Rule[], menuName: (id: string) => string, gateWords: string[], limits: PostTeamPromptLimits): string[] {
  return [
    instructionsFor(rules, { tab: "posts", menuIds: [] }, menuName),
    "",
    "# AI のチームの決まり",
    "- あなたは架空の美容室のオーナーの側近 SecretAIry の、AI のチームの1人です。お店からお客様に出す文の下書きを、オーナーに出す前にチームで読みます。",
    "- あなたは下書きを書きかえない・保存しない・送らない・公開しない（道具もありません）。直しを入れるかどうかは、オーナーが1つずつ選びます。",
    "- やさしい言葉で短く。",
    "",
    ...writingRules(gateWords, limits.maxLineChars),
  ];
}

export function postTwinSystem(rules: Rule[], menuName: (id: string) => string, gateWords: string[], limits: PostTeamPromptLimits): string {
  return [
    ...common(rules, menuName, gateWords, limits),
    "",
    "# あなたの役：分身（「あなたならこう書きそう」を言う係）",
    "- AI の中にいる「もう1人のオーナー」として、オーナーならこう書きそう、という直しを出す。",
    "- オーナーの声として読むのは、店のルール（上の「店の決まり」）と「お店のメモ」の言い回しだけ。",
    `- edits：直しを${limits.maxTwinEdits}つまで（from = 元の1文・to = オーナーならこう書きそうな1文）。直したい所が無ければ空の並び。`,
    "- 例：{\"edits\":[{\"from\":\"またのご来店をお待ちしております。\",\"to\":\"またお会いできるのを楽しみにしています。\"}]}（例の文はそのまま使わない）",
  ].join("\n");
}

export function postOppositionSystem(rules: Rule[], menuName: (id: string) => string, gateWords: string[], limits: PostTeamPromptLimits): string {
  return [
    ...common(rules, menuName, gateWords, limits),
    "",
    "# あなたの役：野党（反対の意見を出す係）",
    "- 書いた人の考えだけが通らないように、読む人（お客様）の目で見る。賛成しない。下書きをほめない。",
    `- concern：引っかかる所の種類を1つ（unclear = ${CONCERN_LABEL.unclear} / misleading = ${CONCERN_LABEL.misleading} / pushy = ${CONCERN_LABEL.pushy}）。`,
    `- why：なぜ引っかかるかを1文だけ（${limits.maxLineChars}字まで）。`,
    "- from：引っかかる1文（「直してよい文」から1字も変えずに）。to：代わりの言い方の1文。",
    "- stance：いつも against。",
    "- 例：{\"stance\":\"against\",\"concern\":\"pushy\",\"why\":\"お願いの形が続くと、読む人には押しつけに聞こえるかもしれません。\",\"from\":\"ぜひお越しください。\",\"to\":\"お時間のある時に、お越しいただけたらうれしいです。\"}（例の文はそのまま使わない）",
  ].join("\n");
}

export function postAideSystem(rules: Rule[], menuName: (id: string) => string, gateWords: string[], limits: PostTeamPromptLimits): string {
  return [
    ...common(rules, menuName, gateWords, limits),
    "",
    "# あなたの役：補佐（オーナーの側近。2つの意見を聞いてまとめる係）",
    "- 読むのは、下の「確かめ済みの候補」（番号つき。分身と野党の直しのうち、プログラムが確かめた物）だけ。",
    `- picks：入れたらよい候補を${limits.maxPicks}つまで、番号（no）で選ぶ。同じ元の文の候補は1つだけ選ぶ。`,
    `- reason：選んだ理由をひとこと（1文・${limits.maxLineChars}字まで）。`,
    "- 直した文を自分で書きなおさない（候補の文をそのまま使います）。候補に無い番号は選ばない。",
    "- 入れるかどうかを決めるのはオーナー。「入れました」とは書かない。",
    "- 例：{\"picks\":[{\"no\":2,\"reason\":\"読む人に伝わりやすくなるからです。\"}]}",
  ].join("\n");
}

/** 分身と野党に渡す材料（2人とも同じ物。おたがいの答えは入れない） */
export function postMaterialText(kind: Pick<PostKind, "label">, maskedText: string, sentences: string[], memos: PostMemo[]): string {
  const lines = ["# お店のメモ（オーナーが書いた物）"];
  for (const m of memos) lines.push(`- ${m.title}：${m.text}`);
  lines.push("", `# 下書き（${kind.label}。${SHOP_FILLS}は日時などをお店が入れた所なので、読まなくてよい）`, maskedText);
  lines.push("", "# 直してよい文（from はこの中の1文を、1字も変えずに写す）");
  if (sentences.length === 0) lines.push("- （ありません）");
  for (const s of sentences) lines.push(`- ${s}`);
  return lines.join("\n");
}

export function postTwinUserText(material: string): string {
  return `${material}\n\nこの材料から、オーナーならこう書きそう、という直しを返してください。`;
}

export function postOppositionUserText(material: string): string {
  return `${material}\n\nこの材料から、読む人の目で引っかかる所を1つと、代わりの言い方を1つ返してください。`;
}

/** 補佐に渡す文：確かめ済みの候補だけ */
export function postAideUserText(candidates: PostCandidate[]): string {
  const lines = ["# 確かめ済みの候補（番号・だれの直しか・元の文 → 直した文）"];
  for (const c of candidates) lines.push(`${c.no}. ${c.source === "twin" ? "分身" : "野党"}：「${c.from}」→「${c.to}」`);
  lines.push("", "この候補だけを読んで、入れたらよい物を番号で選び、理由をひとこと付けて返してください。");
  return lines.join("\n");
}

const EDIT_ITEM = {
  type: "object",
  properties: {
    from: { type: "string", description: "「直してよい文」の1文を1字も変えずに写した物" },
    to: { type: "string", description: "直した1文。数字・日付・曜日・印・URL を書かない" },
  },
  required: ["from", "to"],
  additionalProperties: false,
} as const;

/** 返させる JSON の形（structured outputs。数の上限は欄の説明に書き、プログラムが確かめる） */
export const POST_TWIN_SCHEMA = {
  type: "object",
  properties: { edits: { type: "array", items: EDIT_ITEM, description: "オーナーならこう書きそう、という直し（決まった数まで）" } },
  required: ["edits"],
  additionalProperties: false,
} as const;

export const POST_OPPOSITION_SCHEMA = {
  type: "object",
  properties: {
    stance: { type: "string", enum: ["against", "agree"], description: "いつも against" },
    concern: { type: "string", enum: ["unclear", "misleading", "pushy"], description: "unclear = 分かりにくい / misleading = 誤解されそう / pushy = 押しつけに聞こえる" },
    why: { type: "string", description: "なぜ引っかかるかを1文だけ。数字・日付を書かない" },
    from: EDIT_ITEM.properties.from,
    to: EDIT_ITEM.properties.to,
  },
  required: ["stance", "concern", "why", "from", "to"],
  additionalProperties: false,
} as const;

export const POST_AIDE_SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      description: "確かめ済みの候補から選んだ物（決まった数まで）",
      items: {
        type: "object",
        properties: {
          no: { type: "integer", description: "候補の番号" },
          reason: { type: "string", description: "選んだ理由をひとこと（1文）" },
        },
        required: ["no", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["picks"],
  additionalProperties: false,
} as const;
