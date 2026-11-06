// 休みの日を決める流れの1か所（docs/SPEC.md §4.7）。月のカレンダーの「休みを決める」と、休みの日の一覧の「戻す」の両方がここを通る。
// ここは決め方と書き方だけ（画面に依らない）。画面で使う形は src/app/reservations/HolidayFlow.tsx。
//
// - 休みにできる範囲：book.now.date を含めて holidayLimits.aheadDays 日（56日 = 55日後まで）。台帳・カレンダーで見られる範囲（weekView.ts の viewRange）とは別の物
// - 設定の定休日（曜日・closedDates）は押せない。オーナーが決めた休みの日は、押すと戻す。数の上限は holidayLimits.max
// - 予約（確定・仮押さえ）がある日は、まず一覧を出し、「それでも休みにする」を押した時だけ休みにする（予約は消さず ToDo「別の日時を案内」・日誌に1行）
// - 書けなかった時は「休みにした」と言わない（日誌・ToDo も作らない）。一覧を出した後に「最初に戻す」が押されていたら、その一覧は使わない
// - 開いている一覧と知らせは「翌日へ」「最初に戻す」（印 viewKey が変わる）で閉じる（syncHolidayFlow）

import { SAVE_FAILED_MESSAGE, type BrowserWrite } from "../browser";
import { addDays, calDay } from "../calendar";
import { baseShop, holidayJournal, holidayLimitsOf, reservationsOn } from "../holidays";
import type { Reservation } from "../reservations";
import type { ShopSettings } from "../settings";
import { holidayTodos, withHolidayTodos } from "./holiday";
import { sameEpoch, type BookState } from "./state";

/** 休みにできる範囲（book.now.date を含めて aheadDays 日） */
export function holidayWindow(shop: Pick<ShopSettings, "holidayLimits">, nowDate: string): { first: string; last: string; days: number } {
  const days = holidayLimitsOf(shop).aheadDays;
  return { first: nowDate, last: addDays(nowDate, days - 1), days };
}

/**
 * カレンダーの「休みを決める」の時の、その日の扱い。
 * outside … 休みにできる範囲の外（押せない） / weekly … 設定の定休日（押せない） / on … オーナーの休みの日（押すと戻す） / off … 営業日（押すと休みにする）
 */
export type HolidayDay = "outside" | "weekly" | "on" | "off";

export function holidayDay(shop: ShopSettings, nowDate: string, dates: readonly string[], date: string): HolidayDay {
  const w = holidayWindow(shop, nowDate);
  if (date < w.first || date > w.last) return "outside";
  // 定休日（設定の曜日・closedDates）は、ここでは変えない（オーナーの休みを外した店で見る）
  if (!calDay(baseShop(shop), date).open) return "weekly";
  return dates.includes(date) ? "on" : "off";
}

/**
 * 月のカレンダーの日を押した時に何をするか（「休みを決める」の入・切で変わる）。
 * 切 … 台帳で見られる範囲（weekView.ts の viewRange）の中なら、その日から7日の台帳へ（week）
 * 入 … 休みにできる範囲の、設定の定休日でない日なら、その日を休みにする・戻す（holiday）。台帳で見られる範囲は使わない
 */
export type MonthDayAction = { act: "week"; enabled: boolean } | { act: "holiday"; day: HolidayDay; enabled: boolean };

export function monthDayAction(
  holidayMode: boolean,
  input: { shop: ShopSettings; nowDate: string; dates: readonly string[]; date: string; inViewRange: boolean },
): MonthDayAction {
  if (!holidayMode) return { act: "week", enabled: input.inViewRange };
  const day = holidayDay(input.shop, input.nowDate, input.dates, input.date);
  return { act: "holiday", day, enabled: day === "on" || day === "off" };
}

/** 開いている「予約がある日」の一覧。epoch = 一覧を出した時の「最初に戻す」の印 */
export type HolidayAsk = { date: string; list: Reservation[]; epoch?: string };

/** 知らせを出す所（押した方の近くに出す） */
export type HolidayPlace = "calendar" | "list";

export type HolidayFlowState = {
  /** 「最初に戻す」の印と「翌日へ」の日数（weekView.ts の viewKey と同じ） */
  key: string;
  ask: HolidayAsk | null;
  note: { place: HolidayPlace; text: string } | null;
};

export const freshHolidayFlow = (key: string): HolidayFlowState => ({ key, ask: null, note: null });

