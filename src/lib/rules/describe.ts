// ルールを画面の言葉にする所（種類の名前・札・ルールの文）。

import { TABS } from "../tabs";
import type { Rule, RuleCheck, RuleKind, RuleScope } from "./types";

export const KIND_INFO: Record<RuleKind, { name: string; example: string }> = {
  minLeadMinutes: { name: "何分前まで", example: "予約は来店の3時間前まで" },
  maxNewCustomersPerDay: { name: "1日の上限（初めての方）", example: "初めてのお客様は1日4人まで" },
  bufferAfterMinutes: { name: "間を空ける", example: "カラーの後は15分あける" },
  noSameDay: { name: "当日の予約は不可", example: "来店と同じ日の予約は受けない" },
  lastStart: { name: "最終受付", example: "縮毛矯正の最終受付は16:00" },
  notTogether: { name: "いっしょに受けない組み合わせ", example: "縮毛矯正とパーマは同じ日に受けない" },
  text: { name: "文（AI が読む）", example: "お客様の顔が分かる写真は載せない" },
};

/** 180 → 「3時間」、1440 → 「24時間」、2880 → 「2日」、45 → 「45分」 */
export function formatMinutes(m: number): string {
  if (m >= 2880 && m % 1440 === 0) return `${m / 1440}日`;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h}時間${r}分` : `${h}時間`;
  }
  return `${m}分`;
}

/** どこに効くかの札 */
export function scopeTag(r: RuleScope, menuName: (id: string) => string): string {
  if (r.level === "global") return "全体";
  if (r.level === "tab") return `タブ：${TABS[r.tab].label}`;
  return `メニュー：${menuName(r.menuId)}`;
}

/** 型のルールの文。数を直したら文も一緒に変わるように、型と数から作る */
export function labelFor(scope: RuleScope, check: Exclude<RuleCheck, { kind: "text" }>, menuName: (id: string) => string): string {
  const menu = scope.level === "menu" ? menuName(scope.menuId) : null;
  switch (check.kind) {
    case "minLeadMinutes":
      return `${menu ? `${menu}の予約` : "予約"}は来店の${formatMinutes(check.value)}前まで`;
    case "maxNewCustomersPerDay":
      return `初めてのお客様は1日${check.value}人まで`;
    case "bufferAfterMinutes":
      return `${menu ?? "施術"}の後は${check.value}分あける`;
    case "noSameDay":
      return `${menu ? `${menu}は` : ""}来店と同じ日の予約は受けない`;
    case "lastStart":
      return `${menu ? `${menu}の` : ""}最終受付は${check.time}`;
    case "notTogether":
      return `${menu ?? "このメニュー"}と${menuName(check.with)}は同じ日に受けない`;
  }
}

/** ルールの数の部分を短く（一覧の小さな字に使う） */
export function valueText(r: Rule): string | null {
  const c = r.check;
  switch (c.kind) {
    case "minLeadMinutes":
      return `${formatMinutes(c.value)}前`;
    case "maxNewCustomersPerDay":
      return `${c.value}人`;
    case "bufferAfterMinutes":
      return `${c.value}分`;
    case "lastStart":
      return c.time;
    case "noSameDay":
    case "notTogether":
    case "text":
      return null;
  }
}
