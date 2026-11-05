"use client";

// 発信のタブの、右の列（種類・材料）と真ん中（下書き）が分け合う物。
// 画面を開いている間だけ覚える（保存した下書きはブラウザの中に残す。state.ts）。

import { useSyncExternalStore } from "react";
import type { PostGateCheck } from "./gate";
import type { PostInsert } from "../settings";
import type { PostPeriod } from "./facts";
import type { PostTeamRecord } from "./team/types";
import type { PostsMode } from "./wire";

export type PostDraft = {
  /** 下書きの番号（作るたびに新しい。発信のチームの会議は1つの下書きに1回） */
  id?: string;
  /** 直した版の番号（チームの直しを「入れる」で変わった時だけ上がる） */
  version?: number;
  kind: string;
  /** 画面に出す文（プログラムが日時を入れた後。オーナーが手で直す） */
  text: string;
  /** 作ったときの文（手で直したかを見る） */
  made: string;
  checks: PostGateCheck[];
  inserted: PostInsert[];
  tries: number;
  cut: boolean;
  mode: PostsMode;
  /** 前：何から作ったか（材料の1つ目） */
  topic: string;
  /** お休みの日付の入れ元（材料に書いた日付か、店の設定か） */
  closedFrom?: "materials" | "shop";
  /** 材料のお休みの日付を読み取れなかった（お休みも空き枠も入れていない） */
  unreadable?: boolean;
  /** 確かめてください（材料のお休みが台帳・店の設定とぶつかる所） */
  cautions?: string[];
  /** 材料から読んだお休みの日（readOwnerClosed の dates。読めた時だけ） */
  closedDates?: string[];
  /** プログラムが入れた文字（お休み・空き枠の所に入れた言葉・足した行・ブログのリンクの印。fillPost の pieces） */
  pieces?: string[];
  /** 入れた時の空き枠とお休み（リサーチャーが今の台帳・店の設定と比べなおす） */
  openings?: string[];
  closed?: string[];
  /** 入れた時の時期（材料の「年末」など。無ければ null） */
  period?: PostPeriod | null;
  /** オーナーが手で直した（日誌と、チームの残りの候補に使う） */
  handEdited?: boolean;
  /** 発信のチームの会議の印と答え（src/lib/posts/team/state.ts） */
  team?: PostTeamRecord;
};

export type PostsDesk = {
  kind: string | null;
  /** 種類ごとの材料（key = 種類の id） */
  materials: Record<string, Record<string, string>>;
  draft: PostDraft | null;
  busy: boolean;
  mode: PostsMode;
  noAi: boolean;
  /** 作れなかったとき（門の理由） */
  failed: { kind: string; problems: string[]; checks: PostGateCheck[] } | null;
  /** うまくいかなかったときの1文 */
  problem: string | null;
};

const EMPTY: PostsDesk = { kind: null, materials: {}, draft: null, busy: false, mode: "ai", noAi: false, failed: null, problem: null };
let state: PostsDesk = EMPTY;
const listeners = new Set<() => void>();

export function setPostsDesk(f: (s: PostsDesk) => Partial<PostsDesk>): void {
  state = { ...state, ...f(state) };
  listeners.forEach((l) => l());
}

/** 「最初に戻す」：材料と下書きを消す。AI か決まった返事かの切りかえは残す */
export function resetPostsDesk(): void {
  state = { ...EMPTY, mode: state.mode };
  listeners.forEach((l) => l());
}

export function getPostsDesk(): PostsDesk {
  return state;
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

export function usePostsDesk(): PostsDesk {
  return useSyncExternalStore(subscribe, () => state, () => state);
}
