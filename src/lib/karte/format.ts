// カルテの下書きの形：見出しごとに「■ 見出し」、その下に「・」で始まる短い行。
// Claude（または決まった返事）が書いた文を、見出しの id ごとの行に分ける（parseDraft）。
// 見出しは設定（config/karte.json）の物だけ。知らない見出しの下の行・「・」で始まらない行は使わない。
// 中身の無い見出しは空のまま（画面では「メモに無し」と出す）。

import type { KarteHeading } from "../settings";

/** 見出しの id ごとの短い行 */
export type KarteSections = Record<string, string[]>;

/** 1つの見出しに入れる行の数の上限 */
export const MAX_LINES_PER_HEADING = 8;
/** 1行の長さの上限（字）。これより長い所は切る */
export const MAX_LINE_CHARS = 80;

const HEAD = /^\s*[■□◆#]+\s*/;
const BULLET = /^\s*[・･•\-*]\s*/;
/** 「中身はありません」のつもりの行（空のままにする） */
const EMPTY_MARK = /^[（(]?(メモに無し|メモになし|メモにない|記載なし|なし|無し|特になし|特に無し|該当なし|-|ー|―)[）)]?。?$/;

const squash = (s: string) => s.normalize("NFKC").replace(/[\s「」『』【】:：]/g, "");

export function emptySections(headings: KarteHeading[]): KarteSections {
  return Object.fromEntries(headings.map((h) => [h.id, [] as string[]]));
}

function headingOf(line: string, headings: KarteHeading[]): KarteHeading | null {
  const name = squash(line.replace(HEAD, ""));
  if (!name) return null;
  return headings.find((h) => squash(h.label) === name) ?? headings.find((h) => name.startsWith(squash(h.label))) ?? null;
}

/** 下書きの文を見出しごとの行に分ける。ignored = 使わなかった行（見出しの外・知らない見出しの下など） */
export function parseDraft(text: string, headings: KarteHeading[]): { sections: KarteSections; ignored: string[] } {
  const sections = emptySections(headings);
  const ignored: string[] = [];
  let current: KarteHeading | null = null;
  let inUnknown = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (HEAD.test(line)) {
      current = headingOf(line, headings);
      inUnknown = !current;
      if (!current) ignored.push(line);
      continue;
    }
    if (!current || inUnknown || !BULLET.test(line)) {
      ignored.push(line);
      continue;
    }
    const item = line.replace(BULLET, "").trim().slice(0, MAX_LINE_CHARS);
    if (!item || EMPTY_MARK.test(item)) continue;
    const list = sections[current.id];
    if (list.length < MAX_LINES_PER_HEADING && !list.includes(item)) list.push(item);
  }
  return { sections, ignored };
}

/** 見出しごとの行を「■ 見出し」「・行」の文にする（中身の無い見出しは見出しの行だけ） */
export function formatKarte(sections: KarteSections, headings: KarteHeading[]): string {
  const out: string[] = [];
  for (const h of headings) {
    out.push(`■ ${h.label}`);
    for (const l of sections[h.id] ?? []) out.push(`・${l}`);
  }
  return out.join("\n");
}

/** 設定の見出しだけ・形を確かめて残す（ブラウザに残っていた物を読むとき） */
export function cleanSections(x: unknown, headings: KarteHeading[]): KarteSections {
  const out = emptySections(headings);
  if (!x || typeof x !== "object") return out;
  const r = x as Record<string, unknown>;
  for (const h of headings) {
    const v = r[h.id];
    if (Array.isArray(v))
      out[h.id] = v
        .filter((l): l is string => typeof l === "string" && l.trim() !== "")
        .map((l) => l.trim().slice(0, MAX_LINE_CHARS))
        .slice(0, MAX_LINES_PER_HEADING);
  }
  return out;
}

/** その見出しの id（次回提案など、役目で探す） */
export function headingWithRole(headings: KarteHeading[], role: NonNullable<KarteHeading["role"]>): KarteHeading | undefined {
  return headings.find((h) => h.role === role);
}
