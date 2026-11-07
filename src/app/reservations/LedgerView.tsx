"use client";

// 予約のページの共通の親：見ている週・月のカレンダーの月・開いている「台帳から入れる」の1枚を、ここ1つだけが持つ（docs/SPEC.md §1.3.1）。
// 時間割（WeekTimetable。PC もスマホも）・スマホの畳んだ日ごとのカード（Ledger.tsx の LedgerDays）・月のカレンダー（MonthCalendar）は、みなここから読む（いつも同じ週）。
// 数え方は src/lib/book/weekView.ts。見ている週はブラウザに残さない（開き直すと今日の週）。
// 「翌日へ」「最初に戻す」（印 epoch と実際に進んだ dayOffset が変わる）の後は、今日の週・月に戻し、開いている1枚を閉じる（月のカレンダーの「休みを決める」も切に戻す）。

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";
import {
  canStep,
  clampStart,
  freshView,
  monthOf,
  syncView,
  viewKey,
  viewRange,
  viewReduce,
  viewWeek,
  weekLabel,
  weekLabelShort,
  type SheetTarget,
  type ViewAction,
  type ViewDay,
  type ViewRange,
  type ViewState,
} from "@/lib/book/weekView";
import { scrollToId } from "@/lib/scroll";
import { HolidayFlowProvider } from "./HolidayFlow";
import { OwnerBookSheet } from "./OwnerBookSheet";
import { ReservationSheet } from "./ReservationSheet";

type LedgerViewValue = {
  range: ViewRange;
  /** 見せ始める日 */
  start: string;
  /** 「11/13（金）〜11/19（木）」 */
  label: string;
  /** スマホの台帳の上の「11月13日〜19日」 */
  shortLabel: string;
  days: ViewDay[];
  /** 今日の週を見ているか */
  atToday: boolean;
  canPrev: boolean;
  canNext: boolean;
  /** 月のカレンダーで出す月（YYYY-MM） */
  month: string;
  /** 月のカレンダーの「休みを決める」が入っているか（最初は切。開き直し・「翌日へ」・「最初に戻す」で切） */
  holidayMode: boolean;
  act: (a: ViewAction) => void;
  /** 日を押した：その日から7日の台帳へ移り、見えている台帳の日までスクロール */
  pickDay: (date: string) => void;
};

const Ctx = createContext<LedgerViewValue | null>(null);

export function useLedgerView(): LedgerViewValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("LedgerViewProvider の中で使ってください");
  return v;
}

export function LedgerViewProvider({ data, children }: { data: BookData; children: ReactNode }) {
  const book = useBook(data);
  const key = viewKey(book.state.epoch, book.dayOffset);
  const [raw, setRaw] = useState<ViewState>(() => freshView(key));
  // 「翌日へ」「最初に戻す」の後は、今日の週・月に戻し、開いている1枚を閉じる（描く途中で直す）
  const view = syncView(raw, key);
  if (view !== raw) setRaw(view);

  const range = useMemo(
    () => viewRange(book.shop, { todayDate: book.today.date, nowDate: book.now.date, all: book.all }),
    [book.shop, book.today.date, book.now.date, book.all],
  );
  // 仮押さえの期限が切れて範囲が縮んだ時も、ここで範囲の中へ戻る
  const start = clampStart(view.start ?? book.today.date, range);
  const days = useMemo(() => viewWeek(book.shop, book.today, book.all, start, range), [book.shop, book.today, book.all, start, range]);

  const act = useCallback(
    (a: ViewAction) => setRaw((s) => viewReduce(syncView(s, key), a, { todayDate: book.today.date, range })),
    [key, book.today.date, range],
  );
  const pickDay = useCallback(
    (date: string) => {
      act({ kind: "pick", date });
      // 見えている方の台帳（時間割。畳んだ日ごとのカードは開いている時だけ見える）の、その日まで動かす
      window.setTimeout(() => {
        const el = [document.getElementById(`tt-col-${date}`), document.getElementById(`ledger-day-${date}`)].find((x) => x && x.offsetParent !== null);
        el?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    },
    [act],
  );

  const value: LedgerViewValue = {
    range,
    start,
    label: weekLabel(book.shop, start),
    shortLabel: weekLabelShort(start),
    days,
    atToday: start === book.today.date,
    canPrev: canStep(start, -1, range),
    canNext: canStep(start, 1, range),
    month: view.month ?? monthOf(start),
    holidayMode: view.holidayMode === true,
    act,
    pickDay,
  };

  return (
    <Ctx.Provider value={value}>
      {/* 休みの日を決める流れ（月のカレンダーと休みの日の一覧が同じ物を使う。開いている一覧は同じ印 viewKey で閉じる） */}
      <HolidayFlowProvider data={data}>{children}</HolidayFlowProvider>
      {view.sheet && <OwnerBookSheet key={`${view.sheet.date} ${view.sheet.start}`} data={data} target={view.sheet} onClose={() => act({ kind: "close" })} />}
      {/* 予約を押して開く1枚。「翌日へ」「最初に戻す」（印 viewKey が変わる）で閉じる（syncView）。古い中身は保存しない（change.ts） */}
      {view.detail && (
        <ReservationSheet
          key={`${key} ${view.detail}`}
          data={data}
          id={view.detail}
          onClose={() => act({ kind: "close" })}
          onMoved={(date) => act({ kind: "pick", date })}
          onApprovals={() => {
            act({ kind: "close" });
            scrollToId("res-approvals");
          }}
        />
      )}
    </Ctx.Provider>
  );
}

/**
 * 台帳の上の「前の週」「今日」「次の週」と、見ている7日の範囲。
 * スマホは1行に「< 先週」「11月2日〜8日」「来週 >」（同じ動き。「今日」は今日の週でない時だけ下の行に）。PC は今までどおり。
 */
export function WeekNav() {
  const v = useLedgerView();
  return (
    <div className="week-nav" role="group" aria-label="見る週を動かす">
      <button type="button" className="btn week-nav-btn week-nav-prev" onClick={() => v.act({ kind: "step", dir: -1 })} disabled={!v.canPrev} aria-label="前の週">
        <span className="wk-pc">← 前の週</span>
        <span className="wk-sp" aria-hidden>
          &lt; 先週
        </span>
      </button>
      <button type="button" className="btn week-nav-btn week-nav-today" onClick={() => v.act({ kind: "today" })} disabled={v.atToday} aria-label="今日の週に戻る">
        今日
      </button>
      <button type="button" className="btn week-nav-btn week-nav-next" onClick={() => v.act({ kind: "step", dir: 1 })} disabled={!v.canNext} aria-label="次の週">
        <span className="wk-pc">次の週 →</span>
        <span className="wk-sp" aria-hidden>
          来週 &gt;
        </span>
      </button>
      <strong className="week-nav-label num" aria-live="polite">
        <span className="wk-pc">{v.label}</span>
        <span className="wk-sp">{v.shortLabel}</span>
      </strong>
    </div>
  );
}

export type { SheetTarget };
