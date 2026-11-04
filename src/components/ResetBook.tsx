"use client";

// 「最初に戻す」：本当の今日を起点に作り直す（予約チャットの仮押さえ・承認の箱・足した ToDo・保存したカルテ・「翌日へ」も消える。日誌には残す）。
// 台帳（予約タブ）と朝の要点（ホーム）の両方に置く。

import { useState } from "react";
import type { BookData } from "@/lib/book/data";
import { emptyBook } from "@/lib/book/state";
import { useBook } from "@/lib/book/useBook";
import { writeJournal } from "@/lib/journal";

export function ResetBook({ data }: { data: BookData }) {
  const book = useBook(data);
  const [asking, setAsking] = useState(false);

  const resetAll = () => {
    book.update(() => emptyBook(book.realToday.date));
    writeJournal({
      who: "オーナー",
      text: `最初に戻した：${book.realToday.label}を起点に、予約・仮押さえ・承認の箱・足した ToDo・保存したカルテ・「翌日へ」を作り直した`,
    });
    setAsking(false);
  };

  return asking ? (
    <span className="rule-buttons" role="group" aria-label="最初に戻すかどうか">
      <span>本当の今日を起点に作り直します。仮押さえ・承認の箱・足した ToDo・保存したカルテも消えます。</span>
      <button type="button" className="btn danger" onClick={resetAll}>
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
