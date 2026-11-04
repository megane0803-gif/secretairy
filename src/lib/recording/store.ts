// 録音の置き場所を1つにする所。ブラウザでは IndexedDB、テスト（IndexedDB の無い所）では手元の置き場所。
// 「最初に戻す」（src/lib/reset.ts）はここの resetRecordings を呼び、動いている物を止めて全部消す。

import { idbRecordingStore } from "./idb";
import { memoryRecordingStore, type RecordingStore } from "./job";

let store: RecordingStore | null = null;
const stoppers = new Set<() => void>();
const resetListeners = new Set<() => void>();

export function getRecordingStore(): RecordingStore {
  if (!store) store = typeof indexedDB !== "undefined" ? idbRecordingStore() : memoryRecordingStore();
  return store;
}

/** テスト用：置き場所を差しかえる */
export function setRecordingStore(s: RecordingStore | null): void {
  store = s;
}

/** 動いている物（文字にする・録音・フォルダを見る）を「最初に戻す」で止められるように登録する */
export function onRecordingReset(stop: () => void): () => void {
  stoppers.add(stop);
  return () => stoppers.delete(stop);
}

/** 消し終わった後に画面を読みなおすため */
export function onRecordingCleared(f: () => void): () => void {
  resetListeners.add(f);
  return () => resetListeners.delete(f);
}

/** 「最初に戻す」：動いている物を止め、残した文字・要点・録音の区切り・読んだ印・録音フォルダを消す */
export async function resetRecordings(): Promise<void> {
  for (const s of [...stoppers]) {
    try {
      s();
    } catch {
      // 止められなくても消すのは続ける
    }
  }
  try {
    await getRecordingStore().clear();
  } catch {
    // 消せないブラウザ（内緒モードなど）でも画面は動くようにする
  }
  resetListeners.forEach((f) => f());
}
