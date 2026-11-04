// お客様の文の中の日付の言い方を、プログラムで読む所。
// 「来週の20日」で20日が来週に無い・「11/6（木）」で11/6が木曜でない、のように食い違うときは、
// 勝手に決めずに、どちらのことか聞き返す（AI にも決まった返事にも決めさせない）。
// 週は月曜から日曜まで（仮決め。docs/SPEC.md §9.1.1）。

import { addDays, calDay, dateFromMonthDay, dayDiff } from "../calendar";
import type { ShopSettings } from "../settings";

const JA = ["日", "月", "火", "水", "木", "金", "土"];
const WEEK_WORDS: { word: string; n: number }[] = [
  { word: "再来週", n: 2 },
  { word: "来週", n: 1 },
  { word: "今週", n: 0 },
];

/** 全角の数字・記号を半角に */
export function normalizeText(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ":")
    .replace(/[／]/g, "/")
    .replace(/\+/g, "＋");
}

/** その日を含む週の月曜 */
export function mondayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(date, -((w + 6) % 7));
}

/** 今週（0）・来週（1）・再来週（2）の月曜〜日曜 */
export function weekRange(today: string, n: number): { from: string; to: string } {
  const from = addDays(mondayOf(today), 7 * n);
  return { from, to: addDays(from, 6) };
}

function weekdayIndex(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export type DateMention = { date: string; index: number; text: string };

/** 文の中の日付（11/6・11月6日・6日）を全部。月の無い「6日」は今日から先でいちばん近い6日 */
export function findDates(today: string, raw: string): DateMention[] {
  const t = normalizeText(raw);
  const out: DateMention[] = [];
  const used: [number, number][] = [];
  const take = (re: RegExp, make: (m: RegExpExecArray) => string | null) => {
    for (const m of t.matchAll(re)) {
      const at = m.index ?? 0;
      if (used.some(([a, b]) => at < b && at + m[0].length > a)) continue;
      const date = make(m as RegExpExecArray);
      if (!date) continue;
      used.push([at, at + m[0].length]);
      out.push({ date, index: at, text: m[0] });
    }
  };
  take(/(\d{1,2})\s*[/月]\s*(\d{1,2})日?/g, (m) => dateFromMonthDay(today, Number(m[1]), Number(m[2])));
  // 「6日」「20日」（「1日4人」のような数え方は見ない：後ろに数字や「間」「目」が続く物は外す）
  take(/(?<![\d/月])(\d{1,2})日(?![\d間目])/g, (m) => {
    const d = Number(m[1]);
    const [, mo, day] = today.split("-").map(Number);
    if (!(d >= 1 && d <= 31)) return null;
    const month = d >= day ? mo : mo === 12 ? 1 : mo + 1;
    return dateFromMonthDay(today, month, d);
  });
  return out.sort((a, b) => a.index - b.index);
}

/** 文の中の曜日（「金曜」「（金）」「金曜日」）。日付のすぐ後ろのかっこも読む */
function weekdayNear(t: string, from: number): { w: number; index: number } | null {
  const rest = t.slice(from, from + 12);
  const m = rest.match(/^[^。、]*?[（(]([月火水木金土日])[）)]/) ?? rest.match(/^[^。、]{0,4}?([月火水木金土日])曜/);
  if (!m) return null;
  return { w: JA.indexOf(m[1]), index: from + (m.index ?? 0) };
}

/** 「来週の金曜」のように、週と曜日だけで言った日（日付が無いとき）。無ければ null */
export function weekAndWeekday(today: string, raw: string): string | null {
  const t = normalizeText(raw);
  for (const { word, n } of WEEK_WORDS) {
    const i = t.indexOf(word);
    if (i < 0) continue;
    const m = t.slice(i).match(/^(再来週|来週|今週)の?([月火水木金土日])曜/);
    if (!m) continue;
    const w = JA.indexOf(m[2]);
    const { from } = weekRange(today, n);
    return addDays(from, (w + 6) % 7);
  }
  return null;
}

/** 「11月の金曜」：月と曜日。無ければ null */
export function monthAndWeekday(today: string, raw: string): { month: string; weekday: string } | null {
  const t = normalizeText(raw);
  const m = t.match(/(\d{1,2})月の?([月火水木金土日])曜/);
  if (!m) return null;
  const mo = Number(m[1]);
  if (!(mo >= 1 && mo <= 12)) return null;
  const [y, cur] = today.split("-").map(Number);
  const year = mo < cur ? y + 1 : y;
  const keys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return { month: `${year}-${String(mo).padStart(2, "0")}`, weekday: keys[JA.indexOf(m[2])] };
}

export type DateAsk = { question: string; step: string };

/**
 * 週と日付・日付と曜日が食い違うか。食い違えば、どちらのことかを聞き返す文を返す（決めない）。
 */
export function dateConflict(shop: ShopSettings, today: string, raw: string): DateAsk | null {
  const t = normalizeText(raw);
  const dates = findDates(today, t);
  const label = (d: string) => calDay(shop, d).label;

  // 1. 日付と曜日：「11/6（木）」で11/6が金曜
  for (const d of dates) {
    const near = weekdayNear(t, d.index + d.text.length);
    if (!near || near.w < 0) continue;
    const real = weekdayIndex(d.date);
    if (real === near.w) continue;
    // 同じ週の、言った曜日の日
    const other = addDays(mondayOf(d.date), (near.w + 6) % 7);
    return {
      question: `${label(d.date).replace(/（.）$/, "")}は${JA[real]}曜日です。${label(d.date)}と、${JA[near.w]}曜日の${label(other)}の、どちらのことでしょうか。`,
      step: `日付の確かめ：「${d.text}」と「${JA[near.w]}曜」が食い違うので、決めずに聞き返した`,
    };
  }

  // 2. 週と日付：「来週の20日」で20日が来週に無い
  for (const { word, n } of WEEK_WORDS) {
    const i = t.indexOf(word);
    if (i < 0) continue;
    // 「再来週」の中の「来週」を2回数えない
    if (word === "来週" && t.slice(Math.max(0, i - 1), i) === "再") continue;
    const d = dates.find((x) => x.index > i) ?? dates[0];
    if (!d) continue;
    const { from, to } = weekRange(today, n);
    if (d.date >= from && d.date <= to) continue;
    const near = weekdayNear(t, d.index + d.text.length) ?? weekdayNear(t, i + word.length);
    const w = near && near.w >= 0 ? near.w : weekdayIndex(d.date);
    const inWeek = addDays(from, (w + 6) % 7);
    const actual = Math.floor(dayDiff(mondayOf(today), mondayOf(d.date)) / 7);
    const actualWord = actual === 0 ? "今週" : actual === 1 ? "来週" : actual === 2 ? "再来週" : actual < 0 ? "もう過ぎた週" : `${actual}週あと`;
    return {
      question: `「${word}」は${label(from)}〜${label(to)}ですが、${label(d.date)}は${actualWord}です。${label(d.date)}と、${word}の${JA[w]}曜日の${label(inWeek)}の、どちらのことでしょうか。`,
      step: `日付の確かめ：「${word}」と「${d.text}」が食い違うので、決めずに聞き返した`,
    };
  }
  return null;
}
