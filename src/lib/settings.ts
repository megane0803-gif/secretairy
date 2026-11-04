// 店ごとに変わる物（メニュー・営業時間・最終受付・カルテの見出し・タブの表示）は
// ここを通して読む。今は config/*.json をそのまま読むだけ。
// あとで設定の画面を足すときは、この関数の中身だけを差しかえる。

import shop from "@config/shop.json";
import menus from "@config/menus.json";
import karte from "@config/karte.json";
import tabs from "@config/tabs.json";
import ai from "@config/ai.json";
import ads from "@config/ads.json";
import accounting from "@config/accounting.json";
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
  /** カルテ自動作成（Haiku） */
  karte: KarteAiSettings;
};

export type KarteAiSettings = {
  model: string;
  /** 1回の返事の長さの上限（トークン） */
  maxReplyTokens: number;
  /** 施術メモの長さの上限（字） */
  maxMemoChars: number;
};

export function getAiSettings(): AiSettings {
  const a = ai as AiSettings;
  // モデル名は環境変数で差しかえられる（鍵と同じく .env.local）
  return {
    ...a,
    model: process.env.ANTHROPIC_MODEL || a.model,
    karte: { ...a.karte, model: process.env.ANTHROPIC_KARTE_MODEL || a.karte.model },
  };
}

/** 施術メモの長さの上限（字）。画面でも使う（鍵や環境変数は読まない） */
export function getMemoMaxChars(): number {
  return (ai as AiSettings).karte.maxMemoChars;
}

export type KarteHeading = {
  id: string;
  label: string;
  note?: string;
  /** next = 次回提案（保存のとき ToDo「次回話すこと」に1行目を足す・朝の要点に出す） */
  role?: "next";
  /** 決まった返事（AI なし）で、メモの文をこの見出しに分ける手がかりの言葉 */
  hints?: string[];
};

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

/** 広告のタブの設定（config/ads.json） */
export type AdSettings = {
  /** どこに出している広告か（画面の札） */
  channel: string;
  /** 売りのメニュー（その言葉に「売り」の印を出す） */
  featuredMenus: string[];
  /** 架空の町の名前。この名前が入った言葉は「外す」案にしない */
  towns: string[];
  /** 承認してから何日後に「効いたか見る」の ToDo の期限にするか */
  checkAfterDays: number;
  /** 案は何日に1つまでか */
  oncePerDays: number;
};

export function getAdSettings(): AdSettings {
  return ads as AdSettings;
}

/** 広告の見直しで AI を呼ぶときの上限（config/ai.json の ads） */
export type AdsAiSettings = {
  model: string;
  /** 1回の返事の長さの上限（トークン） */
  maxReplyTokens: number;
};

export function getAdsAiSettings(): AdsAiSettings {
  const a = ai as { ads?: { maxReplyTokens?: number } };
  return { model: getAiSettings().model, maxReplyTokens: a.ads?.maxReplyTokens ?? 600 };
}

/** 経理のタブの設定（config/accounting.json）。実在の会計サービスの名前は書かない */
export type AccountingSettings = {
  /** 明細を取り込み、登録する先（画面の札。例「会計（架空）」） */
  service: string;
  /** 明細の出どころ（例「カード会社（架空）」） */
  cardSource: string;
};

export function getAccountingSettings(): AccountingSettings {
  return accounting as AccountingSettings;
}
