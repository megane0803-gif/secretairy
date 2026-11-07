// 来た人の試しを、数分後に元の形に戻す（サーバーの側。docs/SPEC.md §1.8.2）。AI は呼ばない。
// 元に戻すのは、来た人が /api/freee/try で登録した明細だけ（置き場の記録にある物だけ）。入金・印の無い明細・
// オーナーが cookie の道で登録した物には触らない。
//
// 記録（置き場の freee:try:trial）：
//   - 書く前に「書くかもしれない明細の番号」を置く。登録できたら取引の番号（deal_ids／deal_id）も置く
//   - 返事が途切れて取引の番号が分からない時（KV に書けなかった時も）は、番号が null のまま → 要復旧（repair）
//   - 最後に書いた時刻。そこから holdSeconds 秒は、その形のまま見られる
// 元に戻す（書く時の印の中で）：
//   1. 記録にある取引の番号の物だけを消す（DELETE /api/1/deals/{id}）。ほかの取引には触らない
//   2. その明細を読み直す。見本どおりの未処理に戻っていれば終わり
//   3. 戻らない時は、その見本の明細（印のある・手で作った物）を消し（DELETE /api/1/wallet_txns/{id}）、
//      「明細を入れる」と同じ中身と印で作り直す
//   4. 読み直して、全部「印があり・見本どおり・未処理」かを確かめる（自動登録のルールに当たった時も含め、ならなければ要復旧）
//   取引の番号が分からない明細は、消す・作り直すもしない（要復旧で止める）。持ち時間の中で終わらなければ区切り、次の呼び出しで続きから。

import { accountOf, sideOf } from "../accounting/rows";
import type { AccountingSeed, CardItem, CardUse, StatementAccount } from "../data/types";
import type { KvStore } from "../line/store";
import type { FreeeSettings } from "../settings";
import { FreeeExpired, FreeeOutOfTime, FreeeRejected, type FreeeClient, type WalletTxn } from "./api";
import { FREEE_KV, kv, StoreDown } from "./kv";
import { descriptionOf, hasMark, markIn, markOf, pickBankAccount, pickCardAccount, WALLETABLE_TYPE } from "./match";

export type TrialStep = "writing" | "written" | "deals-gone" | "txn-deleted" | "recreated";

export type TrialItem = {
  /** いまの freee の明細の番号（作り直したら新しい番号） */
  id: number;
  account: StatementAccount;
  /** 見本の明細の番号（seed.statement.items の no） */
  no: number;
  use: CardUse;
  /** 取引の番号。null は「分からない」（返事が途切れた・置き場に書けなかった） */
  dealIds: number[] | null;
  step: TrialStep;
};

export type Trial = {
  v: 1;
  /** 試している人（送り元のハッシュ。生の IP は持たない） */
  by: string | null;
  items: TrialItem[];
  /** 最後に書いた時刻（ms） */
  lastWriteAt: number | null;
  /** 要復旧：自分では元に戻せない（来た人の登録を止める。オーナーが直す） */
  repair: boolean;
  /** 元に戻し始めた（終わるまで登録させない） */
  restoring: boolean;
};

export const EMPTY_TRIAL: Trial = { v: 1, by: null, items: [], lastWriteAt: null, repair: false, restoring: false };

const STEPS = new Set<TrialStep>(["writing", "written", "deals-gone", "txn-deleted", "recreated"]);
const isId = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;

