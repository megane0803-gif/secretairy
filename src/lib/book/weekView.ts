// 台帳で見る週と月（先の週・前の週・月のカレンダー。docs/SPEC.md §1.3.1）。ここは数え方だけ（画面に依らない・どこにも書かない）。
// 見ている週は、仕事の「今日」（book.today）・いまの時刻（book.now）とは別の物。動かしても今日・数え方・承認の箱は変わらない。
//
// 範囲：
//   先 … 休みの日の欄と同じ数え方で、book.now.date を含めて holidayLimits.aheadDays 日（56日 = 55日後まで）。
//        その先に、これから先の有効な予約（確定と、期限の切れていない仮押さえ）があれば、その日まで（隠さない）。
//   前 … 今日（book.today）から4週前まで（過ぎた日は見るだけ）。
// 週は7日ずつ動かす。端の週も7列のまま（範囲の外の列は薄く、新しく入れられない）。範囲の最初と最後の日は飛ばさない。

import { addDays, calDay, dayDiff, type CalDay } from "../calendar";
import { holidayLimitsOf } from "../holidays";
import { ledgerDay, type LedgerDay, type Reservation } from "../reservations";
import type { ShopSettings } from "../settings";

/** 前は何週まで見られるか */
export const BACK_WEEKS = 4;

export type ViewRange = {
  /** 見られる最初の日（YYYY-MM-DD） */
  first: string;
  /** 見られる最後の日 */
  last: string;
  /** 先の決まった数え方での最後の日（book.now.date を含めて aheadDays 日） */
  aheadLast: string;
};

/** 見られる範囲。all = 画面の台帳の全部（確定と、期限の切れていない仮押さえ。useBook の all） */
export function viewRange(
  shop: Pick<ShopSettings, "holidayLimits">,
  input: { todayDate: string; nowDate: string; all: Pick<Reservation, "date">[] },
): ViewRange {
  const first = addDays(input.todayDate, -7 * BACK_WEEKS);
  const aheadLast = addDays(input.nowDate, holidayLimitsOf(shop).aheadDays - 1);
  // これから先の有効な予約が範囲の先にあれば、その日まで見られるようにする
  const future = input.all.map((r) => r.date).filter((d) => d >= input.nowDate);
  const latest = future.length ? future.reduce((a, b) => (a > b ? a : b)) : aheadLast;
  return { first, last: latest > aheadLast ? latest : aheadLast, aheadLast };
}

export const inRange = (date: string, r: ViewRange): boolean => date >= r.first && date <= r.last;

/** 見せ始める日を範囲の中へ（仮押さえの期限が切れて範囲が縮んだ時も、ここで中へ戻る） */
export function clampStart(start: string, r: ViewRange): string {
  return start < r.first ? r.first : start > r.last ? r.last : start;
}

/** 「前の週」「次の週」を押せるか（範囲の最初の日・最後の日が、もう見えていれば押せない） */
export function canStep(start: string, dir: -1 | 1, r: ViewRange): boolean {
  return dir < 0 ? start > r.first : addDays(start, 6) < r.last;
}

/**
 * 7日動かす。範囲の最初と最後の日を飛ばさない：
 * 前へ … 7日前が範囲の前に出るなら、範囲の最初の日から（その間の日はみな見える）
 * 次へ … 7日後は、いま見えている最後の日の次の日なので飛ばない（最後の日が見えていれば押せない）
 */
export function stepWeek(start: string, dir: -1 | 1, r: ViewRange): string {
  if (!canStep(start, dir, r)) return clampStart(start, r);
  return clampStart(addDays(start, 7 * dir), r);
}

/** 「11/13（金）〜11/19（木）」 */
export function weekLabel(shop: ShopSettings, start: string): string {
  return `${calDay(shop, start).label}〜${calDay(shop, addDays(start, 6)).label}`;
}

/** 台帳で見せる1日（範囲の外の日は outside。薄くし、新しく入れない） */
export type ViewDay = LedgerDay & { outside: boolean };

/** 見ている週の7日（start から）。今日の印は today、数え方は今の台帳と同じ（reservations.ts の ledgerDay） */
export function viewWeek(shop: ShopSettings, today: CalDay, all: Reservation[], start: string, r: ViewRange): ViewDay[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = ledgerDay(shop, calDay(shop, addDays(start, i)), today.date, all);
    return { ...d, outside: !inRange(d.date, r) };
  });
}

// ── 月のカレンダー ─────────────────────────────────────────

/** YYYY-MM */
export const monthOf = (date: string): string => date.slice(0, 7);

export function monthStep(month: string, dir: -1 | 1): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + dir, 1));
  return d.toISOString().slice(0, 7);
}

/** 「前の月」「次の月」を押せるか（範囲の日がその月に1日でもあれば） */
export function canMonth(month: string, dir: -1 | 1, r: ViewRange): boolean {
  return dir < 0 ? month > monthOf(r.first) : month < monthOf(r.last);
}

