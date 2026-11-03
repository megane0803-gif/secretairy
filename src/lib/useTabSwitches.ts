"use client";

// タブの表示スイッチ。最初の状態は config/tabs.json、画面で変えた分はブラウザの中だけに重ねる。

import { useCallback, useSyncExternalStore } from "react";
import { readBrowser, subscribeBrowser, TABS_KEY, writeBrowser } from "./browser";
import type { TabSwitches } from "./settings";
import type { TabId } from "./tabs";

let cacheRaw: string | null | undefined;
let cacheVal: Partial<TabSwitches> = {};

function overrides(): Partial<TabSwitches> {
  const raw = readBrowser(TABS_KEY);
  if (raw !== cacheRaw) {
    cacheRaw = raw;
    try {
      cacheVal = raw ? (JSON.parse(raw) as Partial<TabSwitches>) : {};
    } catch {
      cacheVal = {};
    }
  }
  return cacheVal;
}

const EMPTY: Partial<TabSwitches> = {};

export function useTabSwitches(base: TabSwitches) {
  const over = useSyncExternalStore(subscribeBrowser, overrides, () => EMPTY);
  const switches: TabSwitches = { ...base, ...over };
  const setSwitch = useCallback(
    (id: TabId, visible: boolean) => {
      const next = { ...overrides(), [id]: visible };
      // 最初の状態と同じになった物は消しておく
      if (base[id] === visible) delete next[id];
      writeBrowser(TABS_KEY, Object.keys(next).length ? JSON.stringify(next) : null);
    },
    [base],
  );
  return { switches, setSwitch };
}
