// 予約の台帳の帯の色（メニューごと）。見た目だけの決まりで、画面に依らない。
// どのメニューがどの色かは店の設定（config/menus.json の color）で決め、色の値は globals.css の変数（--menu-<名前>）に置く。
// 設定に色の無いメニュー・知らない名前・設定に無い組み合わせ（cut+headspa など）は灰色（none）。落ちない。
// だれが入れたか（人・外・AI）は色ではなく帯の頭の札（「人」「外」「AI」の文字の札）で見せる（§3.4）。

import type { Menu } from "../settings";

/** globals.css に値（明るい画面と暗い画面）を置いている色の名前 */
export const MENU_COLORS = ["sky", "purple", "pink", "green", "rose", "olive"] as const;

export type MenuColor = (typeof MENU_COLORS)[number] | "none";

const KNOWN = new Set<string>(MENU_COLORS);

/** そのメニューの帯の色の名前。無い・知らない名前は "none"（灰色） */
export function menuColorOf(menu: Pick<Menu, "color"> | null | undefined): MenuColor {
  const c = menu?.color;
  return typeof c === "string" && KNOWN.has(c) ? (c as MenuColor) : "none";
}

/** 帯・カード・凡例に付ける class（globals.css の .menu-c-<名前> が --menu を決める） */
export function menuColorClass(menu: Pick<Menu, "color"> | null | undefined): string {
  return `menu-c-${menuColorOf(menu)}`;
}

/** 台帳の題名の下の凡例：設定の順に、メニュー名と色 */
export function menuLegend(menus: Pick<Menu, "id" | "name" | "color">[]): { id: string; name: string; color: MenuColor }[] {
  return menus.map((m) => ({ id: m.id, name: m.name, color: menuColorOf(m) }));
}
