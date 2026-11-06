// 経理の日報をこのブラウザに書く所（daily.ts の形）。画面（SalesReport.tsx）とテストが同じここを使う。
// 書く直前に読みなおす。書けたかどうかを返す（例外は投げない）。どこにも送らない。

import { DAILY_KEY, readBrowser, writeBrowser, type BrowserWrite } from "../browser";
import { currentEpoch } from "../book/store";
import { writeJournal } from "../journal";
import { parseDaily, type DailyDeps, type DailyState } from "./daily";

export const readDaily = (): DailyState => parseDaily(readBrowser(DAILY_KEY));

/** 1日も無ければ置き場所ごと消す（最初の状態と同じにする） */
export function writeDaily(s: DailyState): BrowserWrite {
  return writeBrowser(DAILY_KEY, s.days.length ? JSON.stringify(s) : null);
}

/** 画面で使う deps（書く所・日誌・「最初に戻す」の印） */
export const browserDailyDeps: DailyDeps = {
  read: readDaily,
  write: writeDaily,
  journal: writeJournal,
  epochNow: currentEpoch,
};
