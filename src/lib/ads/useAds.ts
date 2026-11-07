"use client";

// 画面で使う広告。最初の状態（seed/ads.json）に、このブラウザで止めた・外した・足した分と承認BOXを重ねる。
// 書くのはこのブラウザの中だけ（サーバーには送らない）。

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { ADS_KEY, readBrowser, subscribeBrowser, writeBrowser, type BrowserWrite } from "../browser";
import { getAds } from "../data/seed";
import { getAdSettings } from "../settings";
import { isEmptyAds, parseAds, pendingAd, pendingAdds, tableOf, type AdsState } from "./state";

const read = () => readBrowser(ADS_KEY);

/** いまブラウザにある広告の状態（書く直前に読みなおす時に使う） */
export function readAdsState(): AdsState {
  return parseAds(read());
}

/** 広告の状態をブラウザに書く。書けたかを返す（例外は投げない。書けなければ前のまま） */
export function writeAdsState(next: AdsState): BrowserWrite {
  return writeBrowser(ADS_KEY, isEmptyAds(next) ? null : JSON.stringify(next));
}

export function useAds() {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  const state = useMemo(() => parseAds(raw), [raw]);
  const settings = getAdSettings();
  const report = getAds();
  const table = useMemo(() => tableOf(report, settings, state), [report, settings, state]);

  // 書く直前に読みなおす（別の窓で変えた分を消さないように）。書けたかを返す
  const update = useCallback((f: (s: AdsState) => AdsState): BrowserWrite => writeAdsState(f(readAdsState())), []);

  // pending = 止める・外すの承認待ち（LINE・AI のチームの会議はこれだけを見る）。adds = 足す案の承認待ち
  return { state, update, table, settings, report, pending: pendingAd(state), adds: pendingAdds(state) };
}


