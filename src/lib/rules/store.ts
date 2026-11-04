// ルールの置き場所。最初の状態は例のルール（config/rules.seed.json）。
// オーナーが画面から足す・直す・消した物は、サーバーには保存せず
// 見ている人のブラウザの中だけに残し、最初の状態に重ねて使う（docs/SPEC.md §5.1、重ね方は overlay.ts）。
// 鍵つきの2つは置き場所に関係なく、いつも先頭に足される。

import seed from "@config/rules.seed.json";
import { EMPTY_OVERLAY, mergeRules, type ListedRule } from "./overlay";
import type { Rule } from "./types";

/** 例のルール（最初の状態）。ブラウザで重ねるときの土台として画面に渡す */
export function getSeedRules(): Rule[] {
  return seed as Rule[];
}

/** 最初の状態のルール（鍵つき＋例のルール）。ブラウザの分を重ねるのは useRules（画面の側） */
export function getRules(): ListedRule[] {
  return mergeRules(getSeedRules(), EMPTY_OVERLAY);
}
