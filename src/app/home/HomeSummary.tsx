"use client";

// ホームの真ん中（「AI に頼める仕事」と一番下の「くわしく」より上）。このブラウザの台帳・カルテから、プログラムが数えて並べる。
// 上から：朝の要点（数字4枚（押すと中身へ）＋まずやる3つ。日付の横に「翌日へ」）・思いついたことを一言メモ・今日のお客様（前回の次回提案）・
// 今日の注意（AI。BriefNotes。気をつける点を数個まで・文だけ）・今日これから空いている時間。下の3つは畳める（RememberFold）。
// デモ用の「翌日へ」で今日を1営業日先へ（定休日は飛ばす）。押すと前日のお知らせ（デモ・送らない）を数字の下に見せる。
// 「最初に戻す」（ページの一番下）で本当の今日に戻る。

import { resolveMenu } from "@/lib/combo";
import { ActorTag, BigNumber, Checked, CustomerName, MiniBar, ProgramTag, SectionHead } from "@/components/parts";
import { RememberFold } from "@/components/RememberFold";
import type { BookData } from "@/lib/book/data";
import { withNextDay } from "@/lib/book/state";
import { useBook } from "@/lib/book/useBook";
import { addDays, businessDayAt, calDay } from "@/lib/calendar";
import { latestBefore, nextLines } from "@/lib/karte/record";
import { writeJournal } from "@/lib/journal";
import { dayBeforeReminders, type Reminder } from "@/lib/reminder";
import { freeRanges } from "@/lib/reservations";
import { useApprovals } from "@/lib/useApprovals";
import type { BriefAiSettings, KarteHeading, ReminderSettings, TodoSettings } from "@/lib/settings";
import { useTodos } from "@/lib/todo/useTodos";
import { JumpLink } from "@/components/JumpLink";
import { MemoThrow } from "@/components/MemoThrow";
import { TABS } from "@/lib/tabs";
import Link from "next/link";
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
  // ToDo の期限の数：ToDo のタブと同じ一覧・同じ数え方から（items.ts の todoDueCounts）。期限の無い物（メモ・次回など）は数えない。
  // 今日まで＝期限が今日、期限切れ＝期限が今日より前（お客様への連絡で過ぎた物も入る）。先の日の物は入れない
  const due = useTodos(data).dueCounts;
  const todays = book.all.filter((r) => r.date === book.today.date);
  const menuName = (id: string) => resolveMenu(data.menus, id)?.name ?? id;
  // 今日のこれからの空き（いまの時刻より前の枠は数えない）
  const free = freeRanges(book.shop, book.today, book.all, book.now.date === book.today.date ? book.now.time : undefined);
  const day = book.book.week.find((d) => d.date === book.today.date);
  // 「翌日へ」で見せる前日のお知らせ（画面を開いている間だけ。本当には送らない）
  const [remind, setRemind] = useState<{ dayLabel: string; sentLabel: string; list: Reminder[] } | null>(null);

  const nextDay = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    const to = businessDayAt(data.shop, book.today, 1);
    book.update(withNextDay);
    // その日（進めた先の今日）に確定の予約がある方へ、前日に届いたつもりのお知らせ（決まった形・AI なし・送らない）
    const list = to ? dayBeforeReminders(book.all, to.date, reminder.template, data.shop.name) : [];
    if (to) setRemind({ dayLabel: to.label, sentLabel: calDay(data.shop, addDays(to.date, -1)).label, list });
    writeJournal(
      { who: "オーナー", text: `デモ：翌日へ（${book.today.label} → ${to?.label ?? "次の営業日"}。定休日は飛ばす）` },
      ...(to ? [{ who: "プログラム" as const, text: `デモ：前日のお知らせを${list.length}件見せた（${to.label}のご予約。決まった形・実際には送信していない）` }] : []),
    );
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
              <button type="button" className="btn small" onClick={nextDay} title="デモ用：今日を1営業日先へ進めます（定休日は飛ばす）">
                翌日へ
              </button>
              <span className="tag text">デモ</span>
            </>
          }
          desc="今日の予約・承認待ち・期限のある ToDo（今日まで＝期限が今日、期限切れ＝今日より前）を、プログラムが数えました。押すと中身へ"
        />
        {book.shifted && <p className="shifted">{book.opened.label}はお休みなので、次の営業日を「今日」にしています。</p>}
        {book.dayOffset > 0 && (
          <p className="shifted">
            デモ：「翌日へ」で {book.dayOffset} 営業日進めています（{book.today.label} の開店前 {book.now.time} のつもり）。本当の今日は {book.realToday.label} です。
          </p>
        )}
        <div className="morning-wrap">
          <div className="morning-row">
            {/* 数字のカードは押せる：今日の予約 → 今日のお客様（閉じていれば開く）・承認待ち → 承認の箱・ToDo → ToDo のタブ */}
            <div className="bignums home-bignums">
              <JumpLink to="customers" className="bignum-link" title="今日のお客様を見る">
                <BigNumber label="今日の予約" value={book.book.todayCount} unit="件" go="↓" />
              </JumpLink>
              <JumpLink to="approvals" className="bignum-link" title="承認の箱を見る">
                <BigNumber label="承認待ち" value={approvals.count} unit="件" go="↓" />
              </JumpLink>
              <Link href={TABS.todo.path} className="bignum-link" title="ToDo のタブで見る（期限が今日の物）">
                <BigNumber label="ToDo 今日まで" value={due.dueToday} unit="件" go="→" />
              </Link>
              <Link href={TABS.todo.path} className="bignum-link" title="ToDo のタブで見る（期限が今日より前の物）">
                <BigNumber label="ToDo 期限切れ" value={due.overdue} unit="件" go="→" />
              </Link>
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
        anchor="customers"
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
