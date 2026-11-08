// ホームの「今日の注意」（朝の要点の AI の一言）が AI の窓口（/api/ai/brief）を呼ぶ間合いと、待つ間に出す行（直しY・docs/SPEC.md §1.6）。
// 画面に依らない形（画面は src/app/home/BriefNotes.tsx。テストは作り物の時計で同じ物を通す）。
// /api/ai/ の窓口は Vercel の入口で同じ IP から1分10回まで。材料（承認・ToDo の済み など）が変わるたびに呼ぶと、
// 予約チャットや広告の見直しの回数を朝の一言が使ってしまうので、呼ぶのを config/ai.json の brief.minIntervalSeconds に1回までにする。
// - その間に材料が変わったら、秒数がたった後に、いちばん新しい材料で1回だけ呼ぶ（間の材料では呼ばない）。
// - 開いた時の1回目と、「翌日へ」で今日が変わった後は今どおり（材料が少しずつ変わる間の短い待ち BRIEF_SETTLE_MS だけで呼ぶ）。
// - 答えがもうある材料（画面の覚え・ブラウザに残した答え。brief/cache.ts）は窓口を呼ばないので、待たずに出し、数えない。
// - 待っている間は、前に出した一言（画面でもう一度門を通し、印を日時・お名前に置きかえた行）を出す。今日が変わった後は出さない。
// - 間合いは画面を開いている間だけ覚える（読み込み直したら、また「開いた時の1回目」）。

import { briefAnswer, briefKnown } from "./cache";
import { gateBriefLine } from "./gate";
import { fillMarks, type BriefMaterial } from "./items";
import type { BriefResult } from "./wire";

/** 材料が少しずつ変わる間の短い待ち（ミリ秒。直しY の前と同じ） */
export const BRIEF_SETTLE_MS = 1200;

/** 最後に AI の窓口を呼んだ時刻（ミリ秒）と、その時の今日（「翌日へ」で変わったかを見る） */
export type BriefPace = { lastAt: number | null; lastDay: string | null };

export function newBriefPace(): BriefPace {
  return { lastAt: null, lastDay: null };
}

/** 答えがまだ無い材料で、窓口を呼ぶまで待つミリ秒。1回目と今日が変わった後は短い待ちだけ。それ以外は前に呼んでから決めた秒数がたつまで */
export function briefWaitMs(pace: BriefPace, today: string, nowMs: number, minIntervalSeconds: number): number {
  if (pace.lastAt === null || pace.lastDay !== today) return BRIEF_SETTLE_MS;
  return Math.max(BRIEF_SETTLE_MS, pace.lastAt + minIntervalSeconds * 1000 - nowMs);
}

export type BriefWantDeps = {
  /** 画面を開いている間の間合い（タブを移っても同じ物） */
  pace: BriefPace;
  /** 画面を開いている間の覚え（答え無し = null も覚える。brief/cache.ts） */
  memory: Map<string, BriefResult | null>;
  /** ブラウザに残しておく答えの数（config/ai.json の brief.maxCachedAnswers） */
  max: number;
  /** AI の窓口に頼む（答え無しは null）。この材料の物 */
  call: () => Promise<BriefResult | null>;
  minIntervalSeconds: number;
  now: () => number;
  setTimer: (f: () => void, ms: number) => number;
  clearTimer: (t: number) => void;
};

/**
 * 材料（key）の答えを頼む。返すのは、やめる時の関数（材料が変わった・画面を閉じた：待っている物はやめ、届いた答えは出さない）。
 * 答えがもうある材料はすぐ出す（窓口を呼ばない）。無い材料は briefWaitMs だけ待ってから呼ぶ（待つ間に材料が変わったら、やめて新しい材料で待ちなおす。
 * 前に呼んだ時刻は変わらないので、待つのは前に呼んでから決めた秒数がたつまでのまま）。
 */
export function wantBrief(key: string, today: string, deps: BriefWantDeps, done: (r: { value: BriefResult | null; fresh: boolean }) => void): () => void {
  let stop = false;
  const ask = () => {
    // 窓口を呼んだ時だけ数える（残した答えを出した時は数えない）
    deps.pace.lastAt = deps.now();
    deps.pace.lastDay = today;
    return deps.call();
  };
  const run = async () => {
    const r = await briefAnswer(key, { memory: deps.memory, ask, max: deps.max });
    if (!stop) done(r);
  };
  if (briefKnown(deps.memory, key)) {
    void run();
    return () => {
      stop = true;
    };
  }
  const t = deps.setTimer(() => void run(), briefWaitMs(deps.pace, today, deps.now(), deps.minIntervalSeconds));
  return () => {
    stop = true;
    deps.clearTimer(t);
  };
}

/** 画面に出す一言の行：もう一度門を通し（gateBriefLine）、印を日時・お名前に置きかえ（知らない印のある行は使わない）、数の上限まで */
export function shownBriefNotes(value: BriefResult | null, material: BriefMaterial, limits: { maxNoteChars: number; maxNotes: number }): string[] {
  return (value?.notes ?? [])
    .filter((n) => gateBriefLine(n, material.items, limits.maxNoteChars) === null)
    .map((n) => fillMarks(n, material.labels))
    .filter((n): n is string => n !== null)
    .slice(0, limits.maxNotes);
}

/** 前に出した一言（画面でもう一度門を通し、印を置きかえた行）と、その時の今日 */
export type BriefLastShown = { today: string; lines: string[] };

/**
 * 出す行。今の材料の答えが届いていればその行（答え無しなら出さない）。待っている間は、前に出した一言（同じ今日の物だけ。
 * 「翌日へ」で今日が変わった後は、前の日の一言を出さない＝今どおり）。
 */
export function briefShown(now: { today: string; resolved: boolean; lines: string[] }, last: BriefLastShown | null): string[] {
  if (now.resolved) return now.lines;
  return last && last.today === now.today ? last.lines : [];
}
