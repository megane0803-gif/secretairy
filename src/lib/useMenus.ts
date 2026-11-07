"use client";

// 画面で使う「メニュー」（時間・値段・最終受付）。最初の状態（config/menus.json）に、このブラウザで直した分を重ね、足したメニューを足す（menuEdits.ts）。
// 書くのはこのブラウザの中だけ。保存したらすぐ、どの画面の次の判定・表示にも効く（useBook の data.menus に重なる）。
// メニューを読む所は、このフックを直に使わず、useBook の data.menus を通す（読む入口を1つにする）。

import { useMemo, useSyncExternalStore } from "react";
import { readBrowser, subscribeBrowser } from "./browser";
import { MENUS_KEY, menusMark, parseMenuEdits, readMenuStore } from "./menuEdits";
import { getMenus, getShop } from "./settings";

const read = () => readBrowser(MENUS_KEY);

/** いまこのブラウザに残っているメニューの設定の印（予約チャットの返事を始めた時と比べる。直していなければ ""） */
export function currentMenusMark(): string {
  const base = getMenus();
  return menusMark(parseMenuEdits(read(), base, getShop()), base, getShop());
}

export function useMenus() {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  const base = getMenus();
  // menus = 設定のメニューに直した分を重ね、足したメニューを後ろに並べた物。seq = 足したメニューに付けた番号（消しても使い回さない）
  const { menus, seq } = useMemo(() => readMenuStore(raw, getMenus(), getShop()), [raw]);
  const mark = useMemo(() => menusMark(menus, getMenus(), getShop()), [menus]);

  // 書くのはオーナーの「保存」ボタンだけ（menuEdits.ts の commitMenus。書けた時だけ日誌に書く）
  return { menus, base, mark, seq };
}
