"use client";

// 休みの日を決める流れの、画面で使う形（月のカレンダーの「休みを決める」と、休みの日の一覧の「戻す」の両方がここを通る。同じ物を2つ作らない）。
// 決め方と書き方は src/lib/book/holidayFlow.ts の1か所（範囲・定休日・上限・予約がある日の一覧・ToDo・日誌・書けなかった時）。
// 開いている一覧と知らせはこの親が1つだけ持ち、「翌日へ」「最初に戻す」（印 viewKey が変わる）で閉じる（syncHolidayFlow）。
// 決めた休みの日はこのブラウザの中だけ（holidays.ts）。予約チャット・台帳・予約サイト・LINE・AI の仕事の判定に次からすぐ効く。

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { CustomerName } from "@/components/parts";
import { calDay } from "@/lib/calendar";
import type { BookData } from "@/lib/book/data";
import { applyHoliday, freshHolidayFlow, holidayPress, syncHolidayFlow, type HolidayFlowState, type HolidayPlace } from "@/lib/book/holidayFlow";
import { useBook } from "@/lib/book/useBook";
import { viewKey } from "@/lib/book/weekView";
import { writeJournal } from "@/lib/journal";
import { useHolidays } from "@/lib/useHolidays";

type HolidayFlowValue = {
  /** オーナーが決めた休みの日（古い順） */
  dates: string[];
  ask: HolidayFlowState["ask"];
  note: HolidayFlowState["note"];
  /** 人が日を押した（カレンダーからは休みにする・戻す。一覧からは戻すだけ）。人が押した時（isTrusted）だけ動かす */
  press: (e: React.MouseEvent, date: string, from: HolidayPlace) => void;
  /** 一覧の「それでも休みにする」 */
  confirm: (e: React.MouseEvent) => void;
  /** 一覧を閉じる（「やめる」・「休みを決める」を切った時） */
  cancel: () => void;
};

const Ctx = createContext<HolidayFlowValue | null>(null);

export function useHolidayFlow(): HolidayFlowValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("HolidayFlowProvider の中で使ってください");
  return v;
}

export function HolidayFlowProvider({ data, children }: { data: BookData; children: ReactNode }) {
  const book = useBook(data);
  const { dates, setHoliday } = useHolidays();
  const key = viewKey(book.state.epoch, book.dayOffset);
  const [raw, setRaw] = useState<HolidayFlowState>(() => freshHolidayFlow(key));
  // 「翌日へ」「最初に戻す」の後は、開いている一覧と知らせを閉じる（描く途中で直す）
  const flow = syncHolidayFlow(raw, key);
  if (flow !== raw) setRaw(flow);

  const run = useCallback(
    (date: string, on: boolean, from: HolidayPlace, fromAsk: boolean) => {
      const ask = fromAsk ? flow.ask : null;
      const out = applyHoliday(
        { setHoliday, update: book.update, journal: (e) => writeJournal(e) },
        {
          shop: book.shop,
          state: book.state,
          dates,
          date,
          on,
          list: ask?.list ?? [],
          ask,
          nowIso: new Date().toISOString(),
          todayDate: book.today.date,
        },
      );
      setRaw((s) => {
        const cur = syncHolidayFlow(s, key);
        return { ...cur, ask: out.close ? null : cur.ask, note: out.note ? { place: from, text: out.note } : null };
      });
    },
    [flow.ask, setHoliday, book.update, book.shop, book.state, book.today.date, dates, key],
  );

  const press = useCallback(
    (e: React.MouseEvent, date: string, from: HolidayPlace) => {
      if (!e.nativeEvent.isTrusted) return;
      const p = holidayPress({ shop: book.shop, nowDate: book.now.date, dates, all: book.all, date, epoch: book.state.epoch }, from);
      // 予約がある日は、まず一覧を出す（「それでも休みにする」を押した時だけ休みにする）
      if (p.kind === "ask") return setRaw((s) => ({ ...syncHolidayFlow(s, key), ask: p.ask, note: null }));
      if (p.kind === "blocked") return setRaw((s) => ({ ...syncHolidayFlow(s, key), note: { place: from, text: p.note } }));
      run(date, p.on, from, false);
    },
    [book.shop, book.now.date, book.all, book.state.epoch, dates, key, run],
  );

  const confirm = useCallback(
    (e: React.MouseEvent) => {
      if (!e.nativeEvent.isTrusted || !flow.ask) return;
      run(flow.ask.date, true, "calendar", true);
    },
    [flow.ask, run],
  );

  const cancel = useCallback(() => setRaw((s) => ({ ...syncHolidayFlow(s, key), ask: null })), [key]);

  return <Ctx.Provider value={{ dates, ask: flow.ask, note: flow.note, press, confirm, cancel }}>{children}</Ctx.Provider>;
}

/** 予約がある日の一覧（「それでも休みにする」「やめる」）と、押した方の近くの知らせ */
export function HolidayFlowBox({ data, place }: { data: BookData; place: HolidayPlace }) {
  const f = useHolidayFlow();
  const ask = place === "calendar" ? f.ask : null;
  const note = f.note?.place === place ? f.note.text : null;
  if (!ask && !note) return null;
  return (
    <>
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
                {r.menu.name} <CustomerName surname={r.customer.surname} />
                <span className={r.status === "hold" ? "tag hold" : "tag ok"}>{r.status === "hold" ? "仮押さえ" : "確定"}</span>
              </li>
            ))}
          </ul>
          <div className="form-buttons">
            <button type="button" className="btn primary" onClick={f.confirm}>
              それでも休みにする
            </button>
            <button type="button" className="btn" onClick={f.cancel}>
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
    </>
  );
}
