// 通販の明細の仕分け。AI の予想は使わない。
// 購入先ごとの「自動のルール」がある行はプログラムが店用・私用を付け、ルールの無い行だけ人が選ぶ。
// 人が選ぶ行は「初めての購入先」と「前にも仕分けた購入先」（前の月までに仕分けたが、ルールの無い所）に分けて出す。

import type { CardItem, CardUse, Merchant, MerchantRule } from "../data/types";

export const USE_LABEL: Record<CardUse, string> = { shop: "店用", private: "私用" };

export type AutoRow = { item: CardItem; use: CardUse };

export type SortedStatement = {
  /** 自動のルールで仕分けた行 */
  auto: AutoRow[];
  /** 初めての購入先（人が選ぶ） */
  fresh: CardItem[];
  /** 前にも仕分けた購入先（ルールが無いので人が選ぶ） */
  known: CardItem[];
};

/** 明細を、自動のルール・前にも仕分けた購入先で分ける */
export function sortStatement(items: CardItem[], rules: MerchantRule[], knownMerchantIds: Iterable<string>): SortedStatement {
  const rule = new Map(rules.map((r) => [r.merchantId, r.use]));
  const known = new Set(knownMerchantIds);
  const out: SortedStatement = { auto: [], fresh: [], known: [] };
  for (const item of items) {
    const use = rule.get(item.merchantId);
    if (use) out.auto.push({ item, use });
    else if (known.has(item.merchantId)) out.known.push(item);
    else out.fresh.push(item);
  }
  return out;
}

/** 人が選ぶ行（初めての購入先 → 前にも仕分けた購入先 の順） */
export function manualItems(s: SortedStatement): CardItem[] {
  return [...s.fresh, ...s.known];
}

/** 人が選ぶ行の購入先（重ならないように・出てきた順） */
export function manualMerchants(s: SortedStatement): string[] {
  return [...new Set(manualItems(s).map((i) => i.merchantId))];
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
  manual: CardItem[],
  choices: Record<string, CardUse>,
  autoNext: string[],
  merchants: Merchant[],
): CardGate {
  const remaining = manual.filter((i) => !choices[String(i.no)]).length;
  const problems: CardGate["problems"] = [];
  let aligned = true;
  for (const mid of autoNext) {
    const rows = manual.filter((i) => i.merchantId === mid);
    if (rows.length === 0) continue;
    const uses = new Set(rows.map((i) => choices[String(i.no)]).filter(Boolean));
    if (uses.size > 1) {
      aligned = false;
      problems.push({
        merchantId: mid,
        text: `${merchantName(merchants, mid)}は今回、店用と私用に分かれています。「次から自動」にすると次から全部が同じ方になるので止めました。印を外すか、店用・私用をそろえてください。`,
      });
    } else if (rows.some((i) => !choices[String(i.no)])) {
      aligned = false;
    }
  }
  const checks: CardCheck[] = [
    { id: "allChosen", label: CARD_GATE_LABELS.allChosen, ok: remaining === 0 },
    { id: "autoAligned", label: CARD_GATE_LABELS.autoAligned, ok: aligned },
  ];
  return { checks, problems, remaining, ok: checks.every((c) => c.ok) };
}
