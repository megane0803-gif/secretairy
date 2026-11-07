// freee（テスト事業所）の明細と、経理タブの明細を照らし合わせる（プログラム。AI は使わない）。
// - 架空の明細を入れる時：印（摘要の「SecretAIry:<データの版>:<明細の番号>」）で探し、口座・日付・金額・出金か入金かまで合う時だけ「もうある」
// - 登録の時：freee の明細の番号（wallet_txn の id）で探し、口座・日付・金額・出金・未処理まで全部合う時だけ進む（印の無い明細も）

import { accountOf, merchantOfText, sideOf } from "../accounting/rows";
import type { CardItem, CardUse, Merchant, StatementAccount } from "../data/types";
import type { Walletable, WalletableType, WalletTxn } from "./api";

/** 口座（カード／銀行）の freee の口座の種類 */
export const WALLETABLE_TYPE: Record<StatementAccount, WalletableType> = { card: "credit_card", bank: "bank_account" };

/** 摘要の印 */
export function markOf(prefix: string, version: string, no: number): string {
  return `${prefix}:${version}:${no}`;
}

/** 摘要に印が入っているか（空白で区切った1つが印とちょうど同じ。「…:1」と「…:10」はちがう） */
export function hasMark(description: string, mark: string): boolean {
  return description.split(/\s+/).some((w) => w === mark);
}

/** 入れる明細の摘要（購入先の名前（架空）と印） */
export function descriptionOf(merchantName: string, mark: string): string {
  return `${merchantName} ${mark}`;
}

export type CardAccount = { ok: true; walletable: Walletable & { type: "credit_card" } } | { ok: false; reason: string };

/** 「SecretAIry カード」という名前の口座がちょうど1つで、クレジットカードの時だけ使う。プログラムでは作らない */
export function pickCardAccount(list: Walletable[], name: string): CardAccount {
  const hit = list.filter((w) => w.name === name);
  if (hit.length === 0) return { ok: false, reason: `「${name}」という名前の口座がありません。freee の側でクレジットカードの口座を1つ、この名前で作ってください（ここでは作りません）` };
  if (hit.length > 1) return { ok: false, reason: `「${name}」という名前の口座が${hit.length}つあります。どれに入れるか決められないので止めました。1つだけにしてください` };
  const w = hit[0];
  if (w.type !== "credit_card") return { ok: false, reason: `「${name}」はクレジットカードの口座ではありません。止めました` };
  return { ok: true, walletable: { ...w, type: "credit_card" } };
}

export type BankAccount = { ok: true; walletable: Walletable & { type: "bank_account" } } | { ok: false; reason: string };

/**
 * 「SecretAIry 口座」という名前の口座がちょうど1つで、銀行口座の時だけ使う。プログラムでは作らない。
 * 無い・2つ以上・種類が違う時は、銀行の分だけ出さない（カードの分は出す）。理由は1行で同じ文。
 */
export function pickBankAccount(list: Walletable[], name: string): BankAccount {
  const hit = list.filter((w) => w.name === name);
  if (hit.length !== 1 || hit[0].type !== "bank_account") return { ok: false, reason: bankMissing(name) };
  return { ok: true, walletable: { ...hit[0], type: "bank_account" } };
}

export const bankMissing = (name: string) => `銀行の口座（${name}）が見つかりません`;

/** 照らし合わせた結果 */
export type Lookup =
  | { kind: "missing" }
  | { kind: "many"; count: number; by?: "mark" | "id" }
  | { kind: "mismatch"; reason: string; txn: WalletTxn }
  | { kind: "found"; txn: WalletTxn };

/**
 * 印で freee の明細を探す。事業所・口座が違う物は数えない。
 * 候補が2件以上なら止める。日付・金額・出金かまで合う時だけ found。
 */
export function lookup(txns: WalletTxn[], p: { companyId: number; walletableId: number; mark: string; item: CardItem }): Lookup {
  const type = WALLETABLE_TYPE[accountOf(p.item)];
  const hit = txns.filter((t) => t.company_id === p.companyId && t.walletable_type === type && t.walletable_id === p.walletableId && hasMark(t.description, p.mark));
  if (hit.length === 0) return { kind: "missing" };
  if (hit.length > 1) return { kind: "many", count: hit.length };
  const t = hit[0];
  const diff: string[] = [];
  if (t.date !== p.item.date) diff.push("日付");
  if (t.amount !== p.item.amount) diff.push("金額");
  if (t.entry_side !== sideOf(p.item)) diff.push("出金か入金か");
  if (diff.length) return { kind: "mismatch", reason: `freee の明細と${diff.join("・")}が合いません`, txn: t };
  return { kind: "found", txn: t };
}

