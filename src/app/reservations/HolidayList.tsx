"use client";

// 休みの日の一覧（予約のページ。月のカレンダーの下）。オーナーが決めた休みの日を日付の順に並べ、それぞれ「戻す」を押せる。
// 新しく休みにするのは、月のカレンダーの「休みを決める」から（ここでは戻すだけ）。定休日の曜日は設定の物で、ここでは変えない。
// 戻す流れはカレンダーと同じ1か所（HolidayFlow.tsx・src/lib/book/holidayFlow.ts）。日誌に1行。休みにした時に足した ToDo は消さない。

import { calDay } from "@/lib/calendar";
import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";
import { reservationsOn } from "@/lib/holidays";
import { HolidayFlowBox, useHolidayFlow } from "./HolidayFlow";

export function HolidayList({ data }: { data: BookData }) {
  const book = useBook(data);
  const f = useHolidayFlow();

  return (
    <div className="holidays">
      <p className="hint">決めた日はこのブラウザの中だけに残り、「最初に戻す」で無くなります。定休日の曜日（設定）はここでは変えません。</p>
      {f.dates.length === 0 ? (
        <p className="hint holiday-empty">カレンダーの『休みを決める』で日を押すと休みになります</p>
      ) : (
        <ul className="holiday-rows">
          {f.dates.map((date) => {
            const label = calDay(data.shop, date).label;
            const n = reservationsOn(book.all, date).length;
            return (
              <li key={date}>
                <span className="num holiday-row-date">{label}</span>
                <span className="tag holiday-tag">休み</span>
                {n > 0 && <small className="holiday-left">予約 {n}件 が残っています</small>}
                <button type="button" className="btn small holiday-undo" onClick={(e) => f.press(e, date, "list")} aria-label={`${label}の休みを戻す`}>
                  戻す
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <HolidayFlowBox data={data} place="list" />
      <p className="hint">休みを戻しても、休みにした時に足した ToDo は残ります</p>
    </div>
  );
}
