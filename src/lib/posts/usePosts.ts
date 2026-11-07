"use client";

// 画面で使う、保存した下書き（このブラウザの中だけ）。

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { POSTS_KEY, readBrowser, subscribeBrowser, writeBrowser, type BrowserWrite } from "../browser";
import type { PostSaveDeps } from "./save";
import { parsePosts, type PostsState } from "./state";

const read = () => readBrowser(POSTS_KEY);

/** 画面で使う、③「下書きを保存」の書く所（save.ts の savePostDraft に渡す）。日誌は呼ぶ側で渡す */
export const browserPostsStore: Pick<PostSaveDeps, "read" | "write"> = {
  read: () => parsePosts(read()),
  write: (s: PostsState): BrowserWrite => writeBrowser(POSTS_KEY, JSON.stringify(s)),
};

export function usePosts() {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  const state = useMemo(() => parsePosts(raw), [raw]);
  const update = useCallback((f: (s: PostsState) => PostsState): BrowserWrite => {
    // 書く直前に読みなおす（別の窓で変えた分を消さないように）。書けたかを返す
    return writeBrowser(POSTS_KEY, JSON.stringify(f(parsePosts(read()))));
  }, []);
  return { state, update };
}
