"use client";

// 月のカレンダー（台帳の近く）。日ごとに件数と埋まり（プログラムの数。台帳と同じ ledgerDay）・定休日と休みの日・仮押さえの印。
// 「前の月」「次の月」で月を動かす（台帳は動かさない）。日を押すと、その日から7日の台帳へ移る（見ている週はページの共通の親 LedgerView が持つ）。
// 範囲（weekView.ts の viewRange）の外の日は薄く、押せない。
// 上の「休みを決める」を入れている間は、日を押すとその日を休みにする・戻す（流れは休みの日の一覧と同じ1か所 HolidayFlow.tsx・holidayFlow.ts）。
//   押せるのは休みにできる範囲（book.now.date を含めて aheadDays 日。台帳で見られる範囲とは別）の、設定の定休日でない日だけ。切りかえは共通の親が持つ（開き直し・「翌日へ」・「最初に戻す」で切）。
// 下に週ごとの件数と埋まり（その7日の埋まっている分の合計 ÷ 受けられる分の合計）。

import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";
import { holidayWindow, monthDayAction, type HolidayDay } from "@/lib/book/holidayFlow";
import { canMonth, fillPercent, monthGrid, weekSummaries, type MonthCell } from "@/lib/book/weekView";
import { calDay } from "@/lib/calendar";
import { HolidayFlowBox, useHolidayFlow } from "./HolidayFlow";
import { useLedgerView } from "./LedgerView";

const HEAD = ["日", "月", "火", "水", "木", "金", "土"];

/** 「休みを決める」の時に、押すと何が起きるか（読み上げの文） */
const PICK_SAY: Record<HolidayDay, string> = {
  off: "。押すと休みの日にします",
  on: "。押すと休みを戻します",
  weekly: "。定休日（店の設定）はここでは変えません",
  outside: "。休みにできる範囲の外です",
};

function cellLabel(c: MonthCell, title: string, pick: HolidayDay | null): string {
  const fill = fillPercent(c.usedMinutes, c.capacityMinutes);
  const state = c.holiday ? "休みの日" : c.closed ? "定休日" : `埋まり ${fill ?? 0}%`;
  const act = pick ? PICK_SAY[pick] : c.inRange ? "。押すとこの日からの台帳を見ます" : "。見られる範囲の外です";
  return `${title.replace(/年.*$/, "年")}${c.date.slice(5, 7).replace(/^0/, "")}月${c.day}日：予約 ${c.count}件${c.holds ? `（仮押さえ ${c.holds}件）` : ""}・${state}${
    c.closed && c.count ? "・お休みの日に予約が残っています" : ""
  }${act}`;
}

export function MonthCalendar({ data }: { data: BookData }) {
  const book = useBook(data);
  const view = useLedgerView();
  const flow = useHolidayFlow();
  const picking = view.holidayMode;
  const win = holidayWindow(book.shop, book.now.date);
  const grid = monthGrid(book.shop, view.month, { todayDate: book.today.date, all: book.all, range: view.range, viewStart: view.start });
  const monthStart = `${view.month}-01`;
  const monthEnd = `${view.month}-31`;
  const weeks = weekSummaries(book.shop, { today: book.today, all: book.all, range: view.range }).filter((w) => w.end >= monthStart && w.start <= monthEnd);

  return (
    <div className={picking ? "month-cal picking" : "month-cal"}>
      <div className="month-mode">
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            checked={picking}
            onChange={(e) => {
              view.act({ kind: "holidayMode", on: e.target.checked });
              // 切ったら、開いている一覧も閉じる
              if (!e.target.checked) flow.cancel();
            }}
            aria-label="休みを決める（入れている間は、日を押すとその日を休みにする・戻す）"
          />
          <span className="switch-track" aria-hidden>
            <span className="switch-knob" />
          </span>
          <span className="switch-text">休みを決める</span>
        </label>
        {picking && (
          <p className="month-mode-note">
            日を押すと休みになり、もう一度押すと戻ります（{calDay(book.shop, win.first).label}〜{calDay(book.shop, win.last).label}の{win.days}日。定休日は押せません）
          </p>
        )}
      </div>
      <div className="month-nav" role="group" aria-label="月を動かす（台帳は動かしません）">
        <button type="button" className="btn small month-btn" onClick={() => view.act({ kind: "month", dir: -1 })} disabled={!canMonth(view.month, -1, view.range)}>
          ← 前の月
        </button>
        <strong className="month-title num">
          {grid.title}
          {picking && <span className="month-title-mode">休みを決める</span>}
        </strong>
        <button type="button" className="btn small month-btn" onClick={() => view.act({ kind: "month", dir: 1 })} disabled={!canMonth(view.month, 1, view.range)}>
          次の月 →
        </button>
      </div>
      <table
        className="month-grid"
        aria-label={picking ? `${grid.title}：休みを決める（日を押すと、その日を休みにする・戻す）` : `${grid.title}の予約（日を押すと、その日からの台帳を見ます）`}
      >
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
                // 「休みを決める」の時は、休みにできる範囲（台帳で見られる範囲とは別）と設定の定休日で押せるかを決める
                const a = monthDayAction(picking, { shop: book.shop, nowDate: book.now.date, dates: flow.dates, date: c.date, inViewRange: c.inRange });
                const pick = a.act === "holiday" ? a.day : null;
                const cls = [
                  "month-cell",
                  (pick ? pick === "outside" : !c.inRange) ? "outside" : "",
                  pick && a.enabled ? "pickable" : "",
                  c.inView ? "in-view" : "",
                  c.isToday ? "today" : "",
                  c.closed ? "closed" : "",
                  c.holiday ? "holiday" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <td key={c.date} className={cls}>
                    <button
                      type="button"
                      className="month-day"
                      onClick={(e) => (a.act === "holiday" ? flow.press(e, c.date, "calendar") : view.pickDay(c.date))}
                      disabled={!a.enabled}
                      aria-pressed={pick && a.enabled ? pick === "on" : undefined}
                      aria-label={cellLabel(c, grid.title, pick)}
                      aria-current={c.isToday ? "date" : undefined}
                    >
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
      {/* 予約がある日を休みにする時の一覧（休みの日の一覧と同じ流れ）と知らせ */}
      <HolidayFlowBox data={data} place="calendar" />
      <p className="hint month-legend">
        数字の下は件数（確定と仮押さえ）と埋まり。<span className="month-hold">仮</span> 仮押さえがある日　<span className="holiday-mark">休み</span> 休みの日（上の「休みを決める」を入れて日を押すと休みにする・戻す）　定休 定休日　! お休みの日に予約が残っている　太い枠 いま台帳で見ている7日
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
