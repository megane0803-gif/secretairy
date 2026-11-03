// ルールの置き場所。今は「例のルール」（最初の状態）を読むだけ。
// オーナーが画面から足す・直す・消した物は、サーバーには保存せず
// 見ている人のブラウザの中だけに残し、最初の状態に重ねて使う（docs/SPEC.md §5.1）。
// 鍵つきの2つは置き場所に関係なく、いつも先頭に足される。

import seed from "@config/rules.seed.json";
import { LOCKED_RULES } from "./locked";
import type { Rule } from "./types";

export function getRules(): Rule[] {
  return [...LOCKED_RULES, ...(seed as Rule[])];
}
