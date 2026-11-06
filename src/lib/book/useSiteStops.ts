"use client";

// 画面で使う「予約サイトで止めた時間」（オーナーが空き表のマスを押して、ネットでは受けないにした時間。book/siteStops.ts）。
// 書くのはこのブラウザの中だけ。止めたらすぐ、予約サイト（架空）のデモに効く（予約チャット・台帳から入れる予約には効かない）。

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { readBrowser, subscribeBrowser, writeBrowser } from "../browser";
import { MAX_SITE_STOPS, parseSiteStops, SITE_STOPS_KEY, siteStopsRaw, stopKey } from "./siteStops";

const read = () => readBrowser(SITE_STOPS_KEY);

export function useSiteStops() {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  const stops = useMemo(() => parseSiteStops(raw), [raw]);

  /** そのマスを止める・戻す（書く直前に読みなおす）。変えたら true */
  const toggle = useCallback((date: string, start: string, on: boolean): boolean => {
    const cur = parseSiteStops(read());
    const k = stopKey(date, start);
    if (on === cur.includes(k)) return false;
    if (on && cur.length >= MAX_SITE_STOPS) return false;
    writeBrowser(SITE_STOPS_KEY, siteStopsRaw(on ? [...cur, k] : cur.filter((x) => x !== k)));
    return true;
  }, []);

  return { stops, toggle };
}
