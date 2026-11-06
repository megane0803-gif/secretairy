"use client";

// 1週間の予約台帳（PC）。予約タブの真ん中の列の一番上に、時間割の形で出す（右の列の予約チャットと横に並ぶ。スマホは日ごとのカード Ledger のまま）。
// 真ん中の列が狭い時は、台帳の箱（tt-wrap）の中だけ横に動かせる（ページは横にはみ出さない）。
// 見ている週は、ページの共通の親（LedgerView.tsx）が持つ（日ごとのカード・月のカレンダーと同じ週）。並べ方は src/lib/book/timetable.ts、見た目は TimetableGrid。

import type { BookData } from "@/lib/book/data";
import { timetable } from "@/lib/book/timetable";
import { useBook } from "@/lib/book/useBook";
import { LedgerChecks, LedgerNotes, LedgerReset } from "./Ledger";
import { useLedgerView, WeekNav } from "./LedgerView";
import { TimetableGrid } from "./TimetableGrid";

export function WeekTimetable({ data }: { data: BookData }) {
  const book = useBook(data);
  const view = useLedgerView();
  const tt = timetable(view.days, book.now, { seats: book.shop.seats, step: book.shop.slotMinutes });

  return (
    <section className="ledger ledger-timetable" aria-labelledby="res-timetable">
      <h2 id="res-timetable">1週間の予約台帳</h2>
      <LedgerNotes book={book} />
      <WeekNav />
      <div className="tt-wrap">
        {/* 空いたマスを押すと、小さな窓の「入れる」画面（台帳から入れる＝オーナーの確定。1枚はページの共通の親が持つ） */}
        <TimetableGrid tt={tt} onPick={(date, start) => view.act({ kind: "open", target: { date, start } })} />
      </div>
      <LedgerChecks book={book} />
      <LedgerReset book={book} data={data} />
    </section>
  );
}
