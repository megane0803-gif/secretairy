"use client";

// 同じページの欄へ飛ぶリンク（ホームの数字のカード・AI の仕事の「承認待ち1件」）。
// 飛ぶ先が畳める欄なら先に開き（ブラウザに覚える開け閉めと同じ印）、開いて描き直した後に、その欄まで画面を動かす。
// リンクの形（href="#…"）なので、読み上げ・キーボード・JavaScript が動かない時も飛べる。

import type { ReactNode } from "react";
import { HOME_JUMPS, type HomeJumpId } from "@/lib/home/jump";
import { openHomeFold } from "@/lib/home/useHomeFolds";
import { scrollToId } from "@/lib/scroll";

/** その欄まで動かす（畳んでいれば開いてから） */
export function jumpTo(id: HomeJumpId): void {
  const j = HOME_JUMPS[id];
  if (j.fold) openHomeFold(j.fold);
  scrollToId(j.target, { hash: true });
}

export function JumpLink({ to, className, title, children }: { to: HomeJumpId; className?: string; title?: string; children: ReactNode }) {
  return (
    <a
      href={`#${HOME_JUMPS[to].target}`}
      className={className}
      title={title}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        jumpTo(to);
      }}
    >
      {children}
    </a>
  );
}
