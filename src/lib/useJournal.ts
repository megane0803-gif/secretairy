"use client";

import { useMemo, useSyncExternalStore } from "react";
import { JOURNAL_KEY, readBrowser, subscribeBrowser } from "./browser";
import { parseJournal } from "./journal";

const read = () => readBrowser(JOURNAL_KEY);

/** このブラウザの日誌（新しい順） */
export function useJournal() {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  return useMemo(() => parseJournal(raw), [raw]);
}
