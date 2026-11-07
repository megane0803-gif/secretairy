// 売りの言葉（docs/SPEC.md §1.7.5）。売りのメニュー（config/ads.json の featuredMenus）の、メニューの名前（config/menus.json の name）。
// 調べた言葉に売りの言葉が入っているか（空白を除いて比べる）の確かめは、ここの featuredWordIn の1か所。
// 足す案の候補（add.ts）・本物の広告に渡す形の書き出し（connect.ts）・本物の広告の中で動かす見本のスクリプト
// （connect/google-ads/secretairy-sync.js）は、みなこれを使う。
// 見本のスクリプトは広告の管理画面に貼って動かす1つのファイルで、ここを読み込めないので、本体（<same> の間）を
// そのまま写してある。2つが1字も違わないことはテスト（__tests__/connect.test.ts）で確かめる。

import type { AdSettings, Menu } from "../settings";

/** 売りの言葉（売りのメニューの名前。設定に無い id は飛ばす） */
export function featuredWords(settings: Pick<AdSettings, "featuredMenus">, menus: readonly Pick<Menu, "id" | "name">[]): string[] {
  return settings.featuredMenus.map((id) => menus.find((m) => m.id === id)?.name ?? "").filter((n) => n.trim() !== "");
}

/** その言葉に入っている売りの言葉（無ければ null）。空白（全角も）を除いて比べる */
export function featuredWordIn(text: string, words: readonly string[]): string | null {
  // <same>
  const plain = String(text == null ? "" : text).replace(/\s+/g, "");
  for (const w of words) {
    const word = String(w == null ? "" : w).replace(/\s+/g, "");
    if (word !== "" && plain.includes(word)) return w;
  }
  return null;
  // </same>
}
