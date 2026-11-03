// 店の時間帯で「今日から7日間」を出す。
import type { DayKey } from "./settings";

const KEYS: DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const JA = ["日", "月", "火", "水", "木", "金", "土"];

export type WeekDay = { date: string; label: string; key: DayKey };

export function nextSevenDays(timezone: string, from = new Date()): WeekDay[] {
  // 店の時間帯での「今日」の日付を出し、そこから1日ずつ足す
  const today = from.toLocaleDateString("en-CA", { timeZone: timezone }); // YYYY-MM-DD
  const [y, m, d] = today.split("-").map(Number);
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(Date.UTC(y, m - 1, d + i));
    const w = day.getUTCDay();
    return {
      date: day.toISOString().slice(0, 10),
      label: `${day.getUTCMonth() + 1}/${day.getUTCDate()}（${JA[w]}）`,
      key: KEYS[w],
    };
  });
}
