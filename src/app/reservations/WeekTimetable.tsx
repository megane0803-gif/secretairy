"use client";

// 1週間の予約台帳（時間割）。予約タブの真ん中の列の一番上に出す。PC は右の列の予約チャットと横に並び、
// スマホ（1024 より狭い時）も同じ部品（TimetableGrid）を画面の幅に詰めて出す（7日が横に動かずに収まる。見た目は globals.css）。
// PC で真ん中の列が狭い時は、台帳の箱（tt-wrap）の中だけ横に動かせる（ページは横にはみ出さない）。
// 日ごとのカード（LedgerDays）は、スマホだけ時間割の下に畳んで出す（「日ごとの一覧で見る」・最初は閉じる。PC は出さない）。
// 凡例・週の動かし方・確かめの一覧・起点の説明・「最初に戻す」は、この箱に1回だけ（カードの側には出さない）。
// 見ている週は、ページの共通の親（LedgerView.tsx）が持つ（日ごとのカード・月のカレンダーと同じ週）。並べ方は src/lib/book/timetable.ts、見た目は TimetableGrid。

import type { BookData } from "@/lib/book/data";
import { timetable } from "@/lib/book/timetable";
import { useBook } from "@/lib/book/useBook";
import { LedgerChecks, LedgerDays, LedgerNotes, LedgerReset } from "./Ledger";
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
        {/* 予約の帯を押すと、その予約の1枚（見る・取り消す・変える。ReservationSheet）。空いたマスを押すと「予約を入れる」1枚（台帳から入れる＝オーナーの確定。1枚はページの共通の親が持つ） */}
        <TimetableGrid
          tt={tt}
          onPick={(date, start) => view.act({ kind: "open", target: { date, start } })}
          onOpen={(id) => view.act({ kind: "detail", id })}
        />
      </div>
      {/* スマホだけ：日ごとのカード（最初は閉じる。PC は CSS で隠す） */}
      <details className="fold ledger-cards-fold">
        <summary>日ごとの一覧で見る</summary>
        <LedgerDays data={data} />
      </details>
      <LedgerChecks book={book} />
      <LedgerReset book={book} data={data} />
    </section>
  );
}
