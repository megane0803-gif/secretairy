"use client";

// 画面で使う「AI の仕事」：済んだ行と結果（secretairy:jobs）と、欄の表示スイッチ（secretairy:jobsSwitch）。
// どちらもこのブラウザの中だけ。表示スイッチの最初の状態は config/jobs.json の visible。

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { JOBS_KEY, JOBS_SWITCH_KEY, readBrowser, subscribeBrowser, writeBrowser } from "../browser";
import { parseJobs } from "./state";

const readJobs = () => readBrowser(JOBS_KEY);
const readSwitch = () => readBrowser(JOBS_SWITCH_KEY);

export function useJobs() {
  const raw = useSyncExternalStore(subscribeBrowser, readJobs, () => null);
  return useMemo(() => parseJobs(raw), [raw]);
}

/** 欄を出すか。base = 最初の状態（config）。最初の状態と同じになったら印を消す */
export function useJobsSwitch(base: boolean) {
  const raw = useSyncExternalStore(subscribeBrowser, readSwitch, () => null);
  const on = raw === "on" ? true : raw === "off" ? false : base;
  const set = useCallback((v: boolean) => writeBrowser(JOBS_SWITCH_KEY, v === base ? null : v ? "on" : "off"), [base]);
  return { on, set };
}