/** 「翌日へ」「最初に戻す」の後は、開いている一覧と知らせを閉じる */
export function syncHolidayFlow(s: HolidayFlowState, key: string): HolidayFlowState {
  return s.key === key ? s : freshHolidayFlow(key);
}

export type HolidayPress =
  /** 押せない（理由を出す） */
  | { kind: "blocked"; note: string }
  /** 予約がある日：まず一覧を出す */
  | { kind: "ask"; ask: HolidayAsk }
  /** そのまま休みにする・戻す */
  | { kind: "apply"; on: boolean };

/**
 * 日を押した時に何をするか。from = calendar（月のカレンダーの「休みを決める」）か list（休みの日の一覧の「戻す」）。
 * 一覧からは戻すだけ（新しく休みにするのはカレンダーから）。
 */
export function holidayPress(
  input: { shop: ShopSettings; nowDate: string; dates: readonly string[]; all: Reservation[]; date: string; epoch?: string },
  from: HolidayPlace,
): HolidayPress {
  const { shop, nowDate, dates, date } = input;
  if (from === "list") return dates.includes(date) ? { kind: "apply", on: false } : { kind: "blocked", note: "もう休みの日ではありません" };
  const day = holidayDay(shop, nowDate, dates, date);
  if (day === "outside") {
    const w = holidayWindow(shop, nowDate);
    return { kind: "blocked", note: `休みにできるのは、今日から${w.days}日（${calDay(shop, w.last).label}まで）です` };
  }
  if (day === "weekly") return { kind: "blocked", note: "定休日（店の設定）は、ここでは変えません" };
  if (day === "on") return { kind: "apply", on: false };
  const max = holidayLimitsOf(shop).max;
  if (dates.length >= max) return { kind: "blocked", note: `休みの日は ${max}日までです` };
  const list = reservationsOn(input.all, date);
  return list.length ? { kind: "ask", ask: { date, list, epoch: input.epoch } } : { kind: "apply", on: true };
}

/** 書く所（画面では useHolidays の setHoliday・useBook の update・writeJournal。テストでは置きかえる） */
export type HolidayDeps = {
  /** 変えない時は null。書いた時は書けたか */
  setHoliday: (date: string, on: boolean) => BrowserWrite | null;
  update: (fn: (s: BookState) => BookState) => BrowserWrite;
  journal: (entry: { who: "オーナー"; text: string }) => void;
};

/**
 * 休みにする・戻すを書く。close = 開いている一覧を閉じてよいか（書けなかった時は残す。もう一度押せば書ける）。
 * ask = 一覧から「それでも休みにする」を押した時の一覧（そうでなければ無し）
 */
export function applyHoliday(
  deps: HolidayDeps,
  input: {
    shop: ShopSettings;
    state: Pick<BookState, "epoch">;
    dates: readonly string[];
    date: string;
    on: boolean;
    list: Reservation[];
    ask?: HolidayAsk | null;
    nowIso: string;
    todayDate: string;
  },
): { close: boolean; note: string | null } {
  const { date, on, list } = input;
  const label = calDay(input.shop, date).label;
  // 一覧を見せた後に「最初に戻す」が押されていたら、その一覧は使わない（直しA の形）
  if (input.ask && !sameEpoch(input.state, input.ask.epoch)) {
    return { close: true, note: "最初に戻したので、さっきの一覧は使いません。もう一度日を押してください" };
  }
  const w = deps.setHoliday(date, on);
  if (!w) {
    const max = holidayLimitsOf(input.shop).max;
    return { close: false, note: on && input.dates.length >= max ? `休みの日は ${max}日までです` : null };
  }
  // 書けなかった時は「休みにした」と言わない（日誌・ToDo も作らない）
  if (!w.ok) return { close: false, note: SAVE_FAILED_MESSAGE };
  let added: string[] = [];
  let todoNote = "";
  if (on && list.length) {
    const todos = holidayTodos(list, input.nowIso, input.todayDate);
    const tw = deps.update((s) => {
      const o = withHolidayTodos(s, todos);
      added = o.added;
      return o.state;
    });
    if (!tw.ok) {
      added = [];
      todoNote = `（ToDo は${SAVE_FAILED_MESSAGE.replace(/。.*$/, "")}。手で足してください）`;
    }
  }
  deps.journal({ who: "オーナー", text: holidayJournal(label, on, on ? list.length : 0) });
  return {
    close: true,
    note: on
      ? `${label}を休みの日にしました${list.length ? `。予約 ${list.length}件は残し、ToDo を${added.length}件足しました${todoNote}` : ""}`
      : `${label}を戻しました（また予約を受けられます）`,
  };
}
