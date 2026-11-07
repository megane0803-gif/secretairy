// 経理の明細の一覧の1行（アプリの中の架空の明細と、freee（テスト事業所）から読んだ明細を同じ形で出す）。
// 画面にもサーバーにも依らない（プログラム。AI は使わない）。
//
// 鍵（選んだ店用・私用と、freee の登録の状態を持つ所）は混ぜない：
// - 架空の明細：明細の番号（item.no）をそのまま "1"…
// - freee から読んだ明細：freee の明細の番号（wallet_txn の id）で "t<id>"
//
// freee の明細には摘要の文字しか無いので、摘要に購入先の名前（merchants の name）が「ちょうど1つ」含まれる時だけ、
// その購入先と見る（自動のルールは購入先の番号 merchantId のまま）。0件・2件以上なら購入先は無し（人が選ぶ側）。

import type { AccountingSeed, CardItem, Merchant, StatementAccount, StatementSide } from "../data/types";

export type StatementRow = {
  /** 選び・状態の鍵。架空の明細は "1"…、freee から読んだ明細は "t<wallet_txn の id>" */
  key: string;
  /** 架空の明細の番号（freee から読んだ明細は null） */
  no: number | null;
  /** freee の明細の番号（架空の明細は null） */
  txnId: number | null;
  account: StatementAccount;
  side: StatementSide;
  /** YYYY-MM-DD */
  date: string;
  /** 摘要（購入先や振込元）。画面に出す文（印は外す） */
  text: string;
  /** 摘要から決まった購入先（無い・2つ以上なら null） */
  merchantId: string | null;
  /** 円 */
  amount: number;
};

/** アプリの中の架空の明細の行（番号と購入先がいつもある） */
export type SeedRow = StatementRow & { no: number; txnId: null; merchantId: string };

/** サーバーが freee から読んで返す、まだ処理していない明細の1件（画面で StatementRow にする） */
export type ListedTxn = { id: number; account: StatementAccount; date: string; side: StatementSide; description: string; amount: number };

export const ACCOUNT_LABEL: Record<StatementAccount, string> = { card: "カード", bank: "銀行" };
export const SIDE_LABEL: Record<StatementSide, string> = { expense: "出金", income: "入金" };

export const accountOf = (i: Pick<CardItem, "account">): StatementAccount => i.account ?? "card";
export const sideOf = (i: Pick<CardItem, "side">): StatementSide => i.side ?? "expense";

/** freee の明細の鍵 */
export const txnKey = (id: number): string => `t${id}`;
/** freee の明細の鍵か（架空の明細の番号とは混ぜない） */
export const isTxnKey = (k: string): boolean => /^t[1-9]\d{0,18}$/.test(k);
/** 架空の明細の鍵か */
export const isSeedKey = (k: string): boolean => /^[1-9]\d{0,5}$/.test(k);
export const txnIdOf = (k: string): number | null => (isTxnKey(k) ? Number(k.slice(1)) : null);

/** 摘要に購入先の名前がちょうど1つ含まれる時だけ、その購入先。0件・2件以上なら null */
export function merchantOfText(text: string, merchants: Merchant[]): string | null {
  const hit = merchants.filter((m) => m.name && text.includes(m.name));
  return hit.length === 1 ? hit[0].id : null;
}

/** 摘要から、このアプリの印（「SecretAIry:…」）を外して画面に出す文にする */
export function withoutMarks(text: string, markPrefix: string): string {
  const out = text
    .split(/\s+/)
    .filter((w) => w && !w.startsWith(`${markPrefix}:`))
    .join(" ");
  return out || "（摘要なし）";
}

/** アプリの中の架空の明細（seed）を一覧の行にする */
export function seedRows(seed: AccountingSeed): SeedRow[] {
  return seed.statement.items.map((i) => ({
    key: String(i.no),
    no: i.no,
    txnId: null,
    account: accountOf(i),
    side: sideOf(i),
    date: i.date,
    text: seed.merchants.find((m) => m.id === i.merchantId)?.name ?? i.merchantId,
    merchantId: i.merchantId,
    amount: i.amount,
  }));
}

/** freee から読んだ明細を一覧の行にする（購入先は摘要の文字で決める） */
export function freeeRows(list: ListedTxn[], merchants: Merchant[], markPrefix: string): StatementRow[] {
  return list.map((t) => ({
    key: txnKey(t.id),
    no: null,
    txnId: t.id,
    account: t.account,
    side: t.side,
    date: t.date,
    text: withoutMarks(t.description, markPrefix),
    merchantId: merchantOfText(t.description, merchants),
    amount: t.amount,
  }));
}

export const expenseRows = <T extends { side: StatementSide }>(rows: T[]): T[] => rows.filter((r) => r.side === "expense");
export const incomeRows = <T extends { side: StatementSide }>(rows: T[]): T[] => rows.filter((r) => r.side === "income");

/** YYYY-MM-DD に日数を足す（引く） */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 読む期間：今日の listDays 日前から、「架空の明細の最後の日」と「今日」の遅い方まで */
export function listRange(today: string, statementTo: string, listDays: number): { from: string; to: string } {
  return { from: addDays(today, -listDays), to: statementTo > today ? statementTo : today };
}
