"use client";

// カルテのタブの、真ん中（お客様・案）と右の列（施術メモ）が分け合う物。
// 画面を開いている間だけ覚える（保存したカルテはブラウザの中に残す。book/state.ts の kartes）。

import { useSyncExternalStore } from "react";
import type { KarteDraft, KarteMode } from "./wire";

/** 案（どのメモから作ったかもいっしょに持つ） */
export type DeskDraft = KarteDraft & { memo: string };

export type DeskState = {
  /** 選んでいる予約の id */
  selected: string | null;
  /** お客様・日ごとの施術メモ（key = customerId|date） */
  memos: Record<string, string>;
  drafts: Record<string, DeskDraft>;
  busy: boolean;
  mode: KarteMode;
  noAi: boolean;
  /** うまくいかなかったときの1文 */
  problem: string | null;
};

const EMPTY_DESK: DeskState = { selected: null, memos: {}, drafts: {}, busy: false, mode: "ai", noAi: false, problem: null };
let state: DeskState = EMPTY_DESK;
const listeners = new Set<() => void>();

export function deskKey(customerId: string, date: string): string {
  return `${customerId}|${date}`;
}

export function setDesk(f: (s: DeskState) => Partial<DeskState>): void {
  state = { ...state, ...f(state) };
  listeners.forEach((l) => l());
}

/** 「最初に戻す」：施術メモ（LINE から入れたメモも）・カルテの案を消す。AI か決まった返事かの切りかえは残す */
export function resetDesk(): void {
  state = { ...EMPTY_DESK, mode: state.mode };
  listeners.forEach((l) => l());
}

export function getDesk(): DeskState {
  return state;
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

export function useDesk(): DeskState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}
