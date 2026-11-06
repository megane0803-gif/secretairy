"use client";

// 経理：右の列（スマホではページの上）の「あと N件 選ぶ」と、真ん中の「人が選ぶ」の所をつなぐリンク。
// 押すと「人が選ぶ N件」の見出しまで画面を動かす（リンクの形なので、JavaScript が動かない時も飛べる）。

import type { ReactNode } from "react";
import { scrollToId } from "@/lib/scroll";

/** 真ん中の「人が選ぶ N件」の見出しの id */
export const ACCT_CHOOSE_ID = "acct-choose";

export function ChooseLink({ children }: { children: ReactNode }) {
  return (
    <a
      href={`#${ACCT_CHOOSE_ID}`}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        scrollToId(ACCT_CHOOSE_ID, { hash: true });
      }}
    >
      {children}
    </a>
  );
}
