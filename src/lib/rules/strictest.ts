// 「ぶつかったら厳しい方」を決める小さな関数。
// 全体・タブ・メニューの3段から、その場面に効くルールを集めて、
// 同じ種類の数のルールは厳しい方の1つにまとめる。文のルールは全部残す。

import type { Rule, RuleKind } from "./types";
import { STRICTER } from "./types";
import type { TabId } from "../tabs";

export type Situation = { tab: TabId; menuIds: string[] };

export function rulesFor(all: Rule[], s: Situation): Rule[] {
  return all.filter(
    (r) =>
      r.level === "global" ||
      (r.level === "tab" && r.tab === s.tab) ||
      (r.level === "menu" && s.menuIds.includes(r.menuId)),
  );
}

export function strictest(rules: Rule[]): Rule[] {
  const texts: Rule[] = [];
  const best = new Map<Exclude<RuleKind, "text">, Rule>();
  for (const r of rules) {
    if (r.check.kind === "text") {
      texts.push(r);
      continue;
    }
    const kind = r.check.kind;
    const cur = best.get(kind);
    if (!cur || cur.check.kind === "text") {
      best.set(kind, r);
      continue;
    }
    const higher = STRICTER[kind] === "higher";
    const a = r.check.value;
    const b = cur.check.value;
    if (higher ? a > b : a < b) best.set(kind, r);
  }
  return [...texts, ...best.values()];
}
