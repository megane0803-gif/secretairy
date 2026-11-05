// freee（テスト事業所）の明細と、経理タブの架空のカード明細を照らし合わせる（プログラム。AI は使わない）。
// 印は摘要に入れる「SecretAIry:<データの版>:<明細の番号>」。印で探し、日付・金額・出金かまで合う時だけ進む。

import type { CardItem, CardUse } from "../data/types";
import type { Walletable, WalletTxn } from "./api";

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

/** 照らし合わせた結果 */
export type Lookup =
  | { kind: "missing" }
  | { kind: "many"; count: number }
  | { kind: "mismatch"; reason: string; txn: WalletTxn }
  | { kind: "found"; txn: WalletTxn };

/**
 * 印で freee の明細を探す。事業所・口座が違う物は数えない。
 * 候補が2件以上なら止める。日付・金額・出金かまで合う時だけ found。
 */
export function lookup(txns: WalletTxn[], p: { companyId: number; walletableId: number; mark: string; item: CardItem }): Lookup {
  const hit = txns.filter(
    (t) => t.company_id === p.companyId && t.walletable_type === "credit_card" && t.walletable_id === p.walletableId && hasMark(t.description, p.mark),
  );
  if (hit.length === 0) return { kind: "missing" };
  if (hit.length > 1) return { kind: "many", count: hit.length };
  const t = hit[0];
  const diff: string[] = [];
  if (t.date !== p.item.date) diff.push("日付");
  if (t.amount !== p.item.amount) diff.push("金額");
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
  if (l.kind === "many") return { kind: "check", reason: `同じ印の明細が freee に${l.count}件あります。どれか決められないので止めました` };
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

/** 店用か私用か（ブラウザから来た選びを、最初の状態の自動のルールと照らす） */
export function useAllowed(item: CardItem, use: CardUse, seedRules: { merchantId: string; use: CardUse }[]): boolean {
  const rule = seedRules.find((r) => r.merchantId === item.merchantId);
  return !rule || rule.use === use;
}

/** 名前でちょうど1つに決まる物だけ使う */
export function pickOne<T>(list: T[], ok: (x: T) => boolean): { ok: true; value: T } | { ok: false; count: number } {
  const hit = list.filter(ok);
  return hit.length === 1 ? { ok: true, value: hit[0] } : { ok: false, count: hit.length };
}
