// ホームの「今日の注意」（朝の要点の AI の一言）の答えを、材料ごとにこのブラウザに残す（docs/SPEC.md §1.6）。
// 開き直しても材料（印・〔お客様〕にした文・オーナーのルール）が同じなら AI を呼ばない。材料が変わった時だけ呼ぶ。
// - 残すのは、AI の窓口が答えた物（門を通った一言）だけ。つながらない・混んでいる（429）時の「答え無し」は、
//   画面を開いている間だけ覚え（同じ材料で何回も呼ばない）、ブラウザには残さない（開き直したら、また頼める）。
// - 材料そのものは残さない（材料の文から作った短い印 = ハッシュだけ）。数は config/ai.json の brief.maxCachedAnswers まで（古い物から消す）。
// - 読む時は形を確かめる。画面は出す前にもう一度言葉の門を通す（BriefNotes.tsx）。
// - 「最初に戻す」では消さない（材料が違えば印も違うので、前の答えは使われない）。

import { BRIEF_KEY, readBrowser, writeBrowser } from "../browser";
import type { BriefDropped, BriefMode, BriefResult } from "./wire";

export type BriefCacheEntry = { key: string; at: string; value: BriefResult };
export type BriefCache = { v: 1; entries: BriefCacheEntry[] };

export const EMPTY_BRIEF_CACHE: BriefCache = { v: 1, entries: [] };

/** 材料の印（briefKey の文から作る短いハッシュ。材料の文そのものは残さない） */
export function briefCacheKey(key: string): string {
  // cyrb53（53 ビット）。長さもいっしょに持って、まちがって重なりにくくする
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}-${key.length.toString(36)}`;
}

const isStr = (x: unknown): x is string => typeof x === "string";

function readResult(x: unknown): BriefResult | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const mode: BriefMode | null = r.mode === "ai" || r.mode === "script" ? r.mode : null;
  if (!mode || !Array.isArray(r.notes) || !Array.isArray(r.dropped)) return null;
  const notes = r.notes.filter(isStr).slice(0, 10).map((n) => n.slice(0, 200));
  const dropped: BriefDropped[] = r.dropped
    .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
    .filter((d) => isStr(d.line) && isStr(d.reason))
    .slice(0, 10)
    .map((d) => ({ line: (d.line as string).slice(0, 200), reason: (d.reason as string).slice(0, 200) }));
  return { mode, notes, dropped };
}

/** ブラウザに残っていた文字を読む。形のおかしい物は落とす */
export function parseBriefCache(raw: string | null): BriefCache {
  if (!raw) return EMPTY_BRIEF_CACHE;
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    return EMPTY_BRIEF_CACHE;
  }
  if (!d || typeof d !== "object" || !Array.isArray((d as { entries?: unknown }).entries)) return EMPTY_BRIEF_CACHE;
  const entries: BriefCacheEntry[] = [];
  for (const e of (d as { entries: unknown[] }).entries.slice(0, 200)) {
    if (!e || typeof e !== "object") continue;
    const x = e as Record<string, unknown>;
    const value = readResult(x.value);
    if (isStr(x.key) && x.key.length <= 40 && isStr(x.at) && value) entries.push({ key: x.key, at: x.at, value });
  }
  return { v: 1, entries };
}

/** その材料の答え（無ければ undefined） */
export function cachedBrief(c: BriefCache, key: string): BriefResult | undefined {
  const k = briefCacheKey(key);
  return c.entries.find((e) => e.key === k)?.value;
}

/** 答えを足す（同じ材料の物は置きかえる。新しい順に max まで） */
export function withBriefAnswer(c: BriefCache, key: string, value: BriefResult, nowIso: string, max: number): BriefCache {
  const k = briefCacheKey(key);
  const rest = c.entries.filter((e) => e.key !== k);
  return { v: 1, entries: [{ key: k, at: nowIso, value }, ...rest].slice(0, Math.max(1, max)) };
}

export type BriefAnswerDeps = {
  /** 画面を開いている間だけの覚え（答え無し = null も覚える） */
  memory: Map<string, BriefResult | null>;
  /** AI の窓口に頼む（答え無しは null） */
  ask: () => Promise<BriefResult | null>;
  max: number;
  now?: () => Date;
};

/**
 * その材料の答え。画面の覚え → ブラウザに残した答え → AI の窓口、の順に見る。
 * fresh = AI の窓口に頼んで、いま答えが来た（日誌に書くのはこの時だけ）
 */
export async function briefAnswer(key: string, deps: BriefAnswerDeps): Promise<{ value: BriefResult | null; fresh: boolean }> {
  if (deps.memory.has(key)) return { value: deps.memory.get(key) ?? null, fresh: false };
  const kept = cachedBrief(parseBriefCache(readBrowser(BRIEF_KEY)), key);
  if (kept) {
    deps.memory.set(key, kept);
    return { value: kept, fresh: false };
  }
  const value = await deps.ask();
  deps.memory.set(key, value);
  if (value) {
    const nowIso = (deps.now?.() ?? new Date()).toISOString();
    // 書く直前に読みなおす（ほかの窓で足した分を消さない）。書けなくても画面には出す
    writeBrowser(BRIEF_KEY, JSON.stringify(withBriefAnswer(parseBriefCache(readBrowser(BRIEF_KEY)), key, value, nowIso, deps.max)));
  }
  return { value, fresh: !!value };
}

/** 画面を開いている間だけ「頼んでいる途中」の物（同じ材料で2回同時に頼まない） */
export function briefKnown(memory: Map<string, BriefResult | null>, key: string): boolean {
  return memory.has(key) || !!cachedBrief(parseBriefCache(readBrowser(BRIEF_KEY)), key);
}
