// 「AI の手順」の各行の頭に付ける短い印（見た目だけ。行の中身・日誌の文は変えない）。
//   ✓ 通った（調べて受けられた・見つかった）
//   ! 断った・気をつける（ルールや店の設定で外した・受けられない・見つからない・上限で止めた・押さえなかった）
//   → 次にしたこと（仮押さえ・仮押さえを外す・聞き返す・代わりを調べる・ToDo に足す・料金を答える）

import type { Step } from "./wire";

export type StepMark = "ok" | "warn" | "next";

export const STEP_MARK: Record<StepMark, { mark: string; label: string }> = {
  ok: { mark: "✓", label: "通った" },
  warn: { mark: "!", label: "断った・気をつける" },
  next: { mark: "→", label: "次にしたこと" },
};

/** 道具の行で「通らなかった」と読める言葉（tools.ts の行の言い方） */
const NOT_PASSED = ["✗", "見つかりませんでした", "前回の記録なし", "入力がおかしい", "当てはまる日なし"];

export function stepMark(step: Step): StepMark {
  switch (step.kind) {
    case "reject":
    case "limit":
      return "warn";
    case "hold":
    case "release":
    case "ask":
    case "todo":
    case "price":
      return "next";
    case "tool": {
      if (NOT_PASSED.some((w) => step.text.includes(w))) return "warn";
      // 受けられなかった後の「代わりを調べる」は、次にしたこと
      if (step.text.startsWith("代わりを調べる")) return "next";
      return "ok";
    }
    default:
      return "next";
  }
}
