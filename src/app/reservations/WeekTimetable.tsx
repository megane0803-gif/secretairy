"use client";

// 1週間の予約台帳（PC）。予約タブの一番上に横いっぱいで、時間割の形で出す（スマホは日ごとのカード Ledger のまま）。
// 中身は日ごとのカードと同じ台帳（useBook）。並べ方は src/lib/book/timetable.ts、見た目は TimetableGrid。

import type { BookData } from "@/lib/book/data";
import { timetable } from "@/lib/book/timetable";
import { useBook } from "@/lib/book/useBook";
import { LedgerChecks, LedgerNotes, LedgerReset } from "./Ledger";
import { TimetableGrid } from "./TimetableGrid";

export function WeekTimetable({ data }: { data: BookData }) {
  const book = useBook(data);
  const tt = timetable(book.book.week, book.now);

  return (
    <section className="ledger ledger-timetable" aria-labelledby="res-timetable">
      <h2 id="res-timetable">1週間の予約台帳</h2>
      <LedgerNotes book={book} />
      <div className="tt-wrap">
        <TimetableGrid tt={tt} />
      </div>
      <LedgerChecks book={book} />
      <LedgerReset book={book} data={data} />
    </section>
  );
}
