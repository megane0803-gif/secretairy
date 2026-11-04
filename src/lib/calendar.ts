// 店の暦。「今日」と「何番目の営業日」を出す。
// 最初の状態の日付は「何番目の営業日の何時」で持つので、ここで本当の日付に直す。
// 定休日（hours が null の曜日）と休みの日（closedDates）は営業日に数えない。

import type { DayKey, Hours, Menu, ShopSettings } from "./settings";

const KEYS: DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const JA = ["日", "月", "火", "水", "木", "金", "土"];

export type CalDay = {
  /** YYYY-MM-DD */
  date: string;
  /** 11/4（水） */
  label: string;
  key: DayKey;
  hours: Hours;
  open: boolean;
};

/** 店の時間帯での、開いた日の日付（YYYY-MM-DD） */
export function openedDate(shop: Pick<ShopSettings, "timezone">, now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: shop.timezone });
}

export function calDay(shop: ShopSettings, date: string): CalDay {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  const w = day.getUTCDay();
  const key = KEYS[w];
  const hours = shop.closedDates.includes(date) ? null : shop.hours[key];
  return {
    date,
    label: `${m}/${d}（${JA[w]}）`,
    key,
    hours,
    open: hours !== null,
  };
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * 店の「今日」。開いた日がお休みなら、次の営業日を今日にする。
 * shifted は「開いた日はお休みだったので次の営業日にした」とき true。
 */
export function shopToday(shop: ShopSettings, now = new Date()): { today: CalDay; opened: CalDay; shifted: boolean } {
  const opened = calDay(shop, openedDate(shop, now));
  let today = opened;
  // 1年たっても営業日が無い設定は無いものとして、そこで止める
  for (let i = 0; i < 366 && !today.open; i++) today = calDay(shop, addDays(today.date, 1));
  return { today, opened, shifted: today.date !== opened.date };
}

/** 今日から数えて n 番目（0 = 今日）までの営業日 */
export function businessDays(shop: ShopSettings, today: CalDay, count: number): CalDay[] {
  const out: CalDay[] = [];
  let date = today.date;
  for (let i = 0; out.length < count && i < count * 7 + 366; i++) {
    const d = calDay(shop, date);
    if (d.open) out.push(d);
    date = addDays(date, 1);
  }
  return out;
}

/** 今日から7日分（お休みの日も入れる） */
export function weekFrom(shop: ShopSettings, today: CalDay): CalDay[] {
  return Array.from({ length: 7 }, (_, i) => calDay(shop, addDays(today.date, i)));
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function toHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** a から b まで何日か（同じ日なら 0） */
export function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** 店の時間帯での、いまの日付と時刻 */
export function shopNow(shop: Pick<ShopSettings, "timezone">, now = new Date()): { date: string; time: string } {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: shop.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  return { date: openedDate(shop, now), time };
}

/** 最終受付（店の設定）。メニューに書いてなければ「閉店 − 所要時間」 */
export function lastStartOf(menu: Pick<Menu, "minutes" | "lastStart">, close: string): string {
  return menu.lastStart ?? toHHMM(toMinutes(close) - menu.minutes);
}

/** 今日から n 番目の営業日（0 = 今日・負の数は過去の営業日）。見つからなければ null */
export function businessDayAt(shop: ShopSettings, today: CalDay, n: number): CalDay | null {
  if (n >= 0) return businessDays(shop, today, n + 1)[n] ?? null;
  let date = today.date;
  let left = -n;
  for (let i = 0; i < left * 7 + 366; i++) {
    date = addDays(date, -1);
    const d = calDay(shop, date);
    if (d.open && --left === 0) return d;
  }
  return null;
}

/**
 * 「11/6（金）」のような日付の札（月/日）から、日付（YYYY-MM-DD）を出す。
 * 今日以降でいちばん近い日。少し前（60日以内）の日なら、その過ぎた日を返す（判定で「もう過ぎた」と断るため）。
 */
export function dateFromMonthDay(today: string, month: number, day: number): string | null {
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  const y = Number(today.slice(0, 4));
  const make = (year: number) => {
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === date ? date : null;
  };
  const thisYear = make(y);
  if (!thisYear) return null; // 2/30 のような無い日
  if (thisYear >= today || dayDiff(thisYear, today) <= 60) return thisYear;
  return make(y + 1);
}

/** デモの「翌日へ」で進められる営業日の数の上限 */
export const MAX_DAY_OFFSET = 60;

/**
 * 画面とサーバーで同じに使う「今日」と「いま」。
 * dayOffset はデモの「翌日へ」で進めた営業日の数（定休日は飛ばす）。0 なら本当の今日・本当の時刻。
 * 進めたときは「その日の開店1時間前（朝の要点を見るころ）」をいまの時刻にする。
 */
export function demoClock(
  shop: ShopSettings,
  now = new Date(),
  dayOffset = 0,
): { today: CalDay; opened: CalDay; shifted: boolean; now: { date: string; time: string }; realToday: CalDay; dayOffset: number } {
  const real = shopToday(shop, now);
  const offset = Number.isInteger(dayOffset) && dayOffset > 0 ? Math.min(dayOffset, MAX_DAY_OFFSET) : 0;
  if (offset === 0) return { ...real, now: shopNow(shop, now), realToday: real.today, dayOffset: 0 };
  const today = businessDayAt(shop, real.today, offset) ?? real.today;
  const open = today.hours ? toMinutes(today.hours.open) : 600;
  return {
    today,
    opened: real.opened,
    shifted: false,
    now: { date: today.date, time: toHHMM(Math.max(0, open - 60)) },
    realToday: real.today,
    dayOffset: offset,
  };
}
