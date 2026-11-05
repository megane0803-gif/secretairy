"use client";

// ホームの畳める欄（題名＋だれの札＋数＋題名の下の1行）。見出しの行を押すと開く・閉じる（▶ ▼。ボタンなのでキーボードでも）。
// 開け閉めは見る人のブラウザに欄ごとに覚える（src/lib/home/）。覚えた物があれば、PC／スマホの最初の状態より先に使う。
// 閉じても中身の部品は取り外さない（見えなくするだけ）。中で AI を呼ぶ部品・動いている途中の印が消えないように。
// 最初の描画（まだ幅も覚えた物も読めない間）は、globals.css が PC／スマホの最初の状態で見せ分ける（data-pc・data-sp）。
// ほかのタブの Fold（parts.tsx）は今のまま。

import { useId, type ReactNode } from "react";
import { defaultFoldOpen, deviceOfWidth, type HomeFoldId } from "@/lib/home/folds";
import { useHomeFold } from "@/lib/home/useHomeFolds";

export function RememberFold({
  id,
  title,
  tag,
  count,
  desc,
  aside,
  className,
  anchor,
  children,
}: {
  id: HomeFoldId;
  title: string;
  /** だれの欄かの札（parts.tsx の札）。無い欄は渡さない */
  tag?: ReactNode;
  /** 閉じていても分かる中身の数（「4人」「12行」）。無い欄は渡さない */
  count?: ReactNode;
  /** 題名の下の1行 */
  desc?: ReactNode;
  /** 見出しの行の右に出す物（押しても開け閉めしない。「AI の仕事」の表示スイッチ） */
  aside?: ReactNode;
  /** 右の列の箱にするときは "panel" */
  className?: string;
  /** 外から飛んでくる時の id（#line など） */
  anchor?: string;
  children: ReactNode;
}) {
  const uid = useId();
  const { open, set } = useHomeFold(id);
  const bodyId = `${uid}-body`;
  const state = open === null ? "auto" : open ? "open" : "closed";
  return (
    <section
      className={`rfold${className ? ` ${className}` : ""}`}
      id={anchor}
      data-fold={id}
      data-state={state}
      data-pc={defaultFoldOpen(id, "pc") ? "open" : "closed"}
      data-sp={defaultFoldOpen(id, "phone") ? "open" : "closed"}
    >
      <div className="rfold-head">
        <h2 className="rfold-title">
          <button
            type="button"
            className="rfold-toggle"
            aria-expanded={open ?? undefined}
            aria-controls={bodyId}
            onClick={() => set(!(open ?? defaultFoldOpen(id, deviceOfWidth(window.innerWidth))))}
          >
            <span className="rfold-mark" aria-hidden />
            <span className="rfold-name">{title}</span>
            {tag}
            {count != null && count !== "" && <span className="rfold-count num">{count}</span>}
          </button>
        </h2>
        {aside && <span className="rfold-aside">{aside}</span>}
      </div>
      {desc && <p className="section-desc">{desc}</p>}
      <div id={bodyId} className="rfold-body" hidden={open === false}>
        {children}
      </div>
    </section>
  );
}