export function parseTrial(raw: string | null): Trial {
  if (!raw) return EMPTY_TRIAL;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(raw);
  } catch {
    // 読めない記録は、元に戻せるか分からないので要復旧
    return { ...EMPTY_TRIAL, repair: true };
  }
  if (!d || typeof d !== "object" || d.v !== 1 || !Array.isArray(d.items)) return { ...EMPTY_TRIAL, repair: true };
  const items: TrialItem[] = [];
  let bad = false;
  for (const x of d.items as Record<string, unknown>[]) {
    const ok =
      x &&
      isId(x.id) &&
      (x.account === "card" || x.account === "bank") &&
      isId(x.no) &&
      (x.use === "shop" || x.use === "private") &&
      (x.dealIds === null || (Array.isArray(x.dealIds) && x.dealIds.every(isId))) &&
      STEPS.has(x.step as TrialStep);
    if (!ok) {
      bad = true;
      continue;
    }
    items.push({ id: x.id as number, account: x.account as StatementAccount, no: x.no as number, use: x.use as CardUse, dealIds: (x.dealIds as number[] | null) ?? null, step: x.step as TrialStep });
  }
  return {
    v: 1,
    by: typeof d.by === "string" ? d.by : null,
    items,
    lastWriteAt: typeof d.lastWriteAt === "number" ? d.lastWriteAt : null,
    repair: d.repair === true || bad,
    restoring: d.restoring === true,
  };
}

export async function loadTrial(store: KvStore): Promise<Trial> {
  return parseTrial(await kv(() => store.get(FREEE_KV.trial)));
}

/** 記録を書く（期限つき）。空なら消す。書けなければ StoreDown */
export async function saveTrial(store: KvStore, settings: FreeeSettings, t: Trial): Promise<void> {
  if (t.items.length === 0 && !t.repair) {
    await kv(() => store.del(FREEE_KV.trial));
    return;
  }
  const ok = await kv(() => store.set(FREEE_KV.trial, JSON.stringify(t), { ex: Math.max(1, Math.round(settings.try.trialKeepDays * 86_400)) }));
  if (!ok) throw new StoreDown("置き場に書けません");
}

/** 元に戻す時か（最後に書いてから holdSeconds 秒をこえた・元に戻し始めている） */
export function restoreDue(t: Trial, nowMs: number, settings: FreeeSettings): boolean {
  if (t.items.length === 0 || t.repair) return false;
  return t.restoring || t.lastWriteAt === null || nowMs >= t.lastWriteAt + settings.try.holdSeconds * 1000;
}

/** 元に戻すまでの分（切り上げ。0 なら次の呼び出しで戻す） */
export function minutesLeft(t: Trial, nowMs: number, settings: FreeeSettings): number {
  if (t.lastWriteAt === null) return 0;
  return Math.max(0, Math.ceil((t.lastWriteAt + settings.try.holdSeconds * 1000 - nowMs) / 60_000));
}

// ---- 見本の明細 ----

const versionOf = (seed: AccountingSeed) => seed.statement.version ?? "v1";
const merchantNameOf = (seed: AccountingSeed, item: CardItem) => seed.merchants.find((m) => m.id === item.merchantId)?.name ?? item.merchantId;

/** 印から見本の明細を引く（印の形が「頭:版:番号」で、版がいまのデータの版、番号の見本がある時だけ） */
export function seedItemOfMark(seed: AccountingSeed, prefix: string, mark: string): CardItem | null {
  const m = mark.match(/^(.+):(.+):([1-9]\d{0,5})$/);
  if (!m || m[1] !== prefix || m[2] !== versionOf(seed)) return null;
  const item = seed.statement.items.find((i) => i.no === Number(m[3]));
  return item && markOf(prefix, versionOf(seed), item.no) === mark ? item : null;
}

/** 見本の明細を freee に入れる時の中身（「明細を入れる」と同じ） */
export function seedTxnParams(seed: AccountingSeed, prefix: string, item: CardItem) {
  const mark = markOf(prefix, versionOf(seed), item.no);
  return { mark, entry_side: sideOf(item), amount: item.amount, date: item.date, description: descriptionOf(merchantNameOf(seed, item), mark), account: accountOf(item) };
}

/**
 * freee の明細が、その見本とちょうど合うか（日付・金額・出金か入金か・口座・摘要）。未処理かは見ない。
 * オーナーが手で変えた明細は合わない。
 */
export function matchesSeed(seed: AccountingSeed, prefix: string, item: CardItem, t: WalletTxn, walletable: { id: number; type: WalletTxn["walletable_type"] }, companyId: number): boolean {
  const p = seedTxnParams(seed, prefix, item);
  return (
    t.company_id === companyId &&
    t.walletable_type === WALLETABLE_TYPE[p.account] &&
    t.walletable_id === walletable.id &&
    t.date === p.date &&
    t.amount === p.amount &&
    t.entry_side === p.entry_side &&
    t.description === p.description
  );
}

