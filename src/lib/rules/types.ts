// ルールの形。中身（どんなルールを入れるか）は店が決める。
// 仕組みが決めるのは「形」と「ぶつかったときの決め方」だけ。

import type { TabId } from "../tabs";

/** どこに効くか（札） */
export type RuleScope =
  | { level: "global" }
  | { level: "tab"; tab: TabId }
  | { level: "menu"; menuId: string };

/**
 * プログラムで確かめられる決まり（✓ を出せる）と、
 * 文だけの決まり（AI に読ませる。プログラムの ✓ は出ない）。
 */
export type RuleCheck =
  | { kind: "minLeadMinutes"; value: number } // 来店の何分前まで受けるか
  | { kind: "maxNewCustomersPerDay"; value: number } // 初めての方は1日何人まで
  | { kind: "bufferAfterMinutes"; value: number } // 施術のあと何分あけるか
  | { kind: "text" }; // 文だけ

export type RuleKind = RuleCheck["kind"];

export type Rule = RuleScope & {
  id: string;
  label: string;
  check: RuleCheck;
  /** 鍵つき。オーナーも消せない・緩められない */
  locked?: boolean;
};

/**
 * 数のルールがぶつかったとき、どちらが「厳しい」か。
 * "higher" = 数が大きい方が厳しい / "lower" = 数が小さい方が厳しい。
 */
export const STRICTER: Record<Exclude<RuleKind, "text">, "higher" | "lower"> = {
  minLeadMinutes: "higher",
  maxNewCustomersPerDay: "lower",
  bufferAfterMinutes: "higher",
};
