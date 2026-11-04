"use client";

// 1週間の予約台帳（真ん中）。最初の状態に、このブラウザの仮押さえ・確定を重ねて出す。
// 仮押さえと確定は色で分ける。数（件数・埋まり）はプログラムが出す。

import { useState } from "react";
import { Checked, CustomerName, MiniBar } from "@/components/parts";
import type { BookData } from "@/lib/book/data";
import { emptyBook } from "@/lib/book/state";
import { useBook } from "@/lib/book/useBook";
import { writeJournal } from "@/lib/journal";

export function Ledger({ data }: { data: BookData }) {
  const book = useBook(data);
  const [asking, setAsking] = useState(false);
  const holds = book.all.filter((r) => r.status === "hold").length;

  const resetAll = () => {
    book.update(() => emptyBook(book.today.date));
    writeJournal({ who: "オーナー", text: `最初に戻した：${book.today.label}を起点に、予約・仮押さえ・承認の箱・足した ToDo を作り直した` });
    setAsking(false);
  };

  return (
    <section className="ledger">
      <h2>1週間の予約台帳</h2>
      {book.shifted && (
        <p className="shifted">
          {book.opened.label}はお休みなので、次の営業日 {book.today.label} を「今日」にしています。
        </p>
      )}
      <p className="legend">
        <span className="legend-item confirmed">確定</span>
        <span className="legend-item hold">仮押さえ（承認待ち）</span>
        {holds > 0 && (
          <span className="hint">
            仮押さえ <strong className="num">{holds}</strong> 件
          </span>
        )}
      </p>
      <div className="week-wrap">
        <ol className="week">
          {book.book.week.map((d) => (
            <li key={d.date} className={["day", d.open ? "" : "closed", d.isToday ? "today" : ""].join(" ").trim()}>
              <div className="day-head">
                <span className="day-date">{d.label}</span>
                {d.isToday && <span className="tag">今日</span>}
              </div>
              {!d.hours ? (
                <span className="day-hours">お休み</span>
              ) : (
                <>
                  <span className="day-count">
                    <strong className="num">{d.reservations.length}</strong> 件
                  </span>
                  <MiniBar value={d.usedMinutes} max={d.capacityMinutes} label="埋まり" />
                  <span className="day-hours">
                    {d.hours.open}–{d.hours.close}
                  </span>
                  <ul className="slots">
                    {d.reservations.map((r) => (
                      <li key={r.id} className={r.status === "hold" ? "slot hold" : r.source === "chat" ? "slot confirmed fresh" : "slot confirmed"}>
                        <span className="slot-time num">
                          {r.start}
                          <small>–{r.end}</small>
                        </span>
                        <span className="slot-menu">
                          {r.menu.name}
                          {r.status === "hold" && <span className="tag hold">仮押さえ</span>}
                          {r.status === "confirmed" && r.source === "chat" && <span className="tag ok">承認で確定</span>}
                        </span>
                        <CustomerName surname={r.customer.surname} fictional={r.customer.fictional} />
                        {r.customer.firstVisit && <span className="slot-first">初めての方</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </li>
          ))}
        </ol>
      </div>

      <div className="checks">
        {book.book.checks.seats.ok ? (
          <Checked>どの時間も、席の数（{data.shop.seats}席）をこえていません（仮押さえも数えます）</Checked>
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

      <div className="reset-row">
        <span className="hint">
          起点：{book.anchor.label}（このブラウザで初めて開いた日）。架空の予約はこの日から数えて置いています。
        </span>
        {asking ? (
          <span className="rule-buttons" role="group" aria-label="最初に戻すかどうか">
            <span>今日を起点に作り直します。仮押さえ・承認の箱・足した ToDo も消えます。</span>
            <button type="button" className="btn danger" onClick={resetAll}>
              最初に戻す
            </button>
            <button type="button" className="btn" onClick={() => setAsking(false)}>
              やめる
            </button>
          </span>
        ) : (
          <button type="button" className="btn small" onClick={() => setAsking(true)}>
            最初に戻す
          </button>
        )}
      </div>
    </section>
  );
}
