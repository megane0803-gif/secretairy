// 台帳（book/state.ts の形）をこのブラウザに書く所。画面（useBook.ts）とテストが同じここを使う。
// 書く直前に読みなおす（別の窓で変えた分を消さないように）。書けたかどうかを返す（例外は投げない）。

import { BOOK_KEY, readBrowser, writeBrowser, type BrowserWrite } from "../browser";
import { emptyBook, parseBook, type BookState } from "./state";

export function readBook(todayDate: string): BookState {
  return parseBook(readBrowser(BOOK_KEY)) ?? emptyBook(todayDate);
}

/** 台帳を変えて書く。書けなかった時（置き場所がいっぱい・断られた）は ok: false（台帳は前のまま） */
export function updateBook(f: (s: BookState) => BookState, todayDate: string): BrowserWrite {
  return writeBrowser(BOOK_KEY, JSON.stringify(f(readBook(todayDate))));
}
