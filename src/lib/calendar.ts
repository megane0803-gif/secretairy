// 店の暦。「今日」と「何番目の営業日」を出す。
// 最初の状態の日付は「何番目の営業日の何時」で持つので、ここで本当の日付に直す。
// 定休日（hours が null の曜日）と休みの日（closedDates）は営業日に数えない。

import type { DayKey, Hours, ShopSettings } from "./settings";

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
export function openedDate(shop: ShopSettings, now = new Date()): string {
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
