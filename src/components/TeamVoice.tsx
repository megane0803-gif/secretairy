"use client";

// AI のチームの小さいカード1枚（広告の案の会議と、発信の下書きの会議で同じ形と色。docs/SPEC.md §1.7.4・§1.10.1）。
// 色は §3.4：Claude の役 = AI の青緑・リサーチャー（プログラム）と決まった返事（AI なし）= プログラムの灰色。
// ここは見た目だけ。役の中身（指示・流れ・門）はそれぞれのチームが持つ。

import { ActorTag } from "./parts";

export function TeamVoice({
  name,
  desc,
  ai,
  programTag,
  children,
}: {
  name: string;
  desc: string;
  /** Claude が答えた役か（青緑）。false はプログラムの灰色 */
  ai: boolean;
  /** 灰色の時の札（「プログラム」「AI なし」など） */
  programTag: string;
  children: React.ReactNode;
}) {
  return (
    <article className={`voice ${ai ? "voice-ai" : "voice-program"}`} aria-label={`${name}＝${desc}`}>
      <header className="voice-head">
        <strong>{name}</strong>
        <span className="voice-desc">＝{desc}</span>
        {ai ? <ActorTag actor="ai" /> : <span className="tag who-program">{programTag}</span>}
      </header>
      {children}
    </article>
  );
}
