// テストで使う小さな道具。店の設定ではなく、テストのための形だけ。

import { judge, type Booking, type JudgeInput, type JudgeMenu } from "../judge";
import type { Rule, RuleCheck, RuleScope } from "../types";

export const MENUS: JudgeMenu[] = [
  { id: "m60", name: "60分のメニュー", minutes: 60 },
  { id: "m90", name: "90分のメニュー", minutes: 90 },
];

let n = 0;
export function rule(check: RuleCheck, scope: RuleScope = { level: "global" }): Rule {
  n += 1;
  return { ...scope, id: `t${n}`, label: `テストのルール${n}`, check } as Rule;
}

/** 11/4 10:00 の時点で、11/5 の予約を判定する（席は1つ・10:00–20:00） */
export function run(rules: Rule[], booking: Partial<Booking> = {}, over: Partial<JudgeInput> = {}) {
  return judge({
    rules,
    booking: { date: "2026-11-05", start: "13:00", menuIds: ["m60"], newCustomer: false, ...booking },
    now: { date: "2026-11-04", time: "10:00" },
    hours: { open: "10:00", close: "20:00" },
    seats: 1,
    menus: MENUS,
    existing: [],
    ...over,
  });
}

/** そのルールの判定の結果 */
export function resultOf(v: ReturnType<typeof run>, r: Rule) {
  return v.results.find((x) => x.rule.id === r.id);
}
