// カード・銀行の明細（出金）の仕分け。AI の予想は使わない。
// 購入先ごとの「自動のルール」がある行はプログラムが店用・私用を付け、ルールの無い行だけ人が選ぶ。
// 人が選ぶ行は「初めての購入先」と「前にも仕分けた購入先」（前の月までに仕分けたが、ルールの無い所）に分けて出す。
// 購入先が決まらない行（freee の明細で、摘要に購入先の名前が0件・2件以上）は、ルールを使わず「初めての購入先」の側で人が選ぶ。

import type { CardUse, Merchant, MerchantRule } from "../data/types";

export const USE_LABEL: Record<CardUse, string> = { shop: "店用", private: "私用" };

/** 仕分けに要る所だけ（架空の明細・一覧の行・試しの明細のどれでも） */
export type Sortable = { merchantId: string | null };
/** 人が選ぶ印を付ける行（鍵で印を持つ） */
export type Choosable = Sortable & { key: string };

export type AutoRow<T extends Sortable = Choosable> = { item: T; use: CardUse };

export type SortedStatement<T extends Sortable = Choosable> = {
  /** 自動のルールで仕分けた行 */
  auto: AutoRow<T>[];
  /** 初めての購入先・購入先が決まらない行（人が選ぶ） */
  fresh: T[];
  /** 前にも仕分けた購入先（ルールが無いので人が選ぶ） */
  known: T[];
};

/** 明細を、自動のルール・前にも仕分けた購入先で分ける */
export function sortStatement<T extends Sortable>(items: T[], rules: MerchantRule[], knownMerchantIds: Iterable<string>): SortedStatement<T> {
  const rule = new Map(rules.map((r) => [r.merchantId, r.use]));
  const known = new Set(knownMerchantIds);
  const out: SortedStatement<T> = { auto: [], fresh: [], known: [] };
  for (const item of items) {
    const use = item.merchantId === null ? undefined : rule.get(item.merchantId);
    if (use) out.auto.push({ item, use });
    else if (item.merchantId !== null && known.has(item.merchantId)) out.known.push(item);
    else out.fresh.push(item);
  }
  return out;
}

/** 人が選ぶ行（初めての購入先 → 前にも仕分けた購入先 の順） */
export function manualItems<T extends Sortable>(s: SortedStatement<T>): T[] {
  return [...s.fresh, ...s.known];
}

/** 人が選ぶ行の購入先（重ならないように・出てきた順。購入先が決まらない行は入れない） */
export function manualMerchants<T extends Sortable>(s: SortedStatement<T>): string[] {
  return [...new Set(manualItems(s).map((i) => i.merchantId).filter((m): m is string => m !== null))];
}

export function merchantName(merchants: Merchant[], id: string): string {
  return merchants.find((m) => m.id === id)?.name ?? id;
}

/** 「タオルの通販F＝店用」 */
export function ruleLabel(merchants: Merchant[], r: MerchantRule): string {
  return `${merchantName(merchants, r.merchantId)}＝${USE_LABEL[r.use]}`;
}

// ---- プログラムの門（✓ の印2つ） ----

export type CardCheckId = "allChosen" | "autoAligned";

export const CARD_GATE_LABELS: Record<CardCheckId, string> = {
  allChosen: "全部に店用か私用が付いた",
  autoAligned: "「次から自動」の購入先は今回の印がそろっている",
};

export type CardCheck = { id: CardCheckId; label: string; ok: boolean };

export type CardGate = {
  checks: CardCheck[];
  /** 止めた理由の文（「次から自動」なのに店用と私用に分かれた購入先） */
  problems: { merchantId: string; text: string }[];
  /** あと何件選ぶか */
  remaining: number;
  /** 登録してよいか */
  ok: boolean;
};

/**
 * 人が選んだ印を確かめる。
 * 1. 人が選ぶ行の全部に店用か私用が付いた
 * 2. 「次から自動」に印のある購入先は、今回の行の印がぜんぶ同じ（店用と私用に分かれていたら止めて理由を出す）
 */
export function checkChoices(
  manual: Choosable[],
  choices: Record<string, CardUse>,
  autoNext: string[],
  merchants: Merchant[],
): CardGate {
  const remaining = manual.filter((i) => !choices[i.key]).length;
  const problems: CardGate["problems"] = [];
  let aligned = true;
  for (const mid of autoNext) {
    const rows = manual.filter((i) => i.merchantId === mid);
    if (rows.length === 0) continue;
    const uses = new Set(rows.map((i) => choices[i.key]).filter(Boolean));
    if (uses.size > 1) {
      aligned = false;
      problems.push({
        merchantId: mid,
        text: `${merchantName(merchants, mid)}は今回、店用と私用に分かれています。「次から自動」にすると次から全部が同じ方になるので止めました。印を外すか、店用・私用をそろえてください。`,
      });
    } else if (rows.some((i) => !choices[i.key])) {
      aligned = false;
    }
  }
  const checks: CardCheck[] = [
    { id: "allChosen", label: CARD_GATE_LABELS.allChosen, ok: remaining === 0 },
    { id: "autoAligned", label: CARD_GATE_LABELS.autoAligned, ok: aligned },
  ];
  return { checks, problems, remaining, ok: checks.every((c) => c.ok) };
}
