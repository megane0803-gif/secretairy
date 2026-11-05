"use client";

// 画面で使うホームの欄の開け閉め。覚えた物（secretairy:homeFolds）と、いまの幅（PC かスマホか）から決める。
// サーバーと最初の描画では null（まだ分からない）を返す。その間は globals.css が PC／スマホの最初の状態で見せ分ける。
// 覚えるのは人が見出しを押した時だけ（最初の描画で、覚えた物を最初の状態で上書きしない）。

import { useCallback, useSyncExternalStore } from "react";
import { HOME_FOLDS_KEY, readBrowser, subscribeBrowser, writeBrowser } from "../browser";
import { foldOpen, HOME_PC_MIN_WIDTH, parseFolds, withFold, type HomeDevice, type HomeFoldId } from "./folds";

const PC_QUERY = `(min-width: ${HOME_PC_MIN_WIDTH}px)`;

const readFolds = () => readBrowser(HOME_FOLDS_KEY);

function subscribeDevice(f: () => void): () => void {
  const m = window.matchMedia(PC_QUERY);
  m.addEventListener("change", f);
  return () => m.removeEventListener("change", f);
}
const readDevice = (): HomeDevice => (window.matchMedia(PC_QUERY).matches ? "pc" : "phone");

export function useHomeFold(id: HomeFoldId): { open: boolean | null; set: (open: boolean) => void } {
  const raw = useSyncExternalStore(subscribeBrowser, readFolds, () => null);
  const device = useSyncExternalStore<HomeDevice | null>(subscribeDevice, readDevice, () => null);
  const open = device ? foldOpen(id, device, parseFolds(raw)) : null;
  const set = useCallback((v: boolean) => writeBrowser(HOME_FOLDS_KEY, withFold(readBrowser(HOME_FOLDS_KEY), id, v)), [id]);
  return { open, set };
}

/** ほかの部品から1つの欄を開く（「まとめて動かす」で「AI に頼める仕事」を開く） */
export function openHomeFold(id: HomeFoldId): void {
  writeBrowser(HOME_FOLDS_KEY, withFold(readBrowser(HOME_FOLDS_KEY), id, true));
}
