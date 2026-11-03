// ルールの置き場所。今は「例のルール」を読むだけ。
// オーナーが画面から足す・直す・消すときは、ここに保存の処理を足す
// （保存先は docs/SPEC.md の「まだ決めていないこと」）。
// 鍵つきの2つは保存先に関係なく、いつも先頭に足される。

import seed from "@config/rules.seed.json";
import { LOCKED_RULES } from "./locked";
import type { Rule } from "./types";

export function getRules(): Rule[] {
  return [...LOCKED_RULES, ...(seed as Rule[])];
}
