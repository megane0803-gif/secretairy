// 言葉の門（プログラム）。AI の下書きを1行ずつ見て、
// 体・病院・薬・判断や助言の言葉（src/lib/rules/locked.ts の KARTE_GATE_WORDS）や数字（算用数字も漢数字も）が
// 施術メモに無ければ、その1行だけ載せない。メモにある言葉（例：「頭皮が赤かった」）は記録として残す。
// 🔒 鍵つきの2つ目（健康や医療の判断はしない）を守るための物。AI は使わない。

import { KARTE_GATE_WORDS } from "../rules/locked";
import type { KarteHeading } from "../settings";
import { emptySections, type KarteSections } from "./format";

export type GateRemoved = { headingId: string; heading: string; line: string; reason: string };

/** 比べやすくする（全角の数字・英字を半角に。時刻・桁区切りをそろえる） */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/(\d{1,2}):00(?!\d)/g, "$1時")
    .replace(/(\d{1,2}):(\d{2})(?!\d)/g, "$1時$2分");
}

const KANJI_DIGIT: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const KANJI_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const KANJI_RUN = /[〇零一二三四五六七八九十百千万]+/g;

/**
 * 漢数字が数ではない言葉（「一緒」「一応」など）。前後に漢数字が続かないときだけ、数として見ないで外す。
 * 数の言い方（「一度」「三センチ」「二か月」など）と、数とも読める「十分」（10分）はここに入れない（門は厳しい方に倒す）。
 */
const NOT_NUMBER_WORDS = ["一緒", "一般", "一応", "一旦", "一気", "一層", "一斉", "統一", "唯一", "同一", "万一"];
const NOT_NUMBER_RE = new RegExp(`(?<![〇零一二三四五六七八九十百千万])(${NOT_NUMBER_WORDS.join("|")})(?![〇零一二三四五六七八九十百千万])`, "g");

/** 漢数字の1つの並び（例「三」「二十」「百五十」「一万二千」「二〇二六」）を数にする。読めなければ null */
export function kanjiNumber(run: string): number | null {
  if (!run) return null;
  // 位の字が無い並び（「二〇二六」）は1けたずつ
  if (![...run].some((c) => c in KANJI_UNIT || c === "万")) {
    let n = 0;
    for (const c of run) {
      if (!(c in KANJI_DIGIT)) return null;
      n = n * 10 + KANJI_DIGIT[c];
    }
    return n;
  }
  let total = 0;
  let section = 0;
  let digit: number | null = null;
  for (const c of run) {
    if (c in KANJI_DIGIT) digit = KANJI_DIGIT[c];
    else if (c in KANJI_UNIT) {
      section += (digit ?? 1) * KANJI_UNIT[c];
      digit = null;
    } else if (c === "万") {
      total += (section + (digit ?? 0) || 1) * 10000;
      section = 0;
      digit = null;
    } else return null;
  }
  return total + section + (digit ?? 0);
}

/** 文の中の数字（「05」と「5」は同じ数。漢数字の「三」「二十」も算用数字と同じ数として見る） */
export function numbersIn(s: string): string[] {
  const t = normalizeText(s).replace(NOT_NUMBER_RE, "　");
  const arabic = (t.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n)));
  const kanji = (t.match(KANJI_RUN) ?? []).map(kanjiNumber).filter((n): n is number => n !== null).map(String);
  return [...new Set([...arabic, ...kanji])];
}

/** その1行を載せてよいか。載せないときは理由（1文）を返す */
export function gateLine(line: string, memo: string): string | null {
  const l = normalizeText(line);
  const m = normalizeText(memo);
  const words = KARTE_GATE_WORDS.filter((w) => l.includes(w) && !m.includes(w));
  const memoNums = new Set(numbersIn(memo));
  const nums = numbersIn(line).filter((n) => !memoNums.has(n));
  const parts: string[] = [];
  if (words.length) parts.push(`${words.map((w) => `「${w}」`).join("")}はメモに無い言葉です`);
  if (nums.length) parts.push(`${nums.map((n) => `「${n}」`).join("")}はメモに無い数字です`);
  return parts.length ? parts.join("。") : null;
}

/** 下書き全部を言葉の門に通す。外した行は removed に、残った行は sections に */
export function gateKarte(
  sections: KarteSections,
  memo: string,
  headings: KarteHeading[],
): { sections: KarteSections; removed: GateRemoved[] } {
  const out = emptySections(headings);
  const removed: GateRemoved[] = [];
  for (const h of headings)
    for (const line of sections[h.id] ?? []) {
      const reason = gateLine(line, memo);
      if (reason) removed.push({ headingId: h.id, heading: h.label, line, reason });
      else out[h.id].push(line);
    }
  return { sections: out, removed };
}

/** 画面と日誌に出す1文 */
export function removedSentence(r: GateRemoved): string {
  return `1行を載せていません（${r.reason}）`;
}
