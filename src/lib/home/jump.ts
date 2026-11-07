// ホームの中で「同じページの欄へ飛ぶ」先（docs/SPEC.md §1.6）。画面に依らない形だけ（テストは __tests__/jump.test.ts）。
// 飛ぶ先が畳める欄（RememberFold）なら、開いてから動かす（閉じたまま飛ばない）。
// 数字のカード（朝の要点）と、「AI に頼める仕事」の結果の「承認待ち1件」が使う。

import type { HomeFoldId } from "./folds";

export type HomeJumpId = "customers" | "approvals";

/** target = 飛ぶ先の要素の id。fold = 畳める欄なら、その欄（開いてから飛ぶ） */
export const HOME_JUMPS: Record<HomeJumpId, { target: string; fold?: HomeFoldId; label: string }> = {
  customers: { target: "customers", fold: "customers", label: "今日のお客様" },
  approvals: { target: "approvals", label: "承認BOX" },
};
