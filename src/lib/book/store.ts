// 台帳（book/state.ts の形）をこのブラウザに書く所。画面（useBook.ts）とテストが同じここを使う。
// 書く直前に読みなおす（別の窓で変えた分を消さないように）。書けたかどうかを返す（例外は投げない）。

import { BOOK_KEY, readBrowser, writeBrowser, type BrowserWrite } from "../browser";
import { emptyBook, isUntouched, parseBook, type BookState } from "./state";

export function readBook(todayDate: string): BookState {
  return parseBook(readBrowser(BOOK_KEY)) ?? emptyBook(todayDate);
}

/** 台帳を変えて書く。書けなかった時（置き場所がいっぱい・断られた）は ok: false（台帳は前のまま） */
export function updateBook(f: (s: BookState) => BookState, todayDate: string): BrowserWrite {
  return writeBrowser(BOOK_KEY, JSON.stringify(f(readBook(todayDate))));
}

/** 今の台帳の「最初に戻す」の印（book/state.ts の epoch）。まだ無ければ undefined */
export function currentEpoch(): string | undefined {
  return parseBook(readBrowser(BOOK_KEY))?.epoch;
}

/**
 * 開いた時に起点をそろえる（docs/SPEC.md §5.1）。
 * - まだ一度も開いていない（読めない）：今日を起点に覚える
 * - 最初の状態のまま（isUntouched）で起点が今日でない：起点だけ今日に書き直す（初めて開いた PC・スマホと同じ中身になる）。
 *   ほかの欄（epoch など）はそのまま残す。休みの日・日報などは別の置き場所なので触らない。日誌は書かない（オーナーが何かした訳ではない）
 * - 何か入れた後：起点は動かさない（入れた物の日付がずれないように）
 * 書かなかった時は null、書いた時はその結果（書けなければ今の起点のまま開く。例外は投げない）。
 */
export function alignAnchor(todayDate: string): BrowserWrite | null {
  const raw = readBrowser(BOOK_KEY);
  const parsed = parseBook(raw);
  if (!parsed) return writeBrowser(BOOK_KEY, JSON.stringify(emptyBook(todayDate)));
  if (parsed.anchor === todayDate) return null;
  // 読む前の形でも確かめる（形がおかしくて読むときに落ちた物も「触った」と見て、消さない）
  const loose = JSON.parse(raw as string) as Record<string, unknown>;
  if (!isUntouched(parsed) || !isUntouched(loose)) return null;
  return writeBrowser(BOOK_KEY, JSON.stringify({ ...loose, anchor: todayDate }));
}
