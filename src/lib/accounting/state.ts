// 経理（カード・銀行の明細の仕分け）を、見ている人のブラウザの中だけに残す形（docs/SPEC.md §5.1）。
// 架空の明細の印（choices・autoNext。鍵は明細の番号 item.no）と、freee から読んだ明細の印（live。鍵は "t<wallet_txn の id>"）は混ぜない。
// ここは形と変え方だけ（どこにも書かない）。書くのは useAccounting.ts と画面の部品。
//
// 承認BOXは使わない（ホームの「承認待ち」にも入れない）。AI の予想も使わない。
// 🔒 確定は人：会計への登録（register）を呼ぶのは、人が画面の「会計に登録」を押したときだけ。
// AI・サーバー・自動の処理からは呼ばない。

import type { AccountingSeed, CardItem, CardUse, MerchantRule } from "../data/types";
import type { JournalWho } from "../journal";
import { expenseRows, isTxnKey, seedRows, type SeedRow, type StatementRow } from "./rows";
import { checkChoices, manualItems, manualMerchants, ruleLabel, sortStatement, type CardGate, type Sortable, type SortedStatement } from "./sort";

/** 登録で足した自動のルール */
export type AddedRule = MerchantRule & { addedAt: string };

/** 会計に登録した記録 */
export type Registration = {
  at: string;
  total: number;
  auto: number;
  manual: number;
  /** 店用の合計（円） */
  shopAmount: number;
  /** 私用の合計（円） */
  privateAmount: number;
  /** この登録で足した自動のルール */
  added: MerchantRule[];
};

/** freee（テスト事業所）から読んだ明細で人が選んだ印（鍵は "t<wallet_txn の id>"。架空の明細の番号とは混ぜない） */
export type LiveChoices = {
  choices: Record<string, CardUse>;
  /** 「次から自動」に印を付けた購入先 */
  autoNext: string[];
};

export type AccountingState = {
  v: 1;
  /** 人が選んだ印（架空の明細の番号 → 店用 / 私用） */
  choices: Record<string, CardUse>;
  /** 「次から自動」に印を付けた購入先 */
  autoNext: string[];
  registered: Registration | null;
  /** 登録で足した自動のルール（前の月までのルールに重ねる） */
  addedRules: AddedRule[];
  /** freee から読んだ明細の印 */
  live: LiveChoices;
};

export const EMPTY_LIVE: LiveChoices = { choices: {}, autoNext: [] };
export const EMPTY_ACCOUNTING: AccountingState = { v: 1, choices: {}, autoNext: [], registered: null, addedRules: [], live: EMPTY_LIVE };

const isStr = (x: unknown): x is string => typeof x === "string";
const isUse = (x: unknown): x is CardUse => x === "shop" || x === "private";
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;

/** ブラウザに残っていた文字を読む。形のおかしい物は落とす */
export function parseAccounting(raw: string | null): AccountingState {
  if (!raw) return EMPTY_ACCOUNTING;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(raw);
  } catch {
    return EMPTY_ACCOUNTING;
  }
  if (!d || typeof d !== "object") return EMPTY_ACCOUNTING;
  const choices: Record<string, CardUse> = {};
  if (d.choices && typeof d.choices === "object") {
    for (const [k, v] of Object.entries(d.choices as Record<string, unknown>)) if (/^\d+$/.test(k) && isUse(v)) choices[k] = v;
  }
  const lv = d.live as Record<string, unknown> | null | undefined;
  const live: LiveChoices = { choices: {}, autoNext: [] };
  if (lv && typeof lv === "object") {
    if (lv.choices && typeof lv.choices === "object")
      for (const [k, v] of Object.entries(lv.choices as Record<string, unknown>)) if (isTxnKey(k) && isUse(v)) live.choices[k] = v;
    if (Array.isArray(lv.autoNext)) live.autoNext = [...new Set((lv.autoNext as unknown[]).filter(isStr))];
  }
  const autoNext = Array.isArray(d.autoNext) ? [...new Set((d.autoNext as unknown[]).filter(isStr))] : [];
  const rule = (r: Record<string, unknown>): MerchantRule | null => (r && isStr(r.merchantId) && isUse(r.use) ? { merchantId: r.merchantId, use: r.use } : null);
  const addedRules: AddedRule[] = (Array.isArray(d.addedRules) ? (d.addedRules as Record<string, unknown>[]) : [])
    .map((r) => {
      const x = rule(r);
      return x && isStr(r.addedAt) ? { ...x, addedAt: r.addedAt } : null;
    })
    .filter((x): x is AddedRule => x !== null);
  let registered: Registration | null = null;
  const g = d.registered as Record<string, unknown> | null | undefined;
  if (g && typeof g === "object" && isStr(g.at) && isInt(g.total) && isInt(g.auto) && isInt(g.manual)) {
    registered = {
      at: g.at,
      total: g.total,
      auto: g.auto,
      manual: g.manual,
      shopAmount: isInt(g.shopAmount) ? g.shopAmount : 0,
      privateAmount: isInt(g.privateAmount) ? g.privateAmount : 0,
      added: (Array.isArray(g.added) ? (g.added as Record<string, unknown>[]) : []).map(rule).filter((x): x is MerchantRule => x !== null),
    };
  }
  return { v: 1, choices, autoNext, registered, addedRules, live };
}

