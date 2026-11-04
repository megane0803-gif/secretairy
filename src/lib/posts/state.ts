// 発信：保存した下書きを、見ている人のブラウザの中だけに残す形（secretairy:posts。docs/SPEC.md §5.1）。
// ここは形と変え方だけ（どこにも書かない）。書くのは usePosts.ts と画面の部品。
// 保存はオーナーのボタンだけ（承認の箱は通さない）。送信・公開はしない。

import { gateWordsIn } from "./gate";
import type { PostsMode } from "./wire";

export type SavedPost = {
  id: string;
  /** 種類（config/posts.json の kinds の id） */
  kind: string;
  text: string;
  /** 保存した時刻（ISO） */
  at: string;
  /** だれが下書きを作ったか（AI / 決まった返事） */
  mode: PostsMode;
};

export type PostsState = { v: 1; saved: SavedPost[] };

export const EMPTY_POSTS: PostsState = { v: 1, saved: [] };

const MAX_TEXT = 6000;
const isStr = (x: unknown): x is string => typeof x === "string";

/** ブラウザに残っていた文字を読む。形のおかしい物は落とす */
export function parsePosts(raw: string | null): PostsState {
  if (!raw) return EMPTY_POSTS;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(raw);
  } catch {
    return EMPTY_POSTS;
  }
  if (!d || typeof d !== "object" || d.v !== 1 || !Array.isArray(d.saved)) return EMPTY_POSTS;
  const saved: SavedPost[] = [];
  for (const p of d.saved as unknown[]) {
    if (!p || typeof p !== "object") continue;
    const x = p as Record<string, unknown>;
    if (!isStr(x.id) || !isStr(x.kind) || !isStr(x.text) || !isStr(x.at)) continue;
    saved.push({ id: x.id, kind: x.kind, text: x.text.slice(0, MAX_TEXT), at: x.at, mode: x.mode === "script" ? "script" : "ai" });
  }
  return { v: 1, saved };
}

/** 同じ文か（前後の空白・空白の数のちがい・全角半角のちがいは同じとみなす） */
export function sameText(a: string, b: string): boolean {
  const n = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim();
  return n(a) === n(b);
}

export type SaveResult =
  | { ok: true; state: PostsState; post: SavedPost }
  | { ok: false; code: "empty" | "dup" | "words" | "full"; reason: string };

/**
 * 🔒 オーナーが「下書きを保存」を押したときだけ呼ぶ。
 * 同じ文はもう一度保存しない。手で直した文に使わない言葉が入っていたら保存しない。種類ごとに maxPerKind 件まで。
 */
export function withSavedPost(
  s: PostsState,
  draft: { kind: string; text: string; mode: PostsMode },
  opts: { id: string; nowIso: string; gateWords: string[]; maxPerKind: number },
): SaveResult {
  const text = draft.text.replace(/\r\n?/g, "\n").trim();
  if (!text) return { ok: false, code: "empty", reason: "下書きが空です" };
  if (s.saved.some((p) => sameText(p.text, text))) return { ok: false, code: "dup", reason: "同じ文はもう保存してあります" };
  const hit = gateWordsIn(text, opts.gateWords);
  if (hit.length) return { ok: false, code: "words", reason: `${hit.map((w) => `「${w}」`).join("")}は使わない言葉です。直してから保存してください` };
  if (s.saved.filter((p) => p.kind === draft.kind).length >= opts.maxPerKind)
    return { ok: false, code: "full", reason: `この種類は${opts.maxPerKind}件まで保存できます` };
  const post: SavedPost = { id: opts.id, kind: draft.kind, text: text.slice(0, MAX_TEXT), at: opts.nowIso, mode: draft.mode };
  return { ok: true, state: { v: 1, saved: [post, ...s.saved] }, post };
}

/** 種類ごとに分けて、新しい順 */
export function savedByKind(s: PostsState, kinds: { id: string }[]): Record<string, SavedPost[]> {
  const out: Record<string, SavedPost[]> = Object.fromEntries(kinds.map((k) => [k.id, [] as SavedPost[]]));
  for (const p of [...s.saved].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))) (out[p.kind] ??= []).push(p);
  return out;
}