/** 見本どおりの未処理（元の形）か：見本と合い・未処理（status 1・登録待ち＝金額）・自動登録のルールで登録されていない */
export function isOriginal(seed: AccountingSeed, prefix: string, item: CardItem, t: WalletTxn, walletable: { id: number; type: WalletTxn["walletable_type"] }, companyId: number): boolean {
  return matchesSeed(seed, prefix, item, t, walletable, companyId) && t.status === 1 && t.due_amount === t.amount && t.rule_matched !== true;
}

// ---- 元に戻す ----

export type RestoreCtx = {
  api: FreeeClient;
  store: KvStore;
  settings: FreeeSettings;
  seed: AccountingSeed;
  companyId: number;
  range: { from: string; to: string };
};

/** done：全部元に戻った（記録を消した）・partial：持ち時間などで区切った（次の呼び出しで続き）・repair：要復旧で止めた */
export type RestoreResult = "done" | "partial" | "repair";

/** 書く時の印の中から呼ぶ。FreeeExpired は投げる（鍵が切れた。呼ぶ側で扱う） */
export async function restoreTrial(c: RestoreCtx): Promise<RestoreResult> {
  let t = await loadTrial(c.store);
  if (t.repair) return "repair";
  if (t.items.length === 0) return "done";
  const save = async () => saveTrial(c.store, c.settings, t);
  const repair = async (): Promise<RestoreResult> => {
    t = { ...t, repair: true };
    await save();
    return "repair";
  };
  // 取引の番号が分からない明細があれば、消す・作り直すもしない
  if (t.items.some((i) => i.dealIds === null || i.step === "writing")) return repair();
  if (t.items.some((i) => !c.seed.statement.items.some((s) => s.no === i.no))) return repair();
  if (!t.restoring) {
    t = { ...t, restoring: true };
    await save();
  }
  const prefix = c.settings.markPrefix;
  try {
    // 1. 記録にある取引だけを消す
    for (const item of t.items) {
      while (item.dealIds && item.dealIds.length > 0) {
        const id = item.dealIds[0];
        try {
          await c.api.deleteDeal(id, c.companyId);
        } catch (e) {
          // 404：もう無い。ほかの 400 台：消せない（元に戻せない）→ 要復旧
          if (!(e instanceof FreeeRejected)) throw e;
          if (e.status !== 404) return repair();
        }
        item.dealIds = item.dealIds.slice(1);
        if (item.dealIds.length === 0 && item.step === "written") item.step = "deals-gone";
        await save();
      }
      if (item.step === "written") {
        item.step = "deals-gone";
        await save();
      }
    }

    // 2. 読み直す（口座はカードと銀行の2つだけ）
    const list = await c.api.walletables(c.companyId);
    const card = pickCardAccount(list, c.settings.cardName);
    const bank = pickBankAccount(list, c.settings.bankName);
    const wOf = (a: StatementAccount) => (a === "card" ? (card.ok ? card.walletable : null) : bank.ok ? bank.walletable : null);
    if (t.items.some((i) => !wOf(i.account))) return repair();
    const readAll = async () => {
      const out: Partial<Record<StatementAccount, WalletTxn[]>> = {};
      for (const a of [...new Set(t.items.map((i) => i.account))]) out[a] = await c.api.walletTxns(c.companyId, wOf(a)!, c.range);
      return out;
    };
    let txns = await readAll();
    const sameMark = (item: TrialItem, from: Partial<Record<StatementAccount, WalletTxn[]>>) => {
      const w = wOf(item.account)!;
      const s = c.seed.statement.items.find((x) => x.no === item.no)!;
      const mark = seedTxnParams(c.seed, prefix, s).mark;
      return { w, s, hit: (from[item.account] ?? []).filter((x) => x.company_id === c.companyId && x.walletable_id === w.id && x.walletable_type === w.type && hasMark(x.description, mark)) };
    };

    // 3. 戻らない明細は、印のある見本の明細だけを消して作り直す
    let created = false;
    for (const item of t.items) {
      const { w, s, hit } = sameMark(item, txns);
      if (hit.length > 1) return repair();
      const x = hit[0];
      if (x && isOriginal(c.seed, prefix, s, x, w, c.companyId)) continue;
      if (x) {
        // 作り直した明細が戻らない（自動登録のルールに当たった など）・見本と値が違う（手で変えた）→ 要復旧
        if (item.step === "recreated" || x.rule_matched === true || !matchesSeed(c.seed, prefix, s, x, w, c.companyId)) return repair();
        // 消す前に、印が見本の印そのものかも確かめる（手で作った見本の明細だけ。同期で取った明細には印が無い）
        if (markIn(x.description, prefix) === null) return repair();
        try {
          await c.api.deleteWalletTxn(x.id, c.companyId);
        } catch (e) {
          if (!(e instanceof FreeeRejected)) throw e;
          if (e.status !== 404) return repair();
        }
        item.step = "txn-deleted";
        await save();
      } else if (item.step !== "txn-deleted") {
        // 自分で消していないのに見つからない → 自分では決めない
        return repair();
      }
      const p = seedTxnParams(c.seed, prefix, s);
      const made = await c.api.createWalletTxn({
        company_id: c.companyId,
        walletable_type: WALLETABLE_TYPE[p.account],
        walletable_id: w.id,
        entry_side: p.entry_side,
        amount: p.amount,
        date: p.date,
        description: p.description,
      });
      item.id = made.id;
      item.step = "recreated";
      created = true;
      await save();
    }

    // 4. 読み直して、全部が元の形かを確かめる
    if (created) txns = await readAll();
    for (const item of t.items) {
      const { w, s, hit } = sameMark(item, txns);
      if (hit.length !== 1 || !isOriginal(c.seed, prefix, s, hit[0], w, c.companyId)) return repair();
    }
    t = { ...EMPTY_TRIAL };
    await save();
    return "done";
  } catch (e) {
    if (e instanceof FreeeExpired) {
      await save();
      throw e;
    }
    // 持ち時間が足りない（送る前に止めた）・返事が途切れた（消すのは何度でも同じ。作るのは次の回に印で照らし合わせる）：区切る
    if (e instanceof FreeeOutOfTime || !(e instanceof FreeeRejected)) {
      await save();
      return "partial";
    }
    return repair();
  }
}

