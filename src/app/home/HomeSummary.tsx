"use client";

import { BigNumber } from "@/components/parts";
import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";

/** 朝の要点の数（今日の予約・承認待ち・今日の ToDo）。このブラウザの台帳から数える */
export function HomeSummary({ data, seedTodos }: { data: BookData; seedTodos: number }) {
  const book = useBook(data);
  const todos = seedTodos + book.state.todos.filter((t) => !t.done).length;
  return (
    <>
      <h2>朝の要点（{book.today.label}）</h2>
      {book.shifted && <p className="shifted">{book.opened.label}はお休みなので、次の営業日を「今日」にしています。</p>}
      <div className="bignums">
        <BigNumber label="今日の予約" value={book.book.todayCount} unit="件" />
        <BigNumber label="承認待ち" value={book.pending.length} unit="件" />
        <BigNumber label="今日の ToDo" value={todos} unit="件" />
      </div>
    </>
  );
}
