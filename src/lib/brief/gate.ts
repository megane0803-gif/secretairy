// 「AI の一言」の門（プログラム）。Claude の1行ずつを見て、使えない行は外す。AI は使わない。
// - 印（【予約1】など）は、送った材料にある物だけ（知らない印の行は外す）
// - 数字・時刻・日付・曜日を書いていない（日時と数字はプログラムが入れる。発信の門と同じ見方）
// - 体・病院・薬・判断や助言の言葉（🔒 KARTE_GATE_WORDS）は、材料に無ければ外す（カルテの言葉の門と同じ考え）
// - 1行の長さ・数の上限（config/ai.json の brief）

import { normalizeText } from "../karte/gate";
import { numbersWritten } from "../posts/gate";
import { KARTE_GATE_WORDS } from "../rules/locked";
import { MARK_RE, type BriefDropped, type BriefItem } from "./wire";

const BULLET = /^[・\-*•●○◯\s]+/;

/** 返事を1行ずつにする（頭の「・」を外し、空の行は捨てる） */
export function briefLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(BULLET, "").trim())
    .filter((l) => l.length > 0);
}

/** その1行を使ってよいか。使えないときは理由（1文） */
export function gateBriefLine(line: string, items: BriefItem[], maxNoteChars: number): string | null {
  if ([...line].length > maxNoteChars) return `${maxNoteChars}字より長い行でした`;
  const known = new Set(items.map((i) => i.mark));
  const marks = [...line.matchAll(MARK_RE)].map((m) => m[0]);
  const unknown = marks.filter((m) => !known.has(m));
  if (unknown.length) return `${unknown.join("")}は送った材料に無い印です`;
  // 印のほかに【…】を書いた（印の形をまねた物など）
  if (/【[^】]*】/.test(line.replace(MARK_RE, ""))) return "知らない印がありました";
  const nums = numbersWritten(line);
  if (nums.length) return `${nums.map((n) => `「${n}」`).join("")}は書かない約束です（日時と数字はプログラムが入れます）`;
  const material = normalizeText(items.map((i) => i.text).join("\n"));
  const l = normalizeText(line.replace(MARK_RE, ""));
  const words = KARTE_GATE_WORDS.filter((w) => l.includes(w) && !material.includes(w));
  if (words.length) return `${words.map((w) => `「${w}」`).join("")}は材料に無い言葉です`;
  return null;
}

/** 返事全部を門に通す。通った行を上から maxNotes まで */
export function gateBrief(text: string, items: BriefItem[], maxNotes: number, maxNoteChars: number): { notes: string[]; dropped: BriefDropped[] } {
  const notes: string[] = [];
  const dropped: BriefDropped[] = [];
  for (const line of briefLines(text)) {
    const reason = gateBriefLine(line, items, maxNoteChars);
    if (reason) dropped.push({ line, reason });
    else if (notes.length < maxNotes && !notes.includes(line)) notes.push(line);
  }
  return { notes, dropped };
}
