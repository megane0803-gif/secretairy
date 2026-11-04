// 録音の文字と要点を扱う（プログラム）。
// - 文字起こしの決まった聞き違い（無音で出やすい言葉・同じ言葉のくり返し）を外す
// - お客様の名字を〔お客様〕に置きかえる（名前は AI に送らない）
// - AI の要点を「・」の行に分ける・数と長さをそろえる・言葉の門（その区切りの文字に無い言葉や数字の行は外す）
// - 全部の区切りの要点を1つのメモにまとめる（同じ物は1つに・上限の字数まで）

import { gateLine } from "../karte/gate";

/** 黙っている所や音だけの所で、文字起こしが出しやすい決まり文句（店ごとに変わらない、Whisper のくせ） */
const HALLUCINATIONS = [
  /ご視聴ありがとうございました。?/g,
  /チャンネル登録(を)?よろしくお願いします。?/g,
  /最後までご視聴いただきありがとうございます。?/g,
  /字幕(は|by)[^。\n]*。?/g,
];

/** 文字起こしを整える：決まり文句を外し、同じ文が3回以上続けば1回にする */
export function cleanTranscript(text: string): string {
  let t = text;
  for (const re of HALLUCINATIONS) t = t.replace(re, "");
  const sentences = t.split(/(?<=[。！？!?\n])/).map((s) => s.trim()).filter(Boolean);
  // 同じ文が3回以上続いたら1回にする（2回までは話したこととして残す）
  const out: string[] = [];
  for (let i = 0; i < sentences.length; ) {
    let j = i;
    while (j < sentences.length && sentences[j] === sentences[i]) j++;
    const run = j - i;
    for (let k = 0; k < (run >= 3 ? 1 : run); k++) out.push(sentences[i]);
    i = j;
  }
  return out.join("").replace(/(.{2,20}?)\1{3,}/g, "$1").trim();
}

const NAME_MARK = "〔お客様〕";

/** お客様の名字（＋様・さん・ちゃん）を〔お客様〕に置きかえる */
export function maskNames(text: string, surnames: string[]): string {
  let t = text;
  for (const s of [...surnames].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`${esc}(様|さま|さん|ちゃん|くん)?`, "g"), NAME_MARK);
  }
  return t;
}

/** AI の返事から要点の行を取り出す（「・」「-」で始まる行。「なし」は0行） */
export function parseNotes(text: string, maxNotes: number, maxNoteChars: number): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:[・\-*•]|\d+[.)．])\s*(.+)$/.exec(raw);
    if (!m) continue;
    const line = m[1].trim();
    if (!line || line === "なし") continue;
    out.push([...line].slice(0, maxNoteChars).join(""));
    if (out.length >= maxNotes) break;
  }
  return out;
}

export type NoteRemoved = { line: string; reason: string };

/** 要点の言葉の門：その区切りの文字に無い言葉（頭皮・おすすめ など）や数字が入った行は外す */
export function gateNotes(notes: string[], transcript: string): { notes: string[]; removed: NoteRemoved[] } {
  const kept: string[] = [];
  const removed: NoteRemoved[] = [];
  for (const line of notes) {
    const reason = gateLine(line, transcript);
    if (reason) removed.push({ line, reason });
    else kept.push(line);
  }
  return { notes: kept, removed };
}

const key = (s: string) => s.normalize("NFKC").replace(/[\s、。・,.!！?？「」]/g, "");

/**
 * 全部の区切りの要点を、カルテにするメモ1つにまとめる。順はそのまま、同じ物は1つに。
 * maxChars を超える所からは入れず、入らなかった行の数を返す。
 */
export function combineNotes(chunks: (string[] | null | undefined)[], maxChars: number): { memo: string; lines: string[]; dropped: number } {
  const seen = new Set<string>();
  const lines: string[] = [];
  let length = 0;
  let dropped = 0;
  for (const notes of chunks)
    for (const n of notes ?? []) {
      const k = key(n);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const line = `・${n}`;
      const add = [...line].length + (lines.length ? 1 : 0);
      if (length + add > maxChars) {
        dropped++;
        continue;
      }
      lines.push(line);
      length += add;
    }
  return { memo: lines.join("\n"), lines, dropped };
}
