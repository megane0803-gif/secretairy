"use client";

// 月のカレンダー（台帳の近く。見るだけ）。日ごとに件数と埋まり（プログラムの数。台帳と同じ ledgerDay）・定休日と休みの日・仮押さえの印。
// 「前の月」「次の月」で月を動かす（台帳は動かさない）。日を押すと、その日から7日の台帳へ移る（見ている週はページの共通の親 LedgerView が持つ）。
// 範囲（weekView.ts の viewRange）の外の日は薄く、押せない。休みにする・戻すは「休みの日」の欄で（ここは見るだけ）。
// 下に週ごとの件数と埋まり（その7日の埋まっている分の合計 ÷ 受けられる分の合計）。

import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";
import { canMonth, fillPercent, monthGrid, weekSummaries, type MonthCell } from "@/lib/book/weekView";
import { useLedgerView } from "./LedgerView";

const HEAD = ["日", "月", "火", "水", "木", "金", "土"];

function cellLabel(c: MonthCell, title: string): string {
  const fill = fillPercent(c.usedMinutes, c.capacityMinutes);
  const state = c.holiday ? "休みの日" : c.closed ? "定休日" : `埋まり ${fill ?? 0}%`;
  return `${title.replace(/年.*$/, "年")}${c.date.slice(5, 7).replace(/^0/, "")}月${c.day}日：予約 ${c.count}件${c.holds ? `（仮押さえ ${c.holds}件）` : ""}・${state}${
    c.closed && c.count ? "・お休みの日に予約が残っています" : ""
  }${c.inRange ? "。押すとこの日からの台帳を見ます" : "。見られる範囲の外です"}`;
}

export function MonthCalendar({ data }: { data: BookData }) {
  const book = useBook(data);
  const view = useLedgerView();
  const grid = monthGrid(book.shop, view.month, { todayDate: book.today.date, all: book.all, range: view.range, viewStart: view.start });
  const monthStart = `${view.month}-01`;
  const monthEnd = `${view.month}-31`;
  const weeks = weekSummaries(book.shop, { today: book.today, all: book.all, range: view.range }).filter((w) => w.end >= monthStart && w.start <= monthEnd);

  return (
    <div className="month-cal">
      <div className="month-nav" role="group" aria-label="月を動かす（台帳は動かしません）">
        <button type="button" className="btn small month-btn" onClick={() => view.act({ kind: "month", dir: -1 })} disabled={!canMonth(view.month, -1, view.range)}>
          ← 前の月
        </button>
        <strong className="month-title num">{grid.title}</strong>
        <button type="button" className="btn small month-btn" onClick={() => view.act({ kind: "month", dir: 1 })} disabled={!canMonth(view.month, 1, view.range)}>
          次の月 →
        </button>
      </div>
      <table className="month-grid" aria-label={`${grid.title}の予約（日を押すと、その日からの台帳を見ます）`}>
        <thead>
          <tr>
            {HEAD.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.weeks.map((row) => (
            <tr key={row[0].date}>
              {row.map((c) => {
                if (!c.inMonth) return <td key={c.date} className="month-cell blank" aria-hidden />;
                const fill = fillPercent(c.usedMinutes, c.capacityMinutes);
                const cls = [
                  "month-cell",
                  c.inRange ? "" : "outside",
                  c.inView ? "in-view" : "",
                  c.isToday ? "today" : "",
                  c.closed ? "closed" : "",
                  c.holiday ? "holiday" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <td key={c.date} className={cls}>
                    <button type="button" className="month-day" onClick={() => view.pickDay(c.date)} disabled={!c.inRange} aria-label={cellLabel(c, grid.title)} aria-current={c.isToday ? "date" : undefined}>
                      <span className="month-num num">{c.day}</span>
                      {c.holiday ? (
                        <small className="month-mark holiday-mark">休み</small>
                      ) : c.closed ? (
                        <small className="month-mark">定休</small>
                      ) : null}
                      {c.count > 0 && (
                        <small className={c.closed ? "month-count warn" : "month-count"}>
                          {c.closed && <span aria-hidden>! </span>}
                          <span className="num">{c.count}</span>件{c.holds > 0 && <span className="month-hold" aria-hidden>仮</span>}
                        </small>
                      )}
                      {!c.closed && <small className="month-fill num">{fill === null ? "—" : `${fill}%`}</small>}
                      {c.closed && <small className="month-fill">—</small>}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint month-legend">
        数字の下は件数（確定と仮押さえ）と埋まり。<span className="month-hold">仮</span> 仮押さえがある日　<span className="holiday-mark">休み</span> 休みの日（休みの日の欄で決める）　定休 定休日　! お休みの日に予約が残っている　太い枠 いま台帳で見ている7日
      </p>
      {weeks.length > 0 && (
        <ul className="week-sums" aria-label="週ごとの件数と埋まり">
          {weeks.map((w) => (
            <li key={w.start} className="num">
              {w.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
