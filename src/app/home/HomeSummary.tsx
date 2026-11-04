"use client";

// 朝の要点（並べるだけ。AI の文章はまだ）。このブラウザの台帳・カルテから、プログラムが数えて並べる。
// 今日の予約・そのお客様の前回メモ（次回提案）・今日の空き枠。
// デモ用の「翌日へ」で今日を1営業日先へ（定休日は飛ばす）。「最初に戻す」で本当の今日に戻る。

import { resolveMenu } from "@/lib/combo";
import { BigNumber, Checked, CustomerName, MiniBar } from "@/components/parts";
import { ResetBook } from "@/components/ResetBook";
import type { BookData } from "@/lib/book/data";
import { withNextDay } from "@/lib/book/state";
import { useBook } from "@/lib/book/useBook";
import { businessDayAt, calDay } from "@/lib/calendar";
import { latestBefore, nextLines } from "@/lib/karte/record";
import { writeJournal } from "@/lib/journal";
import { freeRanges } from "@/lib/reservations";
import { useApprovals } from "@/lib/useApprovals";
import type { KarteHeading, TodoSettings } from "@/lib/settings";
import { useTodos } from "@/lib/todo/useTodos";
import { MemoThrow } from "@/components/MemoThrow";
import { TodoTop } from "@/components/TodoTop";

export function HomeSummary({
  data,
  headings,
  todo,
}: {
  data: BookData;
  headings: KarteHeading[];
  /** 今やる N 件・「戻す」の秒数・メモの字数（config） */
  todo: TodoSettings & { maxMemoChars: number };
}) {
  const book = useBook(data);
  // 承認待ちは承認の箱の行と同じ数（approvals.ts）
  const approvals = useApprovals();
  // 今日の ToDo：ToDo のタブと同じ一覧から（期限の先の物＝広告の「効いたか見る」などは、その日まで今日の数に入れない）
  const todos = useTodos(data).todayCount;
  const todays = book.all.filter((r) => r.date === book.today.date);
  const menuName = (id: string) => resolveMenu(data.menus, id)?.name ?? id;
  // 今日のこれからの空き（いまの時刻より前の枠は数えない）
  const free = freeRanges(book.shop, book.today, book.all, book.now.date === book.today.date ? book.now.time : undefined);
  const day = book.book.week.find((d) => d.date === book.today.date);

  const nextDay = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    const to = businessDayAt(data.shop, book.today, 1);
    book.update(withNextDay);
    writeJournal({ who: "オーナー", text: `デモ：翌日へ（${book.today.label} → ${to?.label ?? "次の営業日"}。定休日は飛ばす）` });
  };

  return (
    <>
      <h2>朝の要点（{book.today.label}）</h2>
      {book.shifted && <p className="shifted">{book.opened.label}はお休みなので、次の営業日を「今日」にしています。</p>}
      {book.dayOffset > 0 && (
        <p className="shifted">
          デモ：「翌日へ」で {book.dayOffset} 営業日進めています（{book.today.label} の開店前 {book.now.time} のつもり）。本当の今日は {book.realToday.label} です。
        </p>
      )}
      <div className="bignums">
        <BigNumber label="今日の予約" value={book.book.todayCount} unit="件" />
        <BigNumber label="承認待ち" value={approvals.count} unit="件" />
        <BigNumber label="今日の ToDo" value={todos} unit="件" />
      </div>

      <section className="brief" aria-labelledby="brief-todo">
        <h3 id="brief-todo">今やる{todo.topCount}件</h3>
        <TodoTop data={data} count={todo.topCount} undoSeconds={todo.undoSeconds} link />
        <MemoThrow data={data} maxChars={todo.maxMemoChars} />
      </section>

      <section className="brief" aria-labelledby="brief-res">
        <h3 id="brief-res">今日の予約と、前回のメモ（次回提案）</h3>
        {todays.length === 0 ? (
          <p className="empty">今日の予約はありません。</p>
        ) : (
          <ol className="brief-list">
            {todays.map((r) => {
              const prev = latestBefore(book.kartes, r.customer.id, book.today.date);
              const lines = prev ? nextLines(prev, headings) : [];
              return (
                <li key={r.id} className={r.status === "hold" ? "brief-item hold" : "brief-item"}>
                  <div className="brief-head">
                    <span className="num brief-time">
                      {r.start}
                      <small>–{r.end}</small>
                    </span>
                    <CustomerName surname={r.customer.surname} fictional={r.customer.fictional} />
                    <strong>{r.menu.name}</strong>
                    {r.status === "hold" && <span className="tag hold">仮押さえ</span>}
                    {r.customer.firstVisit && <span className="slot-first">初めての方</span>}
                  </div>
                  {prev ? (
                    <div className="brief-prev">
                      <span className="hint">
                        前回 {calDay(data.shop, prev.date).label} {menuName(prev.menuId)} の次回提案：
                      </span>
                      {lines.length ? (
                        <ul>
                          {lines.map((l, i) => (
                            <li key={i}>・{l}</li>
                          ))}
                        </ul>
                      ) : (
                        <span>（次回提案は空でした）</span>
                      )}
                    </div>
                  ) : (
                    <p className="brief-prev hint">前回の記録なし</p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className="brief" aria-labelledby="brief-free">
        <h3 id="brief-free">今日の空き枠（これから）</h3>
        {!book.today.hours ? (
          <p className="empty">今日はお休みです。</p>
        ) : (
          <>
            <div className="bignums">
              <BigNumber label={`空き（${data.shop.slotMinutes}分 × ${book.shop.seats}人）`} value={free.seatSlots} unit="枠" />
            </div>
            {day && <MiniBar value={day.usedMinutes} max={day.capacityMinutes} label="今日の埋まり" />}
            {free.ranges.length === 0 ? (
              <p className="empty">これからの空きはありません。</p>
            ) : (
              <ul className="brief-free">
                {free.ranges.map((f) => (
                  <li key={f.start}>
                    <span className="num">
                      {f.start}–{f.end}
                    </span>{" "}
                    空き <strong className="num">{f.free}</strong> 席
                  </li>
                ))}
              </ul>
            )}
            <Checked>台帳（確定・仮押さえ）と同じ時間に受ける人数（{book.shop.seats}人）からプログラムが数えました</Checked>
            <p className="hint">メニューやルール（何分前まで など）で受けられるかは、予約チャットで確かめます。</p>
          </>
        )}
      </section>

      <div className="reset-row">
        <span className="hint">デモ用：今日を1営業日先へ進めます（定休日は飛ばす）。</span>
        <button type="button" className="btn small" onClick={nextDay}>
          翌日へ
        </button>
        <ResetBook data={data} />
      </div>
    </>
  );
}
