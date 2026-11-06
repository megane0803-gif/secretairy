"use client";

// 1週間の予約台帳（PC）。予約タブの真ん中の列の一番上に、時間割の形で出す（右の列の予約チャットと横に並ぶ。スマホは日ごとのカード Ledger のまま）。
// 真ん中の列が狭い時は、台帳の箱（tt-wrap）の中だけ横に動かせる（ページは横にはみ出さない）。
// 中身は日ごとのカードと同じ台帳（useBook）。並べ方は src/lib/book/timetable.ts、見た目は TimetableGrid。

import type { BookData } from "@/lib/book/data";
import { timetable } from "@/lib/book/timetable";
import { useBook } from "@/lib/book/useBook";
import { LedgerChecks, LedgerNotes, LedgerReset } from "./Ledger";
import { TimetableGrid } from "./TimetableGrid";
import { useState } from "react";
import { OwnerBookSheet, type SheetTarget } from "./OwnerBookSheet";

export function WeekTimetable({ data }: { data: BookData }) {
  const book = useBook(data);
  const tt = timetable(book.book.week, book.now, { seats: book.shop.seats, step: book.shop.slotMinutes });
  // 空いたマスを押すと、小さな窓の「入れる」画面（台帳から入れる＝オーナーの確定）
  const [sheet, setSheet] = useState<SheetTarget | null>(null);

  return (
    <section className="ledger ledger-timetable" aria-labelledby="res-timetable">
      <h2 id="res-timetable">1週間の予約台帳</h2>
      <LedgerNotes book={book} />
      <div className="tt-wrap">
        <TimetableGrid tt={tt} onPick={(date, start) => setSheet({ date, start })} />
      </div>
      <LedgerChecks book={book} />
      <LedgerReset book={book} data={data} />
      {sheet && <OwnerBookSheet data={data} target={sheet} onClose={() => setSheet(null)} />}
    </section>
  );
}