/** 「2026年11月」 */
export function monthTitle(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${y}年${m}月`;
}

export type MonthCell = {
  date: string;
  day: number;
  /** その月の日か（前後の月の日は空けておく） */
  inMonth: boolean;
  /** 見られる範囲の中か（外は薄く・押せない） */
  inRange: boolean;
  isToday: boolean;
  /** いま台帳で見ている7日の中か */
  inView: boolean;
  /** お休み（定休日・設定の休みの日・オーナーの休みの日）。埋まりは「—」 */
  closed: boolean;
  /** オーナーが決めた休みの日（休みの日の欄と同じ印） */
  holiday: boolean;
  /** 件数（確定と、期限の切れていない仮押さえ）。お休みの日に残った予約も数える */
  count: number;
  /** 仮押さえがある */
  holds: number;
  usedMinutes: number;
  capacityMinutes: number;
};

/** 月のカレンダー（日曜はじまり）。数は台帳と同じ ledgerDay で出す */
export function monthGrid(
  shop: ShopSettings,
  month: string,
  input: { todayDate: string; all: Reservation[]; range: ViewRange; viewStart: string },
): { title: string; weeks: MonthCell[][] } {
  const firstDay = `${month}-01`;
  const lead = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(calDay(shop, firstDay).key);
  const start = addDays(firstDay, -lead);
  const weeks: MonthCell[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: MonthCell[] = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(start, w * 7 + i);
      const d = ledgerDay(shop, calDay(shop, date), input.todayDate, input.all);
      const since = dayDiff(input.viewStart, date);
      row.push({
        date,
        day: Number(date.slice(8)),
        inMonth: monthOf(date) === month,
        inRange: inRange(date, input.range),
        isToday: d.isToday,
        inView: since >= 0 && since < 7,
        closed: !d.open,
        holiday: !!d.holiday,
        count: d.reservations.length,
        holds: d.reservations.filter((r) => r.status === "hold").length,
        usedMinutes: d.usedMinutes,
        capacityMinutes: d.capacityMinutes,
      });
    }
    // 6週目がまるごと次の月なら出さない
    if (w > 3 && row.every((c) => !c.inMonth)) break;
    weeks.push(row);
  }
  return { title: monthTitle(month), weeks };
}

/** 埋まりの割合（0〜100）。受けられる分が無ければ null（「—」） */
export function fillPercent(used: number, capacity: number): number | null {
  return capacity > 0 ? Math.round((used / capacity) * 100) : null;
}

export type WeekSummary = { start: string; end: string; label: string; count: number; usedMinutes: number; capacityMinutes: number; percent: number | null };

/**
 * 週ごとの件数と埋まり（その7日の「埋まっている分の合計 ÷ 受けられる分の合計」。日ごとの割合の平均にはしない）。
 * 週は今日から7日ずつ（台帳の「今日」の週と同じ区切り）。範囲の中の日だけを数える。
 */
export function weekSummaries(shop: ShopSettings, input: { today: CalDay; all: Reservation[]; range: ViewRange }): WeekSummary[] {
  const out: WeekSummary[] = [];
  // 範囲の最初の日は今日の4週前なので、今日の週と同じ区切りになる
  for (let start = input.range.first; start <= input.range.last; start = addDays(start, 7)) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i)).filter((d) => inRange(d, input.range));
    if (!days.length) continue;
    const list = days.map((date) => ledgerDay(shop, calDay(shop, date), input.today.date, input.all));
    const count = list.reduce((s, d) => s + d.reservations.length, 0);
    const usedMinutes = list.reduce((s, d) => s + d.usedMinutes, 0);
    const capacityMinutes = list.reduce((s, d) => s + d.capacityMinutes, 0);
    const end = days[days.length - 1];
    const md = (x: string) => calDay(shop, x).label.replace(/（.）/, "");
    const percent = fillPercent(usedMinutes, capacityMinutes);
    out.push({
      start: days[0],
      end,
      label: `${md(days[0])}〜${md(end)}：${count}件・埋まり ${percent === null ? "—" : `${percent}%`}`,
      count,
      usedMinutes,
      capacityMinutes,
      percent,
    });
  }
  return out;
}

// ── 見ている週・月・開いている1枚（ページの共通の親が1つだけ持つ。LedgerView.tsx） ─────────

export type SheetTarget = { date: string; start: string };

export type ViewState = {
  /** 「最初に戻す」の印（book.state.epoch）と、実際に進んだ「翌日へ」の日数（book.dayOffset） */
  key: string;
  /** 見せ始める日。null = 今日（book.today）の週 */
  start: string | null;
  /** 月のカレンダーで出す月。null = 見ている週の始まりの日の月 */
  month: string | null;
  /** 開いている「台帳から入れる」の1枚 */
  sheet: SheetTarget | null;
};

export const viewKey = (epoch: string | undefined, dayOffset: number): string => `${epoch ?? ""}|${dayOffset}`;

export const freshView = (key: string): ViewState => ({ key, start: null, month: null, sheet: null });

/** 「翌日へ」「最初に戻す」（同じ日に押した時も、印 epoch が変わる）の後は、今日の週・今日の月に戻し、開いている1枚も閉じる */
export function syncView(s: ViewState, key: string): ViewState {
  return s.key === key ? s : freshView(key);
}

export type ViewAction =
  | { kind: "step"; dir: -1 | 1 }
  | { kind: "today" }
  | { kind: "pick"; date: string }
  | { kind: "month"; dir: -1 | 1 }
  | { kind: "open"; target: SheetTarget }
  | { kind: "close" };

/** 押した時の変え方。週を動かしたら、カレンダーもその週の始まりの日の月に戻す */
export function viewReduce(s: ViewState, a: ViewAction, ctx: { todayDate: string; range: ViewRange }): ViewState {
  const cur = clampStart(s.start ?? ctx.todayDate, ctx.range);
  switch (a.kind) {
    case "step":
      return { ...s, start: stepWeek(cur, a.dir, ctx.range), month: null };
    case "today":
      return { ...s, start: null, month: null };
    case "pick":
      return inRange(a.date, ctx.range) ? { ...s, start: a.date, month: null } : s;
    case "month": {
      const m = s.month ?? monthOf(cur);
      return canMonth(m, a.dir, ctx.range) ? { ...s, month: monthStep(m, a.dir) } : s;
    }
    case "open":
      // 範囲の外の日には新しく入れない
      return inRange(a.target.date, ctx.range) ? { ...s, sheet: a.target } : s;
    case "close":
      return { ...s, sheet: null };
  }
}
