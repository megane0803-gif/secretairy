// 売上（架空の1か月）。見るだけで、どこにも送らない。
// 数はどれもプログラムが seed/accounting.json の日ごとの数から出す（AI は使わない）。

import { calDay } from "../calendar";
import type { SalesMonth } from "../data/types";
import type { ShopSettings } from "../settings";

/** 日ごとの小さい棒の1本。定休日（お休みの日）は点にする */
export type SalesDayCell = {
  date: string;
  /** 10/1（木） */
  label: string;
  /** 1〜31 */
  day: number;
  open: boolean;
  /** 円（支払い方法の合計） */
  sales: number;
  visits: number;
};

export type SalesMethodShare = { id: string; name: string; amount: number; pct: number };

export type SalesSummary = {
  /** 10 */
  month: number;
  /** 売上（円） */
  total: number;
  /** 来店（人） */
  visits: number;
  /** 客単価（円。売上 ÷ 来店 を四捨五入） */
  perVisit: number;
  /** その月の1日から末日まで */
  days: SalesDayCell[];
  /** 支払い方法の割合 */
  methods: SalesMethodShare[];
  /** いちばん売上の多かった日の売上（棒の高さの 100%） */
  maxDay: number;
};

const sumPay = (pay: Record<string, number>) => Object.values(pay).reduce((a, b) => a + b, 0);

export function summarizeSales(sales: SalesMonth, shop: ShopSettings): SalesSummary {
  const [y, m] = sales.month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const byDate = new Map(sales.days.map((d) => [d.date, d]));
  const days: SalesDayCell[] = [];
  for (let d = 1; d <= last; d++) {
    const date = `${sales.month}-${String(d).padStart(2, "0")}`;
    const cal = calDay(shop, date);
    const row = byDate.get(date);
    days.push({ date, label: cal.label, day: d, open: cal.open, sales: row ? sumPay(row.pay) : 0, visits: row?.visits ?? 0 });
  }
  const total = days.reduce((a, d) => a + d.sales, 0);
  const visits = days.reduce((a, d) => a + d.visits, 0);
  const methods = sales.methods.map((mt) => {
    const amount = sales.days.reduce((a, d) => a + (d.pay[mt.id] ?? 0), 0);
    return { id: mt.id, name: mt.name, amount, pct: total > 0 ? Math.round((amount / total) * 100) : 0 };
  });
  return {
    month: m,
    total,
    visits,
    perVisit: visits > 0 ? Math.round(total / visits) : 0,
    days,
    methods,
    maxDay: Math.max(0, ...days.map((d) => d.sales)),
  };
}

export const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;

/** 2026-10-13 → 10/13 */
export const md = (date: string) => {
  const [, m, d] = date.split("-").map(Number);
  return `${m}/${d}`;
};
