"use client";

// 1週間の予約台帳（真ん中）。最初の状態に、このブラウザの仮押さえ・確定を重ねて出す。
// 仮押さえと確定は色で分ける。数（件数・埋まり）はプログラムが出す。

import { Checked, CustomerName, MiniBar, WhoMark } from "@/components/parts";
import { reservationWho } from "@/lib/who";
import { ResetBook } from "@/components/ResetBook";
import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";

export function Ledger({ data }: { data: BookData }) {
  const book = useBook(data);
  const holds = book.all.filter((r) => r.status === "hold").length;

  return (
    <section className="ledger">
      <h2>1週間の予約台帳</h2>
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
      <p className="legend">
        <span className="legend-item confirmed">確定</span>
        <span className="legend-item hold">仮押さえ（承認待ち）</span>
        <span className="hint">
          <WhoMark who="ai" />＝AI が仮押さえ・<WhoMark who="human" />＝人が承認で確定・<WhoMark who="outside" />＝お客様からの予約
        </span>
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
                        <WhoMark {...reservationWho(r)} />
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

      <div className="reset-row">
        <span className="hint">
          起点：{book.anchor.label}（このブラウザで初めて開いた日）。架空の予約はこの日から数えて置いています。
        </span>
        <ResetBook data={data} />
      </div>
    </section>
  );
}
