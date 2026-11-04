// 日誌。AI が道具を呼んだ・ルールで弾かれた・人がボタンを押した・ルールを足した／直した／消した、を時刻つきで1行ずつ。
// 見ている人のブラウザの中だけに残す（docs/SPEC.md §5.1・§7）。サーバーには送らない。

import { JOURNAL_KEY, readBrowser, writeBrowser } from "./browser";

/** だれが（AI / オーナー / プログラム / LINE） */
export type JournalWho = "AI" | "オーナー" | "プログラム" | "LINE";

export type JournalEntry = { id: string; at: string; who: JournalWho; text: string };

/** 日誌の欄で畳まずに出す行の数（新しい方から。残りは畳む） */
export const JOURNAL_SHOW = 5;

/** 残しておく行の数（古い物から消す） */
export const JOURNAL_MAX = 300;

let n = 0;
function newId(): string {
  n += 1;
  return `j-${Date.now().toString(36)}-${n}`;
}

export function parseJournal(raw: string | null): JournalEntry[] {
  if (!raw) return [];
  try {
    const d = JSON.parse(raw);
    if (!Array.isArray(d)) return [];
    return d
      .filter(
        (e) =>
          e &&
          typeof e.id === "string" &&
          typeof e.at === "string" &&
          typeof e.text === "string" &&
          ["AI", "オーナー", "プログラム", "LINE"].includes(e.who),
      )
      .slice(0, JOURNAL_MAX);
  } catch {
    return [];
  }
}

/** 新しい順に足す（いちばん上が新しい） */
export function withEntries(list: JournalEntry[], add: { who: JournalWho; text: string; at?: string }[]): JournalEntry[] {
  const at = new Date().toISOString();
  const fresh = add.map((e) => ({ id: newId(), at: e.at ?? at, who: e.who, text: e.text.slice(0, 300) }));
  return [...fresh.reverse(), ...list].slice(0, JOURNAL_MAX);
}

/** 日誌に書く（このブラウザの中だけ） */
export function writeJournal(...add: { who: JournalWho; text: string }[]): void {
  if (add.length === 0) return;
  writeBrowser(JOURNAL_KEY, JSON.stringify(withEntries(parseJournal(readBrowser(JOURNAL_KEY)), add)));
}
