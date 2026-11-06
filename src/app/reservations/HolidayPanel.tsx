"use client";

// 休みの日の欄（予約のページ）。これから先の日を押して、休みにする・戻す（定休日の曜日は設定の物で、ここでは変えない）。
// 決めた休みの日はこのブラウザの中だけ（holidays.ts）。予約チャット・台帳・予約サイト・LINE・AI の仕事の判定に次からすぐ効く。
// 予約（確定・仮押さえ）がある日は、休みにする前にその予約を一覧で出し、もう一度押した時だけ休みにする。
// 予約は消さない。お客様ごとに ToDo「別の日時を案内」を足し、日誌に1行（src/lib/book/holiday.ts）。

import { useState } from "react";
import { CustomerName } from "@/components/parts";
import { calDay } from "@/lib/calendar";
import type { BookData } from "@/lib/book/data";
import { holidayTodos, withHolidayTodos } from "@/lib/book/holiday";
import { useBook } from "@/lib/book/useBook";
import { holidayChoices, holidayJournal, holidayLimitsOf, reservationsOn } from "@/lib/holidays";
import { writeJournal } from "@/lib/journal";
import { SAVE_FAILED_MESSAGE } from "@/lib/browser";
import { sameEpoch } from "@/lib/book/state";
import type { Reservation } from "@/lib/reservations";
import { useHolidays } from "@/lib/useHolidays";

/** 最初に見せる日数（その先は「もっと先を見る」） */
const FIRST = 14;

export function HolidayPanel({ data }: { data: BookData }) {
  const book = useBook(data);
  const { dates, setHoliday } = useHolidays();
  // epoch = 一覧を出した時の「最初に戻す」の印（その後に戻されたら使わない）
  const [ask, setAsk] = useState<{ date: string; list: Reservation[]; epoch?: string } | null>(null);
  const [more, setMore] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const limits = holidayLimitsOf(data.shop);

  // 今日（「翌日へ」で進めた日。休みにした今日も戻せるよう、休みを重ねる前の日付）から
  const from = calDay(book.shop, book.now.date);
  const days = holidayChoices(book.shop, from);
  const shown = more ? days : days.slice(0, FIRST);

  const apply = (date: string, on: boolean, list: Reservation[]) => {
    const label = calDay(data.shop, date).label;
    // 一覧を見せた後に「最初に戻す」が押されていたら、その一覧は使わない（直しA の形）
    if (ask && !sameEpoch(book.state, ask.epoch)) {
      setAsk(null);
      setNote("最初に戻したので、さっきの一覧は使いません。もう一度日を押してください");
      return;
    }
    const w = setHoliday(date, on);
    if (!w) {
      setNote(on && dates.length >= limits.max ? `休みの日は ${limits.max}日までです` : null);
      return;
    }
    // 書けなかった時は「休みにした」と言わない（日誌・ToDo も作らない）
    if (!w.ok) return setNote(SAVE_FAILED_MESSAGE);
    let added: string[] = [];
    let todoNote = "";
    if (on && list.length) {
      const todos = holidayTodos(list, new Date().toISOString(), book.today.date);
      const tw = book.update((s) => {
        const o = withHolidayTodos(s, todos);
        added = o.added;
        return o.state;
      });
      if (!tw.ok) {
        added = [];
        todoNote = `（ToDo は${SAVE_FAILED_MESSAGE.replace(/。.*$/, "")}。手で足してください）`;
      }
    }
    writeJournal({ who: "オーナー", text: holidayJournal(label, on, on ? list.length : 0) });
    setAsk(null);
    setNote(
      on
        ? `${label}を休みの日にしました${list.length ? `。予約 ${list.length}件は残し、ToDo を${added.length}件足しました${todoNote}` : ""}`
        : `${label}を戻しました（また予約を受けられます）`,
    );
  };

  const press = (e: React.MouseEvent, date: string) => {
    if (!e.nativeEvent.isTrusted) return;
    const on = !dates.includes(date);
    const list = on ? reservationsOn(book.all, date) : [];
    // 予約がある日は、まず一覧を出す（もう一度押した時だけ休みにする）
    if (on && list.length) return setAsk({ date, list, epoch: book.state.epoch });
    apply(date, on, []);
  };

  return (
    <div className="holidays">
      <p className="hint">
        日を押すと休みの日になり、もう一度押すと戻ります。定休日の曜日（設定）はここでは変えません。決めた日はこのブラウザの中だけに残り、「最初に戻す」で無くなります。
      </p>
      <ul className="holiday-grid">
        {shown.map((d) => {
          const on = dates.includes(d.date);
          const n = reservationsOn(book.all, d.date).length;
          return (
            <li key={d.date}>
              {d.weekly ? (
                <span className="holiday-day weekly" aria-label={`${d.label}：定休日`}>
                  <span className="num">{d.label}</span>
                  <small>定休日</small>
                </span>
              ) : (
                <button
                  type="button"
                  className={on ? "holiday-day on" : "holiday-day"}
                  aria-pressed={on}
                  onClick={(e) => press(e, d.date)}
                  aria-label={`${d.label}：${on ? "休みの日（押すと戻す）" : "営業日（押すと休みにする）"}${n ? `。予約 ${n}件` : ""}`}
                >
                  <span className="num">{d.label}</span>
                  <small>{on ? "休み" : "営業"}{n ? `・予約${n}件` : ""}</small>
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {days.length > FIRST && (
        <button type="button" className="btn small holiday-more" onClick={() => setMore((x) => !x)}>
          {more ? "近い日だけにする" : `もっと先を見る（${days.length}日先まで）`}
        </button>
      )}

      {ask && (
        <div className="holiday-ask" role="alertdialog" aria-label="予約がある日を休みにする">
          <p className="problems">
            {calDay(data.shop, ask.date).label}には予約が {ask.list.length}件 あります。休みにしても予約は消しません（お客様ごとに ToDo「別の日時を案内」を足します）。
          </p>
          <ul className="holiday-list">
            {ask.list.map((r) => (
              <li key={r.id}>
                <span className="num">
                  {r.start}–{r.end}
                </span>{" "}
                {r.menu.name} <CustomerName surname={r.customer.surname} fictional={r.customer.fictional} />
                <span className={r.status === "hold" ? "tag hold" : "tag ok"}>{r.status === "hold" ? "仮押さえ" : "確定"}</span>
              </li>
            ))}
          </ul>
          <div className="form-buttons">
            <button
              type="button"
              className="btn primary"
              onClick={(e) => {
                if (e.nativeEvent.isTrusted) apply(ask.date, true, ask.list);
              }}
            >
              それでも休みにする
            </button>
            <button type="button" className="btn" onClick={() => setAsk(null)}>
              やめる
            </button>
          </div>
        </div>
      )}
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
      {dates.length > 0 && (
        <p className="hint">
          休みの日：{dates.map((d) => calDay(data.shop, d).label).join("・")}
        </p>
      )}
    </div>
  );
}
