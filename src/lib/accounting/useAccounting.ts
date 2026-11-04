"use client";

// 画面で使う経理。最初の状態（seed/accounting.json）に、このブラウザで選んだ印・登録・足した自動のルールを重ねる。
// 書くのはこのブラウザの中だけ（サーバーには送らない）。

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { ACCOUNTING_KEY, readBrowser, subscribeBrowser, writeBrowser } from "../browser";
import { getAccounting } from "../data/seed";
import { getAccountingSettings } from "../settings";
import { effectiveRules, gateOf, parseAccounting, sortCurrent, type AccountingState } from "./state";

const read = () => readBrowser(ACCOUNTING_KEY);

export function useAccounting() {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  const state = useMemo(() => parseAccounting(raw), [raw]);
  const seed = getAccounting();
  const settings = getAccountingSettings();
  const sorted = useMemo(() => sortCurrent(seed), [seed]);
  const gate = useMemo(() => gateOf(seed, state), [seed, state]);
  const rules = useMemo(() => effectiveRules(seed.rules, state), [seed, state]);

  const update = useCallback((f: (s: AccountingState) => AccountingState) => {
    // 書く直前に読みなおす（別の窓で変えた分を消さないように）
    writeBrowser(ACCOUNTING_KEY, JSON.stringify(f(parseAccounting(read()))));
  }, []);

  return { state, update, seed, settings, sorted, gate, rules };
}
