"use client";

// 画面で使う広告。最初の状態（seed/ads.json）に、このブラウザで止めた・外した分と承認の箱を重ねる。
// 書くのはこのブラウザの中だけ（サーバーには送らない）。

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { ADS_KEY, readBrowser, subscribeBrowser, writeBrowser } from "../browser";
import { getAds } from "../data/seed";
import { getAdSettings } from "../settings";
import { buildTable } from "./report";
import { offNos, parseAds, pendingAd, type AdsState } from "./state";

const read = () => readBrowser(ADS_KEY);

export function useAds() {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  const state = useMemo(() => parseAds(raw), [raw]);
  const settings = getAdSettings();
  const report = getAds();
  const table = useMemo(() => buildTable(report, settings, offNos(state)), [report, settings, state]);

  const update = useCallback((f: (s: AdsState) => AdsState) => {
    // 書く直前に読みなおす（別の窓で変えた分を消さないように）
    const next = f(parseAds(read()));
    writeBrowser(ADS_KEY, next.proposals.length === 0 && next.applied.length === 0 ? null : JSON.stringify(next));
  }, []);

  return { state, update, table, settings, report, pending: pendingAd(state) };
}


