// お客様に「断る理由」を伝えてよいかを決める所。AI には決めさせない（プログラムが決める）。
// - ルール：オーナーがルールごとに決める（Rule の「お客様に伝える」= tellCustomer）。欄が無い・false なら伝えない
//   （前からブラウザに残っているルールも、最初のルール config/rules.seed.json も、欄が無いので伝えない）。
//   伝えるときは、ルールの名前（label。オーナーが書いた言葉）をそのまま理由にする。
// - 店の設定（定休日・営業時間・過ぎた時刻・メニューの最終受付）はルールではないので、今までどおり伝える。
//   同じ時間に受ける人数（席）は店の中の都合なので伝えない。
// 伝えないときは、AI に理由の中身を渡さない。返事はプログラムが「その時間はお受けできません」＋確かめ済みの代わりの候補で決める（ai/agent.ts）。

import type { Rule } from "./types";

/** 伝えない理由で断るときの、お客様への1文（理由の中身は言わない） */
export const INTERNAL_REFUSAL = "その時間はお受けできません。";
/** 伝えない「いっしょに受けない組み合わせ」で断るときの1文（日時を変えればよいと読まれないように） */
export const COMBO_REFUSAL = "この組み合わせではお受けできません。";

/** 理由の最後のかっこ（「（24時間前まで）」など）を外す。1文の中でかっこが重ならないように */
export function plainReason(reason: string): string {
  return reason.replace(/（[^（）]*）$/, "");
}

/** 店の設定の確かめ（judge.ts の base の id）ごとの、お客様への決まった文。null = 伝えない */
const BASE_SAY: Record<string, ((reason: string) => string) | null> = {
  future: () => "もう過ぎた時刻なので、お受けできません。",
  "open-day": () => "その日はお休み（定休日）なので、お受けできません。",
  hours: (reason) => `営業時間に収まらないので、お受けできません（${plainReason(reason)}）。`,
  "menu-last": (reason) => `最終受付を過ぎるので、お受けできません（${reason}）。`,
  seats: null,
};

/** 店の設定の確かめで断ったときのお客様への1文。伝えない物（同じ時間に受ける人数・知らない id）は null */
export function baseSay(id: string, reason: string): string | null {
  const say = BASE_SAY[id];
  return say ? say(reason) : null;
}

/** そのルールをお客様に伝えてよいか（オーナーが「お客様に伝える」にした物だけ。🔒 は断る理由にならないので伝えない） */
export function tellsRule(rule: Pick<Rule, "tellCustomer" | "locked">): boolean {
  return rule.tellCustomer === true && !rule.locked;
}

/** 伝えるルールで断ったときのお客様への1文（ルールの名前をそのまま） */
export function ruleSay(rule: Pick<Rule, "label">): string {
  return `「${rule.label}」のため、お受けできません。`;
}

/** 伝えるルール（いっしょに受けない組み合わせ）で、組み合わせそのものを断ったときの1文 */
export function comboSay(rule: Pick<Rule, "label">): string {
  return `「${rule.label}」のため、この組み合わせではお受けできません。`;
}