/**
 * 要復旧の記録が、オーナーが freee の側で直して見本どおりの未処理に戻っているか（読むだけ。消す・作り直すはしない）。
 * 全部戻っていれば記録を消して true（オーナーがもう一度つないだ時だけ呼ぶ）。
 */
export async function clearRepairedTrial(c: RestoreCtx): Promise<boolean> {
  const t = await loadTrial(c.store);
  if (!t.repair) return false;
  const list = await c.api.walletables(c.companyId);
  const card = pickCardAccount(list, c.settings.cardName);
  const bank = pickBankAccount(list, c.settings.bankName);
  const prefix = c.settings.markPrefix;
  const read: Partial<Record<StatementAccount, WalletTxn[]>> = {};
  for (const item of t.items) {
    const w = item.account === "card" ? (card.ok ? card.walletable : null) : bank.ok ? bank.walletable : null;
    const s = c.seed.statement.items.find((x) => x.no === item.no);
    if (!w || !s) return false;
    read[item.account] ??= await c.api.walletTxns(c.companyId, w, c.range);
    const mark = seedTxnParams(c.seed, prefix, s).mark;
    const hit = read[item.account]!.filter((x) => x.company_id === c.companyId && x.walletable_id === w.id && hasMark(x.description, mark));
    if (hit.length !== 1 || !isOriginal(c.seed, prefix, s, hit[0], w, c.companyId)) return false;
  }
  await saveTrial(c.store, c.settings, { ...EMPTY_TRIAL });
  return true;
}
