// ルールの形。中身（どんなルールを入れるか）は店が決める。
// 仕組みが決めるのは「形」と「ぶつかったときの決め方」と「確かめ方（judge.ts）」だけ。

import type { TabId } from "../tabs";

/** どこに効くか（札） */
export type RuleScope =
  | { level: "global" }
  | { level: "tab"; tab: TabId }
  | { level: "menu"; menuId: string };

/**
 * プログラムで確かめられる決まり（✓ を出せる）と、
 * 文だけの決まり（Claude への指示に入れる。プログラムの ✓ は出ない）。
 */
export type RuleCheck =
  | { kind: "minLeadMinutes"; value: number } // 来店の何分前まで受けるか
  | { kind: "maxNewCustomersPerDay"; value: number } // 初めての方は1日何人まで
  | { kind: "bufferAfterMinutes"; value: number } // 施術のあと何分あけるか
  // 同じ日に不可。with が無ければ「来店と同じ日（当日）の予約は受けない」。
  // with があれば（メニューごとのルールだけ）「このメニューと with のメニューは同じ日に入れない」（1回の来店の組み合わせにも、同じ方のその日のほかの予約にも効く）
  | { kind: "noSameDay"; with?: string }
  | { kind: "lastStart"; time: string } // この時刻（HH:MM）までに始める
  | { kind: "text" }; // 文だけ

export type RuleKind = RuleCheck["kind"];

/** プログラムが確かめる種類（文のルール以外） */
export type ProgramKind = Exclude<RuleKind, "text">;

export const PROGRAM_KINDS: ProgramKind[] = [
  "minLeadMinutes",
  "maxNewCustomersPerDay",
  "bufferAfterMinutes",
  "noSameDay",
  "lastStart",
];

export type Rule = RuleScope & {
  id: string;
  label: string;
  check: RuleCheck;
  /** 鍵つき。オーナーも消せない・緩められない */
  locked?: boolean;
};

/**
 * ルールがぶつかったとき、どちらが「厳しい」か。種類を足すときは必ずここにも足す。
 * "higher" = 数が大きい方が厳しい / "lower" = 数が小さい方が厳しい
 * "any" = 数を持たない種類。1つでもあれば効く（どれを使っても同じ）
 *   「同じ日に不可」の相手のメニュー（with）がちがうルールは、中身がちがうので別々に使う（strictest.ts の anyKey）
 *
 * 最終受付（lastStart）は時刻を分に直して比べる。早い（小さい）方が厳しい。
 */
export const STRICTER: Record<ProgramKind, "higher" | "lower" | "any"> = {
  minLeadMinutes: "higher",
  maxNewCustomersPerDay: "lower",
  bufferAfterMinutes: "higher",
  noSameDay: "any",
  lastStart: "lower",
};
