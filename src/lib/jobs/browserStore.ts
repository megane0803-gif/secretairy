// ホームの「AI の仕事」の置き場所（画面の側）。どれも見ている人のブラウザの中だけ（docs/SPEC.md §5.1）。
// 読むときは毎回読みなおし、書く直前にも読みなおす（useBook・useAds・useAccounting と同じ形）。

import { parseAccounting } from "../accounting/state";
import { isEmptyAds, parseAds } from "../ads/state";
import { emptyBook, parseBook } from "../book/state";
import { ACCOUNTING_KEY, ADS_KEY, BOOK_KEY, JOBS_KEY, readBrowser, writeBrowser } from "../browser";
import { shopToday } from "../calendar";
import { getShop } from "../settings";
import type { JobStore } from "./run";
import { parseJobs } from "./state";

export function browserJobStore(): JobStore {
  const book = () => parseBook(readBrowser(BOOK_KEY)) ?? emptyBook(shopToday(getShop()).today.date);
  return {
    book,
    setBook: (f) => writeBrowser(BOOK_KEY, JSON.stringify(f(book()))),
    ads: () => parseAds(readBrowser(ADS_KEY)),
    setAds: (f) => {
      const next = f(parseAds(readBrowser(ADS_KEY)));
      writeBrowser(ADS_KEY, isEmptyAds(next) ? null : JSON.stringify(next));
    },
    accounting: () => parseAccounting(readBrowser(ACCOUNTING_KEY)),
    jobs: () => parseJobs(readBrowser(JOBS_KEY)),
    setJobs: (f) => {
      const next = f(parseJobs(readBrowser(JOBS_KEY)));
      writeBrowser(JOBS_KEY, Object.keys(next.done).length ? JSON.stringify(next) : null);
    },
  };
}