/** 摘要に入っているこのアプリの印（無ければ null） */
export function markIn(description: string, prefix: string): string | null {
  return description.split(/\s+/).find((w) => w.startsWith(`${prefix}:`)) ?? null;
}

/**
 * freee の明細の番号（wallet_txn の id）で探す（印の無い明細も）。事業所・決めた口座が違う物は数えない。
 * 候補：同じ番号の明細（中身が違う物が2つ読めた時は2件）と、その明細に印があれば同じ印の明細。2件以上なら止める。
 * expect があれば、日付・金額・出金かまで全部合う時だけ found。
 */
export function lookupById(
  txns: WalletTxn[],
  p: { companyId: number; walletable: { id: number; type: WalletableType }; id: number; markPrefix: string; expect?: { date: string; amount: number } },
): Lookup {
  const mine = txns.filter((t) => t.company_id === p.companyId && t.walletable_type === p.walletable.type && t.walletable_id === p.walletable.id);
  const byId = mine.filter((t) => t.id === p.id);
  if (byId.length === 0) return { kind: "missing" };
  if (byId.length > 1) return { kind: "many", count: byId.length, by: "id" };
  const t = byId[0];
  const mark = markIn(t.description, p.markPrefix);
  if (mark) {
    const same = mine.filter((x) => hasMark(x.description, mark));
    if (same.length > 1) return { kind: "many", count: same.length };
  }
  if (!p.expect) return { kind: "found", txn: t };
  const diff: string[] = [];
  if (t.date !== p.expect.date) diff.push("日付");
  if (t.amount !== p.expect.amount) diff.push("金額");
  if (t.entry_side !== "expense") diff.push("出金か入金か");
  if (diff.length) return { kind: "mismatch", reason: `freee の明細と${diff.join("・")}が合いません`, txn: t };
  return { kind: "found", txn: t };
}

/** freee の明細の状態での分け方 */
export type Verdict =
  | { kind: "ready"; txn: WalletTxn }
  | { kind: "done"; txn: WalletTxn }
  | { kind: "check"; reason: string }
  | { kind: "missing" };

/**
 * - 未処理（status 1）で、登録待ちの金額 = 明細の金額 → 登録する（ready）
 * - 処理済み（status 2）で、登録待ちが 0 → freee で処理済み（done。送り直さない）
 * - 無視・一部だけ登録・対象外・値が合わない・候補が2件以上 → 確かめが要る（check）
 */
export function verdictOf(l: Lookup): Verdict {
  if (l.kind === "missing") return { kind: "missing" };
  if (l.kind === "many")
    return { kind: "check", reason: `${l.by === "id" ? "同じ番号で中身の違う明細" : "同じ印の明細"}が freee に${l.count}件あります。どれか決められないので止めました` };
  if (l.kind === "mismatch") return { kind: "check", reason: l.reason };
  const t = l.txn;
  if (t.status === 1 && t.due_amount === t.amount) return { kind: "ready", txn: t };
  if (t.status === 2 && t.due_amount === 0) return { kind: "done", txn: t };
  const why =
    t.status === 3
      ? "freee で「無視」になっています"
      : t.status === 4
        ? "freee で一部の金額だけ登録されています"
        : t.status === 6
          ? "freee で対象外になっています"
          : "freee の明細の状態と登録待ちの金額が合いません";
  return { kind: "check", reason: why };
}

/**
 * 店用か私用か（ブラウザから来た選びを、最初の状態の自動のルールと照らす）。
 * 購入先は摘要に購入先の名前がちょうど1つ含まれる時だけ決まる（決まらなければルールは無い）。
 */
export function useAllowed(description: string, use: CardUse, seed: { merchants: Merchant[]; rules: { merchantId: string; use: CardUse }[] }): boolean {
  const m = merchantOfText(description, seed.merchants);
  const rule = m === null ? undefined : seed.rules.find((r) => r.merchantId === m);
  return !rule || rule.use === use;
}

/** 名前でちょうど1つに決まる物だけ使う */
export function pickOne<T>(list: T[], ok: (x: T) => boolean): { ok: true; value: T } | { ok: false; count: number } {
  const hit = list.filter(ok);
  return hit.length === 1 ? { ok: true, value: hit[0] } : { ok: false, count: hit.length };
}
