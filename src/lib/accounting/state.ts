// 経理（通販の明細の仕分け）を、見ている人のブラウザの中だけに残す形（docs/SPEC.md §5.1）。
// ここは形と変え方だけ（どこにも書かない）。書くのは useAccounting.ts と画面の部品。
//
// 承認の箱は使わない（ホームの「承認待ち」にも入れない）。AI の予想も使わない。
// 🔒 確定は人：会計（架空）への登録（register）を呼ぶのは、人が画面の「会計（架空）に登録」を押したときだけ。
// AI・サーバー・自動の処理からは呼ばない。

import type { AccountingSeed, CardItem, CardUse, MerchantRule } from "../data/types";
import type { JournalWho } from "../journal";
import { checkChoices, manualItems, manualMerchants, ruleLabel, sortStatement, type CardGate, type SortedStatement } from "./sort";

/** 登録で足した自動のルール */
export type AddedRule = MerchantRule & { addedAt: string };

/** 会計（架空）に登録した記録 */
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

export type AccountingState = {
  v: 1;
  /** 人が選んだ印（明細の番号 → 店用 / 私用） */
  choices: Record<string, CardUse>;
  /** 「次から自動」に印を付けた購入先 */
  autoNext: string[];
  registered: Registration | null;
  /** 登録で足した自動のルール（前の月までのルールに重ねる） */
  addedRules: AddedRule[];
};

export const EMPTY_ACCOUNTING: AccountingState = { v: 1, choices: {}, autoNext: [], registered: null, addedRules: [] };

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
  return { v: 1, choices, autoNext, registered, addedRules };
}

/** いま効く自動のルール：前の月までのルール ＋ 登録で足したルール（同じ購入先は前の月までの方） */
export function effectiveRules(seedRules: MerchantRule[], s: AccountingState): MerchantRule[] {
  const have = new Set(seedRules.map((r) => r.merchantId));
  return [...seedRules, ...s.addedRules.filter((r) => !have.has(r.merchantId)).map(({ merchantId, use }) => ({ merchantId, use }))];
}

/** 今回の明細の仕分け。明細は前の月までのルールで取り込んだ物なので、前の月までのルールで分ける */
export function sortCurrent(seed: AccountingSeed): SortedStatement {
  return sortStatement(
    seed.statement.items,
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
 * 🔒 会計（架空）に登録する。人が画面の「会計（架空）に登録」を押したときだけ呼ぶ（押した事は画面の部品が確かめる）。
 * 門を通らない（選び終わっていない・「次から自動」なのに印が分かれた）ときは登録しない。
 * 「次から自動」に印のある購入先は、今回の印で自動のルールに足す。
 */
export function register(seed: AccountingSeed, s: AccountingState, ctx: { nowIso: string; service: string }): RegisterResult {
  const gate = gateOf(seed, s);
  if (s.registered || !gate.ok) return { ok: false, gate };
  const sorted = sortCurrent(seed);
  const manual = manualItems(sorted);
  const useOf = (i: CardItem): CardUse => sorted.auto.find((a) => a.item.no === i.no)?.use ?? s.choices[String(i.no)];
  const amountOf = (u: CardUse) => seed.statement.items.filter((i) => useOf(i) === u).reduce((a, i) => a + i.amount, 0);
  const added = rulesToAdd(seed, s);
  const registration: Registration = {
    at: ctx.nowIso,
    total: seed.statement.items.length,
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
      text: `人が登録：${ctx.service}に通販の明細 ${registration.total}件（自動 ${registration.auto}件・人が選んだ ${registration.manual}件）`,
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
    .map((m) => ({ merchantId: m, use: s.choices[String(manual.find((i) => i.merchantId === m)!.no)] }))
    .filter((r) => !!r.use);
}

/** 明細ごとの店用／私用（自動のルールの分と、人が選んだ分）。選んでいない行は入れない */
export function usesOf(seed: AccountingSeed, s: AccountingState): Record<string, CardUse> {
  const sorted = sortCurrent(seed);
  const out: Record<string, CardUse> = {};
  for (const a of sorted.auto) out[String(a.item.no)] = a.use;
  for (const i of manualItems(sorted)) if (s.choices[String(i.no)]) out[String(i.no)] = s.choices[String(i.no)];
  return out;
}

/**
 * freee（テスト事業所）の登録が全部済んだ（登録した・もう処理済み）時：「次から自動」の購入先を自動のルールに足す。
 * 会計（架空）の記録（registered）は変えない（freee の記録とは分けて持つ）。
 */
export function withRulesFromFreee(seed: AccountingSeed, s: AccountingState, nowIso: string): { state: AccountingState; added: MerchantRule[] } {
  const added = rulesToAdd(seed, s);
  if (!added.length) return { state: s, added };
  return { state: { ...s, addedRules: [...s.addedRules, ...added.map((r) => ({ ...r, addedAt: nowIso }))] }, added };
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
export function sortTrial(seed: AccountingSeed, s: AccountingState): SortedStatement & { byAdded: number[] } {
  const known = [...seed.history.map((h) => h.merchantId), ...(s.registered ? seed.statement.items.map((i) => i.merchantId) : [])];
  const sorted = sortStatement(seed.trial.items, effectiveRules(seed.rules, s), known);
  const added = new Set(s.addedRules.map((r) => r.merchantId));
  return { ...sorted, byAdded: sorted.auto.filter((a) => added.has(a.item.merchantId)).map((a) => a.item.no) };
}
