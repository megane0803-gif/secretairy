"use client";

// 画面で使う、保存した下書き（このブラウザの中だけ）。

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { POSTS_KEY, readBrowser, subscribeBrowser, writeBrowser } from "../browser";
import { parsePosts, type PostsState } from "./state";

const read = () => readBrowser(POSTS_KEY);

export function usePosts() {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  const state = useMemo(() => parsePosts(raw), [raw]);
  const update = useCallback((f: (s: PostsState) => PostsState) => {
    // 書く直前に読みなおす（別の窓で変えた分を消さないように）
    writeBrowser(POSTS_KEY, JSON.stringify(f(parsePosts(read()))));
  }, []);
  return { state, update };
}
