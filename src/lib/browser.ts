// 見ている人のブラウザの中だけに残す置き場所（docs/SPEC.md §5.1）。
// サーバーには送らない。読めない・書けないブラウザ（内緒モードなど）でも画面は動くようにする。

const PREFIX = "secretairy:";
const listeners = new Set<() => void>();

export function readBrowser(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function writeBrowser(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(PREFIX + key);
    else window.localStorage.setItem(PREFIX + key, value);
  } catch {
    // 書けないときは、この画面を開いている間だけ効く
  }
  listeners.forEach((f) => f());
}

/** useSyncExternalStore 用 */
export function subscribeBrowser(f: () => void): () => void {
  listeners.add(f);
  const onStorage = (e: StorageEvent) => {
    if (!e.key || e.key.startsWith(PREFIX)) f();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(f);
    window.removeEventListener("storage", onStorage);
  };
}

/** 左のタブを畳んだか・右の列の幅。画面を開いた瞬間に効かせるため layout.tsx の小さな script からも読む */
export const NAV_KEY = "navCollapsed";
export const RIGHT_KEY = "rightWidth";
export const TABS_KEY = "tabSwitches";
export const BROWSER_PREFIX = PREFIX;
