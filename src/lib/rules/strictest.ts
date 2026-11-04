// 「ぶつかったら厳しい方」を決める小さな関数。
// 全体・タブ・メニューの3段から、その場面に効くルールを集めて、
// 同じ種類の数のルールは厳しい方の1つにまとめる。段の上下では決めない。文のルールは全部残す。
// 判定（judge.ts）はかならずここを通したルールで行う。

import { toMinutes } from "../calendar";
import type { TabId } from "../tabs";
import type { ProgramKind, Rule, RuleCheck } from "./types";
import { STRICTER } from "./types";

export type Situation = { tab: TabId; menuIds: string[] };

/**
 * メニューの並びを、組み合わせに入っているメニューも足して広げる（例：cut_color → cut_color・cut・color）。
 * メニューごとのルールは、そのメニューを含む組み合わせのメニューにも効かせるため。組み合わせの中身は config/menus.json の includes。
 */
export function expandMenuIds(ids: string[], menus: { id: string; includes?: string[] }[]): string[] {
  const out = new Set<string>();
  const add = (id: string, depth: number) => {
    if (out.has(id) || depth > 4) return;
    out.add(id);
    for (const sub of menus.find((m) => m.id === id)?.includes ?? []) add(sub, depth + 1);
  };
  for (const id of ids) add(id, 0);
  return [...out];
}

export function rulesFor<R extends Rule>(all: R[], s: Situation): R[] {
  return all.filter(
    (r) =>
      r.level === "global" ||
      (r.level === "tab" && r.tab === s.tab) ||
      (r.level === "menu" && s.menuIds.includes(r.menuId)),
  );
}

/** 厳しさを比べるための数。数を持たない種類は 0 */
export function strictnessNumber(check: RuleCheck): number {
  switch (check.kind) {
    case "minLeadMinutes":
    case "maxNewCustomersPerDay":
    case "bufferAfterMinutes":
      return check.value;
    case "lastStart":
      return toMinutes(check.time);
    case "noSameDay":
    case "notTogether":
    case "text":
      return 0;
  }
}

/**
 * 「1つでもあれば効く」（any）の種類で、同じ物とみなす印。
 * 「いっしょに受けない組み合わせ」は2つのメニューごとに中身がちがうので、組み合わせごとに1つずつ残す
 * （同じ2つなら、どちらのメニューに付けたルールでも1つにまとめる）。
 */
function anyKey(r: Rule): string {
  return r.check.kind === "notTogether" && r.level === "menu"
    ? `notTogether|${[r.menuId, r.check.with].sort().join("|")}`
    : r.check.kind;
}

export function strictest<R extends Rule>(rules: R[]): R[] {
  const texts: R[] = [];
  const best = new Map<string, R>();
  for (const r of rules) {
    if (r.check.kind === "text") {
      texts.push(r);
      continue;
    }
    const kind = r.check.kind;
    const way = STRICTER[kind];
    const key = way === "any" ? anyKey(r) : kind;
    const cur = best.get(key);
    if (!cur) {
      best.set(key, r);
      continue;
    }
    if (way === "any") continue;
    const a = strictnessNumber(r.check);
    const b = strictnessNumber(cur.check);
    if (way === "higher" ? a > b : a < b) best.set(key, r);
  }
  return [...texts, ...best.values()];
}

/** その場面で効く、ある種類のルール（厳しい方の1つ）。無ければ undefined */
export function effective<R extends Rule>(all: R[], s: Situation, kind: ProgramKind): R | undefined {
  return strictest(rulesFor(all, s)).find((r) => r.check.kind === kind);
}
