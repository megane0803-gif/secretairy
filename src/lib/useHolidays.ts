"use client";

// 画面で使う「休みの日」（オーナーが予約のページで決めた日）。最初の状態は無し。このブラウザで決めた分を重ねる（holidays.ts）。
// 書くのはこのブラウザの中だけ。決めたらすぐ、どの画面の次の判定にも効く（useBook の shop に重なる）。

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { readBrowser, subscribeBrowser, writeBrowser, type BrowserWrite } from "./browser";
import { HOLIDAYS_KEY, holidayLimitsOf, holidaysRaw, isRealDate, parseHolidays } from "./holidays";
import { getShop } from "./settings";

const read = () => readBrowser(HOLIDAYS_KEY);

export function useHolidays() {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  const dates = useMemo(() => parseHolidays(raw, getShop()), [raw]);

  /**
   * 休みにする・戻す（書く直前に読みなおす。上限をこえる時は足さない）。
   * 変えない時は null。書いた時は書けたか（BrowserWrite。書けなければ前のまま）
   */
  const setHoliday = useCallback((date: string, on: boolean): BrowserWrite | null => {
    if (!isRealDate(date)) return null;
    const cur = parseHolidays(read(), getShop());
    if (on === cur.includes(date)) return null;
    if (on && cur.length >= holidayLimitsOf(getShop()).max) return null;
    return writeBrowser(HOLIDAYS_KEY, holidaysRaw(on ? [...cur, date] : cur.filter((d) => d !== date)));
  }, []);

  return { dates, setHoliday };
}
