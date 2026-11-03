// 店ごとに変わる物（メニュー・営業時間・カルテの見出し・タブの表示）は
// ここを通して読む。今は config/*.json をそのまま読むだけ。
// あとで設定の画面を足すときは、この関数の中身だけを差しかえる。

import shop from "@config/shop.json";
import menus from "@config/menus.json";
import karte from "@config/karte.json";
import tabs from "@config/tabs.json";
import { TAB_IDS, TABS, type TabDef, type TabId } from "./tabs";

export type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type Hours = { open: string; close: string } | null;

export type ShopSettings = {
  name: string;
  timezone: string;
  seats: number;
  slotMinutes: number;
  holdExpiresHours: number;
  hours: Record<DayKey, Hours>;
  closedDates: string[];
};

export type Menu = { id: string; name: string; minutes: number; price: number };

export type KarteHeading = { id: string; label: string; note?: string };

export function getShop(): ShopSettings {
  return shop as ShopSettings;
}

export function getMenus(): Menu[] {
  return menus as Menu[];
}

export function getKarteHeadings(): KarteHeading[] {
  return (karte as { headings: KarteHeading[] }).headings;
}

/** 表示スイッチが入っているタブ。必須のタブはスイッチが切れていても出す */
export function getVisibleTabs(): TabDef[] {
  const switches = tabs as Record<TabId, { visible: boolean }>;
  return TAB_IDS.map((id) => TABS[id]).filter(
    (t) => t.required || switches[t.id]?.visible !== false,
  );
}

export function isTabVisible(id: TabId): boolean {
  return getVisibleTabs().some((t) => t.id === id);
}
