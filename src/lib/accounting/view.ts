// 経理の明細の一覧を、真ん中の一覧と右の列（登録の欄）で同じ物にする所（プログラム。画面に依らない）。
// - 架空の明細（つないでいない画面）：アプリの中の明細。印は明細の番号（item.no）で持ち、前の月までのルールで分ける
// - freee から読んだ明細：まだ処理していない明細。印は freee の明細の番号（"t<id>"）で持ち、いま効くルールで分ける
// 入金は見せるだけ（仕分けも登録もしない）。

import type { AccountingSeed, CardUse } from "../data/types";
import { stateOf, isFixed, type FreeeRecord } from "../freee/state";
import { expenseRows, freeeRows, incomeRows, seedRows, type ListedTxn, type StatementRow } from "./rows";
import { manualItems, type CardGate, type SortedStatement } from "./sort";
import { gateLive, gateOf, sortCurrent, sortLive, type AccountingState } from "./state";

export type StatementView = {
  mode: "seed" | "freee";
  /** 一覧の全部（入金も） */
  rows: StatementRow[];
  incomes: StatementRow[];
  /** 出金の仕分け */
  sorted: SortedStatement<StatementRow>;
  /** いまの店用／私用の印（freee の側は、送り始めて固定した選びを重ねる） */
  choices: Record<string, CardUse>;
  autoNext: string[];
  /** 登録の門 */
  gate: CardGate;
  /** freee の側：まだ送る出金の行（まだ・失敗）。架空の明細では出金の全部 */
  targets: StatementRow[];
};

export function seedView(seed: AccountingSeed, s: AccountingState): StatementView {
  const rows = seedRows(seed);
  return {
    mode: "seed",
    rows,
    incomes: incomeRows(rows),
    sorted: sortCurrent(seed),
    choices: s.choices,
    autoNext: s.autoNext,
    gate: gateOf(seed, s),
    targets: expenseRows(rows),
  };
}

export function liveView(seed: AccountingSeed, s: AccountingState, record: FreeeRecord, list: ListedTxn[], markPrefix: string): StatementView {
  const rows = freeeRows(list, seed.merchants, markPrefix);
  const sorted = sortLive(seed, s, rows);
  const fixed: Record<string, CardUse> = {};
  for (const r of rows) if (isFixed(record, r.key)) fixed[r.key] = record.uses![r.key];
  const targets = expenseRows(rows).filter((r) => {
    const st = stateOf(record, r.key);
    return st === "pending" || st === "failed";
  });
  const targetKeys = new Set(targets.map((t) => t.key));
  const manual = manualItems(sorted).filter((r) => targetKeys.has(r.key));
  return {
    mode: "freee",
    rows,
    incomes: incomeRows(rows),
    sorted,
    choices: { ...s.live.choices, ...fixed },
    autoNext: s.live.autoNext,
    gate: gateLive(seed, s, manual, fixed),
    targets,
  };
}
