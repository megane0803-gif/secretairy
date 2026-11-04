"use client";

// 「最初に戻す」：このブラウザの変化を1回で全部最初に戻す（src/lib/reset.ts）。
// 予約は本当の今日を起点に作り直し（仮押さえ・承認の箱・足した ToDo・保存したカルテ・「翌日へ」も消える）、
// 広告（案・止めた／外した言葉）と経理（選んだ印・登録・足した自動のルール）、カルテの施術メモ・案、発信の下書き（保存した物も）、
// LINE の預かり（届けた印・サーバーに預けてある知らせ。つなぎは残す）も戻す。日誌には残す。
// 台帳（予約タブ）と朝の要点（ホーム）の両方に置く。

import { useState } from "react";
import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";
import { writeJournal } from "@/lib/journal";
import { lineApi } from "@/lib/line/useLine";
import { getLineSettings } from "@/lib/settings";
import { resetAll } from "@/lib/reset";

export function ResetBook({ data }: { data: BookData }) {
  const book = useBook(data);
  const [asking, setAsking] = useState(false);

  const onReset = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    const { lineToken } = resetAll(book.realToday.date);
    writeJournal({
      who: "オーナー",
      text: `最初に戻した：${book.realToday.label}を起点に、予約・仮押さえ・承認の箱・足した ToDo（済みの印も）・保存したカルテ・カルテのメモと案・「翌日へ」を作り直し、広告と経理（自動のルールも）・発信の下書き・「AI の仕事」の済みの印${lineToken ? "・LINE の預かり" : ""}を最初に戻した`,
    });
    setAsking(false);
    // サーバーに預けてある LINE の知らせ（まだ受け取っていない物）も消す。つなぎは残す
    if (lineToken)
      void lineApi.clear(lineToken).then((r) => {
        if (!r.ok) writeJournal({ who: "プログラム", text: `LINE の預かり物を消せなかった（${Math.ceil(getLineSettings().inboxSeconds / 60)}分で自然に消えます）` });
      });
  };

  return asking ? (
    <span className="rule-buttons" role="group" aria-label="最初に戻すかどうか">
      <span>本当の今日を起点に作り直します。仮押さえ・承認の箱・ToDo（足した物・済みの印）・保存したカルテ・カルテのメモ・広告・経理（足した自動のルールも）・保存した発信の下書き・「AI の仕事」（4行とも「これから」に）・LINE の預かりも最初に戻ります（LINE のつなぎは残します）。</span>
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