/** いま効く自動のルール：前の月までのルール ＋ 登録で足したルール（同じ購入先は前の月までの方） */
export function effectiveRules(seedRules: MerchantRule[], s: AccountingState): MerchantRule[] {
  const have = new Set(seedRules.map((r) => r.merchantId));
  return [...seedRules, ...s.addedRules.filter((r) => !have.has(r.merchantId)).map(({ merchantId, use }) => ({ merchantId, use }))];
}

/** 今回の架空の明細（出金だけ。入金は見せるだけ）の仕分け。明細は前の月までのルールで取り込んだ物なので、前の月までのルールで分ける */
export function sortCurrent(seed: AccountingSeed): SortedStatement<SeedRow> {
  return sortStatement(
    expenseRows(seedRows(seed)),
    seed.rules,
    seed.history.map((h) => h.merchantId),
  );
}

/** いまの印を門で確かめる */
export function gateOf(seed: AccountingSeed, s: AccountingState): CardGate {
  return checkChoices(manualItems(sortCurrent(seed)), s.choices, s.autoNext, seed.merchants);
}

/** 店用・私用を選ぶ（登録の後は変えない）。人が選ぶ行だけ */
export function withChoice(seed: AccountingSeed, s: AccountingState, no: number, use: CardUse): AccountingState {
  if (s.registered) return s;
  if (!manualItems(sortCurrent(seed)).some((i) => i.no === no)) return s;
  return { ...s, choices: { ...s.choices, [String(no)]: use } };
}

/** 「次から自動」の印（購入先ごと）。人が選ぶ行の購入先だけ */
export function withAutoNext(seed: AccountingSeed, s: AccountingState, merchantId: string, on: boolean): AccountingState {
  if (s.registered) return s;
  if (!manualMerchants(sortCurrent(seed)).includes(merchantId)) return s;
  const rest = s.autoNext.filter((m) => m !== merchantId);
  return { ...s, autoNext: on ? [...rest, merchantId] : rest };
}

export type RegisterResult =
  | { ok: true; state: AccountingState; journal: { who: JournalWho; text: string }[]; message: string }
  | { ok: false; gate: CardGate };

/**
 * 🔒 会計に登録する。人が画面の「会計に登録」を押したときだけ呼ぶ（押した事は画面の部品が確かめる）。
 * 門を通らない（選び終わっていない・「次から自動」なのに印が分かれた）ときは登録しない。
 * 「次から自動」に印のある購入先は、今回の印で自動のルールに足す。
 */
export function register(seed: AccountingSeed, s: AccountingState, ctx: { nowIso: string; service: string }): RegisterResult {
  const gate = gateOf(seed, s);
  if (s.registered || !gate.ok) return { ok: false, gate };
  const sorted = sortCurrent(seed);
  const manual = manualItems(sorted);
  const rows = expenseRows(seedRows(seed));
  const useOf = (i: SeedRow): CardUse => sorted.auto.find((a) => a.item.key === i.key)?.use ?? s.choices[i.key];
  const amountOf = (u: CardUse) => rows.filter((i) => useOf(i) === u).reduce((a, i) => a + i.amount, 0);
  const added = rulesToAdd(seed, s);
  const registration: Registration = {
    at: ctx.nowIso,
    total: rows.length,
    auto: sorted.auto.length,
    manual: manual.length,
    shopAmount: amountOf("shop"),
    privateAmount: amountOf("private"),
    added,
  };
  const labels = added.map((r) => ruleLabel(seed.merchants, r));
  const journal: { who: JournalWho; text: string }[] = [
    {
      who: "オーナー",
      text: `人が登録：${ctx.service}にカードと銀行の明細（出金）${registration.total}件（自動 ${registration.auto}件・人が選んだ ${registration.manual}件）`,
    },
  ];
  if (labels.length) journal.push({ who: "オーナー", text: `自動のルールに足した：${labels.join("・")}（次の明細から自動で仕分ける）` });
  return {
    ok: true,
    state: { ...s, registered: registration, addedRules: [...s.addedRules, ...added.map((r) => ({ ...r, addedAt: ctx.nowIso }))] },
    journal,
    message: registrationMessage(seed, registration),
  };
}

/** 「次から自動」に印のある購入先を、今回の印で自動のルールにする（もうある購入先は足さない） */
export function rulesToAdd(seed: AccountingSeed, s: AccountingState): MerchantRule[] {
  const sorted = sortCurrent(seed);
  const manual = manualItems(sorted);
  const have = new Set(effectiveRules(seed.rules, s).map((r) => r.merchantId));
  return manualMerchants(sorted)
    .filter((m) => s.autoNext.includes(m) && !have.has(m))
    .map((m) => ({ merchantId: m, use: s.choices[manual.find((i) => i.merchantId === m)!.key] }))
    .filter((r) => !!r.use);
}

