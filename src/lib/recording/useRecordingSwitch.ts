"use client";

// 「録音からメモを作る」を出す・隠すスイッチ（動かない時に隠すため）。
// 最初の状態は config/recording.json の visible、画面で変えた分は見ている人のブラウザの中だけに残す。

import { useCallback, useSyncExternalStore } from "react";
import { readBrowser, RECORDING_SWITCH_KEY, subscribeBrowser, writeBrowser } from "../browser";

const read = () => readBrowser(RECORDING_SWITCH_KEY);

export function useRecordingSwitch(base: boolean) {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  const on = raw === "on" ? true : raw === "off" ? false : base;
  const setOn = useCallback((v: boolean) => writeBrowser(RECORDING_SWITCH_KEY, v === base ? null : v ? "on" : "off"), [base]);
  return { on, setOn };
}
