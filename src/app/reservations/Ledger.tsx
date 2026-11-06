"use client";

// 1週間の予約台帳（真ん中）。最初の状態に、このブラウザの仮押さえ・確定を重ねて出す。
// 仮押さえと確定は形で分ける（仮押さえ = 点線としま模様）。数（件数・埋まり）はプログラムが出す。
// 色はメニュー（薄い背景＋左の太い線。src/lib/book/menuColor.ts）。だれが入れたか（仮押さえ = AI・承認で確定と店が受けた確定 = 人・
// 予約サイト（架空）から = 外。src/lib/actors.ts）は色ではなく、「AI」「人」「外」の札だけで見せる。

import { ActorTag, Checked, CustomerName, MiniBar } from "@/components/parts";
import { reservationActor } from "@/lib/actors";
import { ResetBook } from "@/components/ResetBook";
import type { BookData } from "@/lib/book/data";
import { menuColorClass, menuLegend } from "@/lib/book/menuColor";
import { useBook } from "@/lib/book/useBook";
import { OWNER_TAG } from "@/lib/book/owner";
import { freeRanges, type LedgerDay, type Reservation } from "@/lib/reservations";
import { useState } from "react";
import { OwnerBookSheet, type SheetTarget } from "./OwnerBookSheet";

type Book = ReturnType<typeof useBook>;

/**
 * 1週間の予約台帳（日ごとのカード）。予約タブではスマホで出す（PC は真ん中の列の一番上の時間割 WeekTimetable）。
 * className で、どの幅で出すかを決める（予約タブは "ledger-cards"）。
 */
export function Ledger({ data, className }: { data: BookData; className?: string }) {
  const book = useBook(data);
  // 空いている時間を押すと、下から1枚の「入れる」画面（台帳から入れる＝オーナーの確定）
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const onPick = (date: string, start: string) => setSheet({ date, start });

  return (
    <section className={["ledger", className].filter(Boolean).join(" ")}>
      <h2>1週間の予約台帳</h2>
      <LedgerNotes book={book} />
      <div className="week-wrap">
        <ol className="week">
          {book.book.week.map((d) => (
            <li key={d.date} className={["day", d.open ? "" : "closed", d.isToday ? "today" : ""].join(" ").trim()}>
              <div className="day-head">
                <span className="day-date">{d.label}</span>
                {d.isToday && <span className="tag">今日</span>}
              </div>
              {!d.hours ? (
                <>
                  <span className="day-hours">{d.holiday ? "休みの日" : "お休み"}</span>
                  {/* 休みにした日に残った予約も隠さない（消さずに残し、ToDo で別の日時を案内する） */}
                  {d.reservations.length > 0 && (
                    <>
                      <p className="problems small">✗ お休みの日に残っている予約 {d.reservations.length}件（お客様に別の日時を案内してください）</p>
                      <SlotList list={d.reservations} />
                    </>
                  )}
                </>
              ) : (
                <>
                  <span className="day-count">
                    <strong className="num">{d.reservations.length}</strong> 件
                  </span>
                  <MiniBar value={d.usedMinutes} max={d.capacityMinutes} label="埋まり" />
                  <span className="day-hours">
                    {d.hours.open}–{d.hours.close}
                  </span>
                  <SlotList list={d.reservations} />
                  <FreeTimes book={book} day={d} onPick={onPick} />
                </>
              )}
            </li>
          ))}
        </ol>
      </div>

      <LedgerChecks book={book} />
      <LedgerReset book={book} data={data} />
      {sheet && <OwnerBookSheet data={data} target={sheet} onClose={() => setSheet(null)} />}
    </section>
  );
}

