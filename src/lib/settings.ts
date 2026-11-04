// 店ごとに変わる物（メニュー・営業時間・最終受付・カルテの見出し・タブの表示）は
// ここを通して読む。今は config/*.json をそのまま読むだけ。
// あとで設定の画面を足すときは、この関数の中身だけを差しかえる。

import shop from "@config/shop.json";
import menus from "@config/menus.json";
import karte from "@config/karte.json";
import tabs from "@config/tabs.json";
import ai from "@config/ai.json";
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

export type Menu = {
  id: string;
  name: string;
  minutes: number;
  price: number;
  /** 最終受付（この時刻までに始める）。無ければ「閉店 − 所要時間」まで */
  lastStart?: string;
  /** 組み合わせのメニュー（例：カット＋カラー）に入っているメニュー。メニューごとのルールはここにも効く */
  includes?: string[];
};

/** AI を呼ぶときの設定（モデル名・1回の返事の長さ・1回の相談で道具を呼ぶ回数の上限など） */
export type AiSettings = {
  model: string;
  /** 1回の返事の長さの上限（トークン） */
  maxReplyTokens: number;
  /** 1回の相談で道具を呼ぶ回数の上限 */
  maxToolCalls: number;
  /** 送ってよい会話の数 */
  maxMessages: number;
  /** お客様の1回の文の長さ（字） */
  maxMessageChars: number;
};

export function getAiSettings(): AiSettings {
  const a = ai as AiSettings;
  // モデル名は環境変数で差しかえられる（鍵と同じく .env.local）
  return { ...a, model: process.env.ANTHROPIC_MODEL || a.model };
}

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

export type TabSwitches = Record<TabId, boolean>;

/** 表示スイッチの最初の状態（config/tabs.json）。画面で変えた分はブラウザの中で重ねる */
export function getTabSwitches(): TabSwitches {
  const raw = tabs as Partial<Record<TabId, { visible: boolean }>>;
  return Object.fromEntries(TAB_IDS.map((id) => [id, raw[id]?.visible !== false])) as TabSwitches;
}

/** スイッチが入っているか。必須のタブはスイッチが切れていても出す */
export function isTabShown(id: TabId, switches: TabSwitches): boolean {
  return TABS[id].required || switches[id] !== false;
}

/** 表示スイッチが入っているタブ */
export function getVisibleTabs(switches: TabSwitches = getTabSwitches()): TabDef[] {
  return TAB_IDS.filter((id) => isTabShown(id, switches)).map((id) => TABS[id]);
}
