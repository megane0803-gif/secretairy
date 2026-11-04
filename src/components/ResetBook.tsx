"use client";

// 「最初に戻す」：このブラウザの変化を1回で全部最初に戻す（src/lib/reset.ts）。
// 予約は本当の今日を起点に作り直し（仮押さえ・承認の箱・足した ToDo・保存したカルテ・「翌日へ」も消える）、
// 広告（案・止めた／外した言葉）と経理（選んだ印・登録・足した自動のルール）も消す。日誌には残す。
// 台帳（予約タブ）と朝の要点（ホーム）の両方に置く。

import { useState } from "react";
import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";
import { writeJournal } from "@/lib/journal";
import { resetAll } from "@/lib/reset";

export function ResetBook({ data }: { data: BookData }) {
  const book = useBook(data);
  const [asking, setAsking] = useState(false);

  const onReset = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    resetAll(book.realToday.date);
    writeJournal({
      who: "オーナー",
      text: `最初に戻した：${book.realToday.label}を起点に、予約・仮押さえ・承認の箱・足した ToDo・保存したカルテ・「翌日へ」を作り直し、広告と経理（自動のルールも）を最初に戻した`,
    });
    setAsking(false);
  };

  return asking ? (
    <span className="rule-buttons" role="group" aria-label="最初に戻すかどうか">
      <span>本当の今日を起点に作り直します。仮押さえ・承認の箱・足した ToDo・保存したカルテ・広告・経理（足した自動のルールも）も最初に戻ります。</span>
      <button type="button" className="btn danger" onClick={onReset}>
        最初に戻す
      </button>
      <button type="button" className="btn" onClick={() => setAsking(false)}>
        やめる
      </button>
    </span>
  ) : (
    <button type="button" className="btn small" onClick={() => setAsking(true)}>
      最初に戻す
    </button>
  );
}