/** 1日の予約の行（日ごとのカード） */
function SlotList({ list }: { list: Reservation[] }) {
  return (
    <ul className="slots">
      {list.map((r) => (
        <li
          key={r.id}
          className={`${r.status === "hold" ? "slot hold" : r.source === "chat" ? "slot confirmed fresh" : r.source === "site" ? "slot confirmed from-site" : "slot confirmed"} ${menuColorClass(r.menu)}`}
        >
          <ActorTag actor={reservationActor(r)} />
          <span className="slot-time num">
            {r.start}
            <small>–{r.end}</small>
          </span>
          <span className="slot-menu">
            {r.menu.name}
            {r.status === "hold" && <span className="tag hold">仮押さえ</span>}
            {r.status === "confirmed" && r.source === "chat" && <span className="tag ok">承認で確定</span>}
            {r.source === "site" && <span className="tag from-site">予約サイトから</span>}
            {r.source === "owner" && <span className="tag owner">{OWNER_TAG}</span>}
          </span>
          <CustomerName surname={r.customer.surname} fictional={r.customer.fictional} />
          {r.customer.firstVisit && <span className="tag first">初めての方</span>}
        </li>
      ))}
    </ul>
  );
}

/** 日ごとのカードの「空いている時間」（押すと下から入れる画面が出る。book/owner.ts の freeStarts） */
function FreeTimes({ book, day, onPick }: { book: Book; day: LedgerDay; onPick: (date: string, start: string) => void }) {
  const ranges = freeRanges(book.shop, day, book.all, book.now.date === day.date ? book.now.time : undefined).ranges.filter(
    (r) => day.date >= book.now.date,
  );
  if (ranges.length === 0) return null;
  return (
    <div className="free-times">
      <span className="hint">空いている時間（押すと入れられます）</span>
      <div className="free-times-row">
        {ranges.map((r) => (
          <button key={r.start} type="button" className="btn small free-time" onClick={() => onPick(day.date, r.start)} aria-label={`${day.label} ${r.start}から空いています。予約を入れる`}>
            <span className="num">{r.start}</span>–<span className="num">{r.end}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** 「翌日へ」で進めた時・お休みの日に開いた時の一言と、凡例（メニューの色・札の意味） */
export function LedgerNotes({ book }: { book: Book }) {
  const holds = book.all.filter((r) => r.status === "hold").length;
  const menus = menuLegend(book.data.menus);
  return (
    <>
      {book.dayOffset > 0 && (
        <p className="shifted">
          デモ：「翌日へ」で {book.today.label} を「今日」にしています（「最初に戻す」で本当の今日に戻ります）。
        </p>
      )}
      {book.shifted && (
        <p className="shifted">
          {book.opened.label}はお休みなので、次の営業日 {book.today.label} を「今日」にしています。
        </p>
      )}
      <p className="legend legend-menus" aria-label="帯の色（メニュー）">
        {menus.map((m) => (
          <span key={m.id} className={`legend-menu menu-c-${m.color}`}>
            {m.name}
          </span>
        ))}
      </p>
      <p className="legend" aria-label="帯の頭の札（だれが入れたか）と形">
        <span className="legend-item confirmed actor-human">
          <ActorTag actor="human" /> 確定（店が受けた予約・承認で確定）
        </span>
        <span className="legend-item confirmed actor-outside">
          <ActorTag actor="outside" /> 確定（予約サイトから）
        </span>
        <span className="legend-item hold actor-ai">
          <ActorTag actor="ai" /> 仮押さえ（承認待ち・点線としま模様）
        </span>
        {holds > 0 && (
          <span className="hint">
            仮押さえ <strong className="num">{holds}</strong> 件
          </span>
        )}
      </p>
    </>
  );
}

/** プログラムが確かめたこと（同じ時間に受ける人数・営業時間） */
export function LedgerChecks({ book }: { book: Book }) {
  return (
    <div className="checks">
      {book.book.checks.seats.ok ? (
        <Checked>どの時間も、同じ時間に受ける人数（{book.shop.seats}人）をこえていません（仮押さえも数えます）</Checked>
      ) : (
        <ul className="problems">
          {book.book.checks.seats.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {book.book.checks.hours.ok ? (
        <Checked>どの予約も、営業時間の中で最終受付までに始まります</Checked>
      ) : (
        <ul className="problems">
          {book.book.checks.hours.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 起点の日と「最初に戻す」 */
export function LedgerReset({ book, data }: { book: Book; data: BookData }) {
  return (
    <div className="reset-row">
      <span className="hint">
        起点：{book.anchor.label}（このブラウザで初めて開いた日）。架空の予約はこの日から数えて置いています。
      </span>
      <ResetBook data={data} />
    </div>
  );
}