// ---- freee（テスト事業所）から読んだ明細（鍵は "t<wallet_txn の id>"） ----

/**
 * freee から読んだ明細（出金だけ）の仕分け。freee の明細は毎回新しく読む物なので、いま効く自動のルール（登録で足した分も）で分ける。
 * 購入先は摘要の文字で決めた物（rows.ts の merchantOfText）。決まらない行は人が選ぶ。
 */
export function sortLive(seed: AccountingSeed, s: AccountingState, rows: StatementRow[]): SortedStatement<StatementRow> {
  return sortStatement(
    expenseRows(rows),
    effectiveRules(seed.rules, s),
    seed.history.map((h) => h.merchantId),
  );
}

/**
 * freee から読んだ明細の門。manual：まだ送る人が選ぶ行。fixed：送り始めた時に固定した選び（固定した分は選んだと数える）。
 */
export function gateLive(seed: AccountingSeed, s: AccountingState, manual: StatementRow[], fixed: Record<string, CardUse> = {}): CardGate {
  return checkChoices(manual, { ...s.live.choices, ...fixed }, s.live.autoNext, seed.merchants);
}

/** freee から読んだ明細の店用・私用を選ぶ（鍵が freee の明細の番号の物だけ） */
export function withLiveChoice(s: AccountingState, key: string, use: CardUse): AccountingState {
  if (!isTxnKey(key)) return s;
  return { ...s, live: { ...s.live, choices: { ...s.live.choices, [key]: use } } };
}

/** freee から読んだ明細の「次から自動」（購入先ごと） */
export function withLiveAutoNext(s: AccountingState, merchantId: string, on: boolean): AccountingState {
  const rest = s.live.autoNext.filter((m) => m !== merchantId);
  return { ...s, live: { ...s.live, autoNext: on ? [...rest, merchantId] : rest } };
}

/** freee から読んだ明細ごとの店用／私用（自動のルールの分と、人が選んだ分）。選んでいない行は入れない */
export function liveUsesOf(sorted: SortedStatement<StatementRow>, s: AccountingState): Record<string, CardUse> {
  const out: Record<string, CardUse> = {};
  for (const a of sorted.auto) out[a.item.key] = a.use;
  for (const i of manualItems(sorted)) if (s.live.choices[i.key]) out[i.key] = s.live.choices[i.key];
  return out;
}

/**
 * freee の登録で、送った行が全部済んだ（登録した・もう処理済み）時：「次から自動」の購入先を自動のルールに足す。
 * done：済んだ人が選ぶ行と、その時の店用／私用。購入先の行の印がそろっている時だけ足す（もうルールがある購入先は足さない）。
 * 画面の中の会計の記録（registered）は変えない（freee の記録とは分けて持つ）。
 */
export function withRulesFromLive(
  seed: AccountingSeed,
  s: AccountingState,
  done: { merchantId: string | null; use: CardUse }[],
  nowIso: string,
): { state: AccountingState; added: MerchantRule[] } {
  const have = new Set(effectiveRules(seed.rules, s).map((r) => r.merchantId));
  const added: MerchantRule[] = [];
  for (const m of s.live.autoNext) {
    if (have.has(m)) continue;
    const uses = new Set(done.filter((d) => d.merchantId === m).map((d) => d.use));
    if (uses.size === 1) added.push({ merchantId: m, use: [...uses][0] });
  }
  if (!added.length) return { state: s, added };
  return {
    state: {
      ...s,
      addedRules: [...s.addedRules, ...added.map((r) => ({ ...r, addedAt: nowIso }))],
      live: { ...s.live, autoNext: s.live.autoNext.filter((m) => !added.some((a) => a.merchantId === m)) },
    },
    added,
  };
}

/** 「自動 15件・人が選んだ 8件。自動のルールに「タオルの通販F＝店用」を足しました」 */
export function registrationMessage(seed: AccountingSeed, r: Registration): string {
  const head = `自動 ${r.auto}件・人が選んだ ${r.manual}件。`;
  return r.added.length
    ? `${head}自動のルールに${r.added.map((x) => `「${ruleLabel(seed.merchants, x)}」`).join("")}を足しました`
    : `${head}自動のルールは足していません`;
}

/**
 * 登録の後の「次の明細（試し）」：いま効く自動のルール（足した分も）で分ける。登録はしない。
 * 今回の明細の購入先は、登録の後は「前にも仕分けた購入先」に数える。
 */
export function sortTrial(seed: AccountingSeed, s: AccountingState): SortedStatement<CardItem & Sortable> & { byAdded: number[] } {
  const known = [...seed.history.map((h) => h.merchantId), ...(s.registered ? seed.statement.items.map((i) => i.merchantId) : [])];
  const sorted = sortStatement(seed.trial.items, effectiveRules(seed.rules, s), known);
  const added = new Set(s.addedRules.map((r) => r.merchantId));
  return { ...sorted, byAdded: sorted.auto.filter((a) => added.has(a.item.merchantId)).map((a) => a.item.no) };
}
