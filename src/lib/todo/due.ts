// 投げたメモの期限（プログラム。Claude は期限を決めない）。
// 「金曜までに」「明日中に」「11/20まで」のように「まで」「中」が付いた言い方だけを期限として読む。
// 読めないとき（「金曜に来る」のように期限ではない言い方も）は null（今のまま期限なし）。

import { addDays } from "../calendar";

const WEEKDAY: Record<string, number> = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };

function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const pad = (n: number) => String(n).padStart(2, "0");

function validDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** その週の日曜（週は月曜から） */
function sundayOf(date: string): string {
  return addDays(date, (7 - weekdayOf(date)) % 7);
}

/** 期限のしるし（「まで」「まで に」「中」「締め切り」）。この前にある日の言い方だけを期限にする */
const BY = "(?:まで|迄|中|じゅう|締め切り|締切|〆)";

/**
 * メモから期限の日（YYYY-MM-DD）を読む。today = 店の時間帯の今日（「翌日へ」も入れた今日）。読めなければ null。
 * - 今日中・本日中・今日まで → 今日 / 明日まで → 明日 / 明後日まで → あさって
 * - 金曜まで → 今日から見て次の金曜（今日が金曜なら今日）/ 来週の金曜まで → 来週の金曜
 * - 今週中・週末まで → その週の日曜 / 来週中 → 次の週の日曜
 * - 再来週中 → 2つ先の週の日曜 / 来月中・来月末まで → 来月の終わり / 来月10日まで → 来月の10日
 * - 11/20まで・11月20日まで → その日（過ぎていれば来年）/ 20日まで → その月の20日（過ぎていれば来月）/ 月末まで → その月の終わり
 */
export function memoDue(memo: string, today: string): string | null {
  const t = memo.normalize("NFKC").replace(/\s+/g, "");
  const has = (re: string) => new RegExp(`${re}${BY}`).test(t);
  const [y, m] = today.split("-").map(Number);

  if (has("(今日|本日|きょう)")) return today;
  if (has("(明後日|あさって)")) return addDays(today, 2);
  if (has("(明日|あした|あす)")) return addDays(today, 1);

  const wk = t.match(new RegExp(`(来週|再来週|今週)?の?([月火水木金土日])曜日?${BY}`));
  if (wk) {
    const want = WEEKDAY[wk[2]];
    const monday = addDays(today, -((weekdayOf(today) + 6) % 7));
    const weeks = wk[1] === "来週" ? 1 : wk[1] === "再来週" ? 2 : 0;
    if (wk[1]) return addDays(monday, 7 * weeks + ((want + 6) % 7));
    return addDays(today, (want - weekdayOf(today) + 7) % 7);
  }
  // 長い言い方を先に（「再来週中」を「来週中」、「来月末」を「月末」と読みちがえないように）
  if (has("再来週")) return addDays(sundayOf(today), 14);
  if (has("(今週|週末|土日)")) return sundayOf(today);
  if (has("(?<!再)来週")) return addDays(sundayOf(today), 7);
  const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
  if (has("来月末?")) return validDate(ny, nm, new Date(Date.UTC(ny, nm, 0)).getUTCDate());
  const nextMonthDay = t.match(new RegExp(`来月の?(3[01]|[12]\\d|[1-9])日${BY}`));
  if (nextMonthDay) return validDate(ny, nm, Number(nextMonthDay[1]));
  if (has("(?<!来)(月末|今月)")) return validDate(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate());

  const md = t.match(new RegExp(`(1[0-2]|0?[1-9])(?:/|月)(3[01]|[12]\\d|0?[1-9])日?${BY}`));
  if (md) {
    const mm = Number(md[1]);
    const dd = Number(md[2]);
    const thisYear = validDate(y, mm, dd);
    if (thisYear && thisYear >= today) return thisYear;
    return validDate(y + 1, mm, dd);
  }
  const dOnly = t.match(new RegExp(`(?<![\\d/月])(3[01]|[12]\\d|[1-9])日${BY}`));
  if (dOnly) {
    const dd = Number(dOnly[1]);
    const thisMonth = validDate(y, m, dd);
    if (thisMonth && thisMonth >= today) return thisMonth;
    return m === 12 ? validDate(y + 1, 1, dd) : validDate(y, m + 1, dd);
  }
  return null;
}
