// 「予約を入れる」の1枚（OwnerBookSheet.tsx）のお客様を選ぶ所：名字とよみで探し、前回来た日が新しい順に並べる。プログラムだけ（AI は使わない）。
// よみの直し方（カタカナ → ひらがな）と前回の来店は、カルテのお客様一覧と同じ物（karte/customers.ts）を使う。
//   ・「95人中 8人を表示」と出す（何人いるかが分かるように）。残りは「もっと表示」で足す
//   ・各お客様に「前回 10/24（金） カット」（記録が無ければ何も足さない。「初めての方」は firstVisit で決める）
//   ・同じ名字で前回も同じ（記録が無いのも同じ）方が並ぶ時は、お客様の番号を小さく出して見分ける

import type { Customer } from "../data/types";
import { lastVisitOf, toHiragana, type LastVisit } from "../karte/customers";
import type { KarteRecord } from "../karte/record";

/** 1回に足して出す数 */
export const CUSTOMER_PAGE = 8;

export type CustomerChoice = {
  customer: Customer;
  last: LastVisit | null;
  /** 同じ名字・同じ前回の方がほかにも出ている（番号を出して見分ける） */
  showId: boolean;
};

export type CustomerPick = {
  /** 出す行 */
  shown: CustomerChoice[];
  /** 探す言葉に合う人数（言葉が無ければ全員） */
  matched: number;
  /** 全員の人数 */
  total: number;
  /** まだ出していない方がいる（「もっと表示」） */
  more: boolean;
};

/** 名字の部分一致か、よみ（カタカナで書いてもひらがなのよみで）の部分一致 */
export function matchCustomer(c: Pick<Customer, "surname" | "kana">, query: string): boolean {
  const q = toHiragana(query).replace(/\s+/g, "");
  if (!q) return true;
  return c.surname.includes(q) || c.surname.includes(query.trim()) || toHiragana(c.kana ?? "").includes(q);
}

export function pickCustomers(customers: Customer[], kartes: KarteRecord[], query: string, limit: number = CUSTOMER_PAGE): CustomerPick {
  const rows = customers
    .filter((c) => matchCustomer(c, query))
    .map((c) => ({ customer: c, last: lastVisitOf(kartes, c.id) }))
    // 前回来た日が新しい順。記録の無い方は後ろ（その中はよみの順）
    .sort((a, b) => {
      if (a.last && b.last && a.last.date !== b.last.date) return a.last.date < b.last.date ? 1 : -1;
      if (!!a.last !== !!b.last) return a.last ? -1 : 1;
      return (a.customer.kana ?? a.customer.surname).localeCompare(b.customer.kana ?? b.customer.surname, "ja");
    });
  const n = Math.max(1, Math.floor(limit));
  const page = rows.slice(0, n);
  const sig = (r: { customer: Customer; last: LastVisit | null }) => `${r.customer.surname}|${r.last ? `${r.last.date}|${r.last.menuId}` : ""}`;
  const shown = page.map((r) => ({ ...r, showId: page.some((x) => x !== r && sig(x) === sig(r)) }));
  return { shown, matched: rows.length, total: customers.length, more: rows.length > page.length };
}

/** 「95人中 8人を表示」（探している時は「「佐藤」に合う 4人中 4人を表示」） */
export function pickCountLabel(p: Pick<CustomerPick, "shown" | "matched" | "total">, query: string): string {
  const q = query.trim();
  return q ? `「${q}」に合う ${p.matched}人中 ${p.shown.length}人を表示（全員で ${p.total}人）` : `${p.total}人中 ${p.shown.length}人を表示`;
}

/** 「前回 10/24（金） カット」。記録が無ければ null（何も足さない） */
export function lastLabel(last: LastVisit | null, dayLabel: (date: string) => string, menuName: (id: string) => string): string | null {
  return last ? `前回 ${dayLabel(last.date)} ${menuName(last.menuId)}` : null;
}
