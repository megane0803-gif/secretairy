// 8つのタブ。並びと名前は仕組みの側で決める（店ごとに変わらない）。
// 「出す・隠す」だけは店の設定（config/tabs.json）で持つ。

export const TAB_IDS = [
  "home",
  "reservations",
  "karte",
  "ads",
  "accounting",
  "todo",
  "posts",
  "rules",
] as const;

export type TabId = (typeof TAB_IDS)[number];

export type TabDef = {
  id: TabId;
  label: string;
  icon: string;
  path: string;
  /** 必須の5つにかかわるタブ。隠せない */
  required: boolean;
};

export const TABS: Record<TabId, TabDef> = {
  home: { id: "home", label: "ホーム", icon: "🏠", path: "/home", required: true },
  reservations: { id: "reservations", label: "予約", icon: "📅", path: "/reservations", required: true },
  karte: { id: "karte", label: "カルテ", icon: "📋", path: "/karte", required: true },
  ads: { id: "ads", label: "広告", icon: "📣", path: "/ads", required: false },
  accounting: { id: "accounting", label: "経理", icon: "💴", path: "/accounting", required: false },
  todo: { id: "todo", label: "ToDo", icon: "✅", path: "/todo", required: false },
  posts: { id: "posts", label: "発信", icon: "✏️", path: "/posts", required: false },
  rules: { id: "rules", label: "ルール", icon: "📏", path: "/rules", required: true },
};
