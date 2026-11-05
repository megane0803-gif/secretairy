"use client";

import { useEffect, useSyncExternalStore } from "react";
import { LOOK_KEY, readBrowser, subscribeBrowser, writeBrowser } from "@/lib/browser";
import { DEFAULT_LOOK, LOOK_DESC, LOOK_LABEL, LOOKS, parseLook, type Look } from "@/lib/look";

const readLook = () => parseLook(readBrowser(LOOK_KEY));
const serverLook = () => DEFAULT_LOOK;

/**
 * 見た目を4つから選ぶ（スマート・夜・和紙・ポップ。docs/SPEC.md §3.5）。
 * 置くのはページの一番下の閉じた折りたたみの中だけ（「このタブの表示」、無いタブは「見た目」）。左の列には置かない。
 * withHead = 小見出し「見た目」を付ける（「このタブの表示」の中に置く時）。
 * 今のがどれかは ✓ と枠で見せる（色だけに頼らない）。ふつうのボタンなのでキーボードでも選べる。
 */
export function LookPicker({ withHead = false }: { withHead?: boolean }) {
  const look = useSyncExternalStore(subscribeBrowser, readLook, serverLook);

  // ほかの窓で選び直した時も、この画面の見た目を合わせる
  useEffect(() => {
    document.documentElement.dataset.look = look;
  }, [look]);

  const choose = (l: Look) => {
    document.documentElement.dataset.look = l;
    writeBrowser(LOOK_KEY, l);
  };

  return (
    <div className="look-picker" role="group" aria-label="見た目">
      {/* 「このタブの表示」の中では小見出しを付ける（折りたたみの題名が「見た目」の時は付けない） */}
      {withHead && <p className="look-picker-head">見た目</p>}
      <div className="look-picker-row">
        {LOOKS.map((l) => (
          <button key={l} type="button" className={l === look ? "look-btn on" : "look-btn"} aria-pressed={l === look} onClick={() => choose(l)}>
            <span className="look-btn-name">
              <span className="look-btn-mark" aria-hidden>
                {l === look ? "✓" : ""}
              </span>
              {LOOK_LABEL[l]}
            </span>
            <span className="look-btn-desc">{LOOK_DESC[l]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
