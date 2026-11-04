// カルテのタブの「お客様一覧」：全員（架空）を、名字で探す（部分一致）・50音の行で絞る。プログラムだけ（AI は使わない）。
// 行は名字のよみ（seed/customers.json の kana）の1文字目で決める。

import type { Customer } from "../data/types";

export const KANA_ROWS = [
  { id: "a", label: "あ", chars: "あいうえおぁぃぅぇぉゔ" },
  { id: "ka", label: "か", chars: "かきくけこがぎぐげご" },
  { id: "sa", label: "さ", chars: "さしすせそざじずぜぞ" },
  { id: "ta", label: "た", chars: "たちつてとだぢづでどっ" },
  { id: "na", label: "な", chars: "なにぬねの" },
  { id: "ha", label: "は", chars: "はひふへほばびぶべぼぱぴぷぺぽ" },
  { id: "ma", label: "ま", chars: "まみむめも" },
  { id: "ya", label: "や", chars: "やゆよゃゅょ" },
  { id: "ra", label: "ら", chars: "らりるれろ" },
  { id: "wa", label: "わ", chars: "わをん" },
] as const;

export type KanaRowId = (typeof KANA_ROWS)[number]["id"];

/** カタカナをひらがなに（全角・半角もそろえる） */
export function toHiragana(s: string): string {
  return s.normalize("NFKC").replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** よみの1文字目から50音の行。よみが無い・ひらがなでない時は null */
export function kanaRowOf(kana: string | undefined): KanaRowId | null {
  const first = kana ? toHiragana(kana.trim())[0] : undefined;
  if (!first) return null;
  return KANA_ROWS.find((r) => (r.chars as string).includes(first))?.id ?? null;
}

/** 名字（またはよみ）の部分一致と、50音の行で絞る。よみの順に並べる */
export function filterCustomers<C extends Pick<Customer, "surname" | "kana">>(list: C[], query: string, row: KanaRowId | null): C[] {
  const q = toHiragana(query).replace(/\s+/g, "");
  return list
    .filter((c) => !row || kanaRowOf(c.kana) === row)
    .filter((c) => !q || c.surname.includes(q) || toHiragana(c.kana ?? "").includes(q))
    .sort((a, b) => (a.kana ?? a.surname).localeCompare(b.kana ?? b.surname, "ja"));
}
