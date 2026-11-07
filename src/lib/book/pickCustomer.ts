// 「予約を入れる」の1枚（OwnerBookSheet.tsx）の ①お客様を選ぶ段：名字とよみで探し、並べ方を2つから選ぶ。プログラムだけ（AI は使わない）。
// よみの直し方（カタカナ → ひらがな）・50音の行・前回の来店は、カルテのお客様一覧と同じ物（karte/customers.ts）を使う。
//   ・並べ方は「前回来た日が新しい順」（記録の無い方は後ろ）と「50音順」（よみの順。行の見出しで区切る）
//   ・一覧は全員を出す（「もっと表示」は無い）。何人いるかは「95人」「「佐藤」に合う 9人（全員で 95人）」
//   ・各お客様に、前回からの間「2か月前」「1年3か月前」（台帳の今日から数える。記録が無ければ「初めての方」）
//   ・同じ名字で前回からの間も同じ（「初めての方」同士も）方が並ぶ時は、お客様の番号を小さく出して見分ける

import { dayDiff } from "../calendar";
import type { Customer } from "../data/types";
import { KANA_ROWS, kanaRowOf, lastVisitOf, toHiragana, type KanaRowId, type LastVisit } from "../karte/customers";
import type { KarteRecord } from "../karte/record";

/** 並べ方：recent = 前回来た日が新しい順 / kana = 50音順 */
export type CustomerOrder = "recent" | "kana";

export const ORDER_LABEL: Record<CustomerOrder, string> = { recent: "前回来た日が新しい順", kana: "50音順" };

/** 記録が無い方の言い方 */
export const FIRST_TIME = "初めての方";

export type CustomerChoice = {
  customer: Customer;
  last: LastVisit | null;
  /** 前回からの間（「2か月前」。記録が無ければ「初めての方」） */
  since: string;
  /** 同じ名字・同じ前回からの間の方がほかにも出ている（番号を出して見分ける） */
  showId: boolean;
};

export type CustomerPick = {
  /** 出す行（探す言葉に合う全員） */
  shown: CustomerChoice[];
  /** 全員の人数 */
  total: number;
};

/** 名字の部分一致か、よみ（カタカナで書いてもひらがなのよみで）の部分一致 */
export function matchCustomer(c: Pick<Customer, "surname" | "kana">, query: string): boolean {
  const q = toHiragana(query).replace(/\s+/g, "");
  if (!q) return true;
  return c.surname.includes(q) || c.surname.includes(query.trim()) || toHiragana(c.kana ?? "").includes(q);
}

/**
 * 前回からの間。today は台帳の今日（「翌日へ」で進んだ日）。
 * 30日未満は「○日前」（同じ日は「今日」）。それより前は月の差（日がまだ来ていなければ1引く。30日以上なので少なくとも1か月）で「○か月前」、
 * 12か月以上は「○年○か月前」（0か月は書かない：「1年前」）。記録が無ければ「初めての方」。
 */
export function sinceLabel(lastDate: string | null | undefined, today: string): string {
  if (!lastDate) return FIRST_TIME;
  const days = dayDiff(lastDate, today);
  if (days <= 0) return "今日";
  if (days < 30) return `${days}日前`;
  const [ly, lm, ld] = lastDate.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  const months = Math.max(1, (ty - ly) * 12 + (tm - lm) - (td < ld ? 1 : 0));
  if (months < 12) return `${months}か月前`;
  const y = Math.floor(months / 12);
  const m = months % 12;
  return m ? `${y}年${m}か月前` : `${y}年前`;
}

const kanaKey = (c: Pick<Customer, "kana" | "surname">) => toHiragana(c.kana ?? c.surname);

export function pickCustomers(
  customers: Customer[],
  kartes: KarteRecord[],
  query: string,
  opts: { order?: CustomerOrder; today: string },
): CustomerPick {
  const order = opts.order ?? "recent";
  const rows = customers
    .filter((c) => matchCustomer(c, query))
    .map((c) => {
      const last = lastVisitOf(kartes, c.id);
      return { customer: c, last, since: sinceLabel(last?.date, opts.today) };
    })
    .sort((a, b) => {
      if (order === "recent") {
        // 前回来た日が新しい順。記録の無い方は後ろ（その中はよみの順）
        if (a.last && b.last && a.last.date !== b.last.date) return a.last.date < b.last.date ? 1 : -1;
        if (!!a.last !== !!b.last) return a.last ? -1 : 1;
      } else {
        // 50音順：よみの無い方（行に入らない方）は後ろ
        const ra = kanaRowOf(a.customer.kana);
        const rb = kanaRowOf(b.customer.kana);
        if (!!ra !== !!rb) return ra ? -1 : 1;
      }
      return kanaKey(a.customer).localeCompare(kanaKey(b.customer), "ja") || a.customer.id.localeCompare(b.customer.id);
    });
  const sig = (r: { customer: Customer; since: string }) => `${r.customer.surname}|${r.since}`;
  const count = new Map<string, number>();
  for (const r of rows) count.set(sig(r), (count.get(sig(r)) ?? 0) + 1);
  const shown = rows.map((r) => ({ ...r, showId: (count.get(sig(r)) ?? 0) > 1 }));
  return { shown, total: customers.length };
}

/** 「95人」（探している時は「「佐藤」に合う 9人（全員で 95人）」） */
export function pickCountLabel(p: CustomerPick, query: string): string {
  const q = query.trim();
  return q ? `「${q}」に合う ${p.shown.length}人（全員で ${p.total}人）` : `${p.total}人`;
}

/** 50音の行（あ・か・さ…・わ）と、よみが無い・読めない方の「ほか」 */
export type KanaGroupId = KanaRowId | "other";
export type KanaGroup = { id: KanaGroupId; label: string; items: CustomerChoice[] };

/** 50音順の一覧を行の見出しで区切る。よみの1文字目（カタカナ・ひらがな、濁点つきも）で行を決める。人のいない行は出さない */
export function kanaGroups(list: CustomerChoice[]): KanaGroup[] {
  const groups: KanaGroup[] = [...KANA_ROWS.map((r) => ({ id: r.id as KanaGroupId, label: r.label as string, items: [] as CustomerChoice[] })), { id: "other", label: "ほか", items: [] }];
  for (const c of list) {
    const row = kanaRowOf(c.customer.kana) ?? "other";
    groups.find((g) => g.id === row)!.items.push(c);
  }
  return groups.filter((g) => g.items.length > 0);
}

/** 右の端の索引（あ〜わの10行）。人のいない行は押せない */
export function kanaIndex(groups: KanaGroup[]): { id: KanaRowId; label: string; has: boolean }[] {
  return KANA_ROWS.map((r) => ({ id: r.id, label: r.label, has: groups.some((g) => g.id === r.id) }));
}
