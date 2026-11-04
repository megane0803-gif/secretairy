// 「ぶつかったら厳しい方」を決める小さな関数。
// 全体・タブ・メニューの3段から、その場面に効くルールを集めて、
// 同じ種類の数のルールは厳しい方の1つにまとめる。段の上下では決めない。文のルールは全部残す。
// 判定（judge.ts）はかならずここを通したルールで行う。

import { toMinutes } from "../calendar";
import type { TabId } from "../tabs";
import type { ProgramKind, Rule, RuleCheck } from "./types";
import { STRICTER } from "./types";

export type Situation = { tab: TabId; menuIds: string[] };

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
    case "text":
      return 0;
  }
}

export function strictest<R extends Rule>(rules: R[]): R[] {
  const texts: R[] = [];
  const best = new Map<ProgramKind, R>();
  for (const r of rules) {
    if (r.check.kind === "text") {
      texts.push(r);
      continue;
    }
    const kind = r.check.kind;
    const cur = best.get(kind);
    if (!cur) {
      best.set(kind, r);
      continue;
    }
    const way = STRICTER[kind];
    if (way === "any") continue;
    const a = strictnessNumber(r.check);
    const b = strictnessNumber(cur.check);
    if (way === "higher" ? a > b : a < b) best.set(kind, r);
  }
  return [...texts, ...best.values()];
}

/** その場面で効く、ある種類のルール（厳しい方の1つ）。無ければ undefined */
export function effective<R extends Rule>(all: R[], s: Situation, kind: ProgramKind): R | undefined {
  return strictest(rulesFor(all, s)).find((r) => r.check.kind === kind);
}
