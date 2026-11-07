// 予約サイトで、オーナーが時間ごとに「ネットでは受けない」にした時間（docs/SPEC.md §1.4）。
// 最初の状態は無し。止めた時間はこのブラウザの中だけ（secretairy:siteStops）。「最初に戻す」で消える。
//
// 効かせるのは予約サイトだけ（「ここで予約が入る（デモ）」と「仮押さえと同じ枠に入れる（デモ）」。book/site.ts）。
// 予約チャットと、オーナーが台帳から入れる予約には効かせない（1日まるごと止めたい時は、休みの日を使う。holidays.ts）。
// 止めた時間に施術がかかる予約は入れない（その時刻に始まる予約だけでなく、止めた時間に重なる予約も）。

import { isRealDate, toHHMM, toMinutes } from "../calendar";
import type { ShopSettings } from "../settings";

/** ブラウザの中の置き場所（browser.ts の PREFIX の後ろ） */
export const SITE_STOPS_KEY = "siteStops";

/** 残す数の上限（7日 × 1日の枠の数より十分に多く） */
export const MAX_SITE_STOPS = 400;

const SLOT = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/;
/** 1マスの印の形で、日付が暦にある物（11/32 などは落とす） */
const isSlot = (x: string) => {
  const m = SLOT.exec(x);
  return !!m && isRealDate(m[1]);
};

/** 空き表の1マスの長さ（分）。予約サイトの空き表（BookingSite.tsx）と同じ */
export function siteStep(shop: Pick<ShopSettings, "slotMinutes">): number {
  return Math.max(15, shop.slotMinutes);
}

/** 1マスの印（「2026-11-12 15:00」） */
export function stopKey(date: string, start: string): string {
  return `${date} ${start}`;
}

/** ブラウザに残した止めた時間を読む（形のおかしい物は落とす） */
export function parseSiteStops(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = (JSON.parse(raw) as { slots?: unknown })?.slots;
    if (!Array.isArray(v)) return [];
    return [...new Set(v.filter((x): x is string => typeof x === "string" && isSlot(x)))].sort().slice(-MAX_SITE_STOPS);
  } catch {
    return [];
  }
}

/** ブラウザに書く形。1マスも無ければ消す（null） */
export function siteStopsRaw(slots: string[]): string | null {
  const list = [...new Set(slots.filter((x) => isSlot(x)))].sort().slice(-MAX_SITE_STOPS);
  return list.length ? JSON.stringify({ slots: list }) : null;
}

/** そのマス（date の start から1マス）を止めているか */
export function isStopped(stops: string[], date: string, start: string): boolean {
  return stops.includes(stopKey(date, start));
}

/** その予約（date の startMin〜endMin）が、止めたマスに少しでもかかるか。かかるマスの始まり（HH:MM）を返す。無ければ null */
export function stopHit(stops: string[], step: number, date: string, startMin: number, endMin: number): string | null {
  for (const s of stops) {
    const m = SLOT.exec(s);
    if (!m || m[1] !== date) continue;
    const t = toMinutes(`${m[2]}:${m[3]}`);
    if (t < endMin && startMin < t + step) return toHHMM(t);
  }
  return null;
}

/** 日誌の1行 */
export function siteStopJournal(dayLabel: string, start: string, end: string, on: boolean): string {
  return on
    ? `予約サイトで ${dayLabel} ${start}–${end} をネットでは受けないにした（この時間にかかる予約は予約サイトから入らない。予約チャットと台帳から入れる予約はそのまま）`
    : `予約サイトで ${dayLabel} ${start}–${end} のネットの受付を戻した`;
}
