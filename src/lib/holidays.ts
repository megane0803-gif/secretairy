// オーナーが決める「休みの日」（定休日の曜日とは別の、その日だけのお休み）。
// 最初の状態は無し（config/shop.json の closedDates は店の設定のまま）。オーナーが予約のページで決めた分はこのブラウザの中だけ（secretairy:holidays）。
// 同じ時間に受ける人数（capacity.ts）と同じ扱い：「最初に戻す」で消え、サーバーの窓口には画面が毎回送る（サーバーでも形と数を確かめなおす）。
//
// 気をつけること：最初の状態の予約は「起点から何番目の営業日」で日付を作る（reservations.ts）。
// 休みの日を足したまま数えると、今ある予約の日付がずれる（11/7 の予約が 11/8 に動く）。
// なので休みの日は「受け付けるかの判定」（calendar.ts の calDay）にだけ効かせ、最初の状態の日付を作る所は baseShop（休みの日を外した店）で数える。

import { addDays, calDay, isRealDate, type CalDay } from "./calendar";
import type { Reservation } from "./reservations";
import type { ShopSettings } from "./settings";

/** ブラウザの中の置き場所（browser.ts の PREFIX の後ろ） */
export const HOLIDAYS_KEY = "holidays";

/** 決められる数・何日先まで出すか（config/shop.json の holidayLimits。無ければこの数） */
export function holidayLimitsOf(shop: Pick<ShopSettings, "holidayLimits">): { max: number; aheadDays: number } {
  const l = shop.holidayLimits;
  const ok = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0;
  return { max: ok(l?.max) ? l!.max : 60, aheadDays: ok(l?.aheadDays) ? l!.aheadDays : 56 };
}

/** 本当にある日（YYYY-MM-DD。2/30 のような無い日は false）。確かめ方は calendar.ts の1か所 */
export { isRealDate };

/** 重ねず・古い順に */
const tidy = (list: string[]) => [...new Set(list)].sort();

/** ブラウザに残した休みの日を読む（形のおかしい日は落とす。多すぎる分は新しい日を残す） */
export function parseHolidays(raw: string | null, shop: Pick<ShopSettings, "holidayLimits">): string[] {
  if (!raw) return [];
  try {
    const v = (JSON.parse(raw) as { dates?: unknown })?.dates;
    if (!Array.isArray(v)) return [];
    return tidy(v.filter(isRealDate)).slice(-holidayLimitsOf(shop).max);
  } catch {
    return [];
  }
}

/** ブラウザに書く形。1日も無ければ消す（null） */
export function holidaysRaw(dates: string[]): string | null {
  const list = tidy(dates.filter(isRealDate));
  return list.length ? JSON.stringify({ dates: list }) : null;
}

/**
 * サーバーの窓口で、画面から来た休みの日を読む。
 * 無い（undefined）なら 0日。配列でない・数の上限をこえる・形のおかしい日（無い日も）が1つでもあれば断る（ok: false）。
 */
export function readHolidays(x: unknown, shop: Pick<ShopSettings, "holidayLimits">): { ok: true; value: string[] } | { ok: false; reason: string } {
  if (x === undefined || x === null) return { ok: true, value: [] };
  if (!Array.isArray(x)) return { ok: false, reason: "休みの日の形がおかしいです" };
  if (x.length > holidayLimitsOf(shop).max) return { ok: false, reason: "休みの日が多すぎます" };
  if (!x.every(isRealDate)) return { ok: false, reason: "休みの日の形がおかしいです" };
  return { ok: true, value: tidy(x) };
}

/** 店の設定に、オーナーの休みの日を重ねる（受け付けるかの判定に効く。無ければ設定のまま） */
export function withHolidays<T extends ShopSettings>(shop: T, dates: string[] | null | undefined): T {
  const list = tidy((dates ?? []).filter(isRealDate));
  if (list.length === 0) return shop.ownerHolidays?.length ? baseShop(shop) : shop;
  return { ...shop, ownerHolidays: list };
}

/** オーナーの休みの日を外した店（最初の状態の予約・ToDo・広告の日付を「何番目の営業日」から作る所だけで使う） */
export function baseShop<T extends ShopSettings>(shop: T): T {
  if (!shop.ownerHolidays) return shop;
  const rest = { ...shop };
  delete rest.ownerHolidays;
  return rest;
}

/** 休みにできる日（今日から aheadDays 日。定休日の曜日も入れる。範囲の数え方は book/holidayFlow.ts の holidayWindow と同じ） */
export function holidayChoices(shop: ShopSettings, today: CalDay): (CalDay & { weekly: boolean })[] {
  const n = holidayLimitsOf(shop).aheadDays;
  const base = baseShop(shop);
  return Array.from({ length: n }, (_, i) => {
    const date = addDays(today.date, i);
    const d = calDay(shop, date);
    // 定休日（設定の曜日・closedDates）は、ここでは変えない
    return { ...d, weekly: !calDay(base, date).open };
  });
}

/** その日に入っている予約（確定・仮押さえ。休みにする前に一覧で出す） */
export function reservationsOn(all: Reservation[], date: string): Reservation[] {
  return all.filter((r) => r.date === date).sort((a, b) => a.startMin - b.startMin);
}

/** 日誌の1行 */
export function holidayJournal(label: string, on: boolean, kept = 0): string {
  return on
    ? `休みの日にした：${label}（予約チャット・台帳・予約サイト・LINE・AI の仕事の判定に、次からすぐ効く）${kept ? `。入っていた予約 ${kept}件は消さずに残し、お客様ごとに ToDo「別の日時を案内」を足した` : ""}`
    : `休みの日を戻した：${label}（また予約を受けられる日に戻した）`;
}
