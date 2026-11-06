"use client";

// ホームの真ん中（「AI に頼める仕事」と一番下の「くわしく」より上）。このブラウザの台帳・カルテから、プログラムが数えて並べる。
// 上から：朝の要点（数字3枚＋まずやる3つ。日付の横に「翌日へ」）・思いついたことを一言メモ・今日のお客様（前回の次回提案）・
// 今日の注意（AI。BriefNotes。気をつける点を数個まで・文だけ）・今日これから空いている時間。下の3つは畳める（RememberFold）。
// デモ用の「翌日へ」で今日を1営業日先へ（定休日は飛ばす）。押すと前日のお知らせ（デモ・送らない）を数字の下に見せる。
// 「最初に戻す」（ページの一番下）で本当の今日に戻る。

import { resolveMenu } from "@/lib/combo";
import { ActorTag, BigNumber, Checked, CustomerName, MiniBar, ProgramTag, SectionHead } from "@/components/parts";
import { RememberFold } from "@/components/RememberFold";
import type { BookData } from "@/lib/book/data";
import { advanceDay } from "@/lib/book/nextDay";
import { canNextDay, LAST_DEMO_DAY } from "@/lib/book/state";
import { useBook } from "@/lib/book/useBook";
import { calDay, realDayNote } from "@/lib/calendar";
import { latestBefore, nextLines } from "@/lib/karte/record";
import { writeJournal } from "@/lib/journal";
import type { Reminder } from "@/lib/reminder";
import { freeRanges } from "@/lib/reservations";
import { useApprovals } from "@/lib/useApprovals";
import type { BriefAiSettings, KarteHeading, ReminderSettings, TodoSettings } from "@/lib/settings";
import { useTodos } from "@/lib/todo/useTodos";
import { MemoThrow } from "@/components/MemoThrow";
import { TodoTop } from "@/components/TodoTop";
import { useState } from "react";
import { BriefNotes } from "./BriefNotes";
import { DayBeforeReminders } from "./DayBeforeReminders";

export function HomeSummary({
  data,
  headings,
  todo,
  reminder,
  brief,
}: {
  data: BookData;
  headings: KarteHeading[];
  /** まずやる N つ・「戻す」の秒数・メモの字数（config） */
  todo: TodoSettings & { maxMemoChars: number };
  /** 前日のお知らせの決まった形（config/reminder.json） */
  reminder: ReminderSettings;
  /** AI の一言の上限（config/ai.json の brief） */
  brief: Omit<BriefAiSettings, "model">;
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
  // 「翌日へ」で見せる前日のお知らせ（画面を開いている間だけ。本当には送らない）
  const [remind, setRemind] = useState<{ dayLabel: string; sentLabel: string; list: Reminder[] } | null>(null);

  const canNext = canNextDay(book.state);

  // 進めなかった時の1文（上限・ブラウザに書けなかった）
  const [nextNote, setNextNote] = useState<string | null>(null);

  const nextDay = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    // 書けて進んだ時だけ、前日のお知らせと日誌（book/nextDay.ts）。上限・書けなかった時は作らない
    const out = advanceDay({ update: book.update, journal: writeJournal }, { shop: book.shop, now: new Date(), all: book.all, template: reminder.template });
    if (!out.moved) {
      setNextNote(out.why === "write" ? out.message : null);
      return;
    }
    setNextNote(null);
    setRemind({ dayLabel: out.to.label, sentLabel: out.sentLabel, list: out.reminders });
  };

  return (
    <>
      <section className="home-morning" aria-labelledby="brief-morning">
        <SectionHead
          id="brief-morning"
          title={`朝の要点（${book.today.label}）`}
          tag={<ProgramTag />}
          aside={
            <>
              <button
                type="button"
                className="btn small"
                onClick={nextDay}
                disabled={!canNext}
                title={canNext ? "デモ用：今日を1営業日先へ進めます（定休日は飛ばす）" : LAST_DEMO_DAY}
              >
                翌日へ
              </button>
              <span className="tag text">デモ</span>
            </>
          }
          desc="今日の予約・承認待ち・ToDo の数を、プログラムが数えました"
        />
        {book.shifted && <p className="shifted">{book.opened.label}はお休みなので、次の営業日を「今日」にしています。</p>}
        {book.dayOffset > 0 && (
          <p className="shifted">
            デモ：「翌日へ」で {book.dayOffset} 営業日進めています（{book.today.label} の開店前 {book.now.time} のつもり）。{realDayNote(book)}。
          </p>
        )}
        {nextNote && (
          <p className="form-problem" role="status">
            {nextNote}
          </p>
        )}
        {!canNext && (
          <p className="shifted" role="status">
            {LAST_DEMO_DAY}（{book.dayOffset} 営業日）。「最初に戻す」で本当の今日に戻せます。
          </p>
        )}
        <div className="morning-wrap">
          <div className="morning-row">
            <div className="bignums home-bignums">
              <BigNumber label="今日の予約" value={book.book.todayCount} unit="件" />
              <BigNumber label="承認待ち" value={approvals.count} unit="件" />
              <BigNumber label="今日の ToDo" value={todos} unit="件" />
            </div>
            <section className="morning-top" aria-labelledby="brief-todo">
              <SectionHead
                id="brief-todo"
                level={3}
                title={`まずやる${todo.topCount}つ`}
                tag={<ProgramTag />}
                desc={`ToDo のタブと同じ並べ方の上から${todo.topCount}つ（お客様への連絡と、期限が近い物が先）。済んだら □ を押します`}
              />
              <TodoTop data={data} count={todo.topCount} undoSeconds={todo.undoSeconds} link checked={false} />
            </section>
          </div>
        </div>

        {remind && (
          <DayBeforeReminders
            reminders={remind.list}
            dayLabel={remind.dayLabel}
            sentLabel={remind.sentLabel}
            demoNote={reminder.demoNote}
            onClose={() => setRemind(null)}
          />
        )}
      </section>

      <section className="home-memo" aria-labelledby="brief-memo">
        <SectionHead
          id="brief-memo"
          title="思いついたことを一言メモ"
          tag={<ActorTag actor="human" />}
          desc="書いて送ると、ToDo の文にして足します（AI か、AI なしの決まった返事で）"
        />
        <MemoThrow data={data} maxChars={todo.maxMemoChars} label="思いついたことを一言メモ" hideLabel />
      </section>

      <RememberFold
        id="customers"
        className="brief"
        title="今日のお客様"
        tag={<ProgramTag />}
        count={`${todays.length}人`}
        desc="時間とメニュー、前回のカルテの「次回提案」"
      >
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
      </RememberFold>

      {/* 今日の注意（AI）。出せない時は欄ごと出さない。部品は畳んでも外さない */}
      <BriefNotes data={data} headings={headings} limits={brief} />

      <RememberFold
        id="free"
        className="brief"
        title="今日これから空いている時間"
        tag={<ProgramTag />}
        count={book.today.hours ? `${free.seatSlots}枠` : undefined}
        desc="これからの時間で、席に空きがある所"
      >
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
      </RememberFold>
    </>
  );
}
