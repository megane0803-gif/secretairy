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
import { FreeeExpired, FreeeOutOfTime, FreeeRejected, isTransientRefusal, TRANSIENT_REFUSALS, type FreeeClient, type WalletTxn } from "./api";
import { FREEE_KV, kv, StoreDown, type StillHeld } from "./kv";
import { descriptionOf, hasMark, markIn, markOf, pickBankAccount, pickCardAccount, WALLETABLE_TYPE } from "./match";

export type TrialStep = "writing" | "written" | "deals-gone" | "txn-deleting" | "txn-deleted" | "recreating" | "recreated";

export type TrialItem = {
  /** いまの freee の明細の番号（作り直したら、記録した新しい番号） */
  id: number;
  account: StatementAccount;
  /** 見本の明細の番号（seed.statement.items の no） */
  no: number;
  use: CardUse;
  /** 取引の番号。null は「分からない」（返事が途切れた・置き場に書けなかった） */
  dealIds: number[] | null;
  /** いま消している取引の番号（送る前に置く。前の回に送って返事が途切れた時だけ、404 を「もう無い」とみなす） */
  deleting: number | null;
  /**
   * 前の回の一歩が残っていて、404 を「もう無い」として受けた（本当に消えたかは分からない。送る前に処理ごと落ちて一歩だけ残った形かもしれない）。
   * この印のある明細は、未処理に戻っていなければ（取引が残っている形）、消す・作り直すをせずに要復旧
   */
  assumedGone?: boolean;
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
  /** 読めない記録だった（形が壊れている・壊れた項目があった）。どの明細を試したか分からないので、外す時は見本の出金を全部確かめる */
  broken: boolean;
  /** 元に戻し始めた（終わるまで登録させない） */
  restoring: boolean;
  /**
   * 元に戻す回が、一歩も進まずに freee の 409・423 で区切られて終わった回数（続けて）。freee.try.maxTransientRounds に届いたら要復旧に上げる
   * （断りが続いて「元に戻しています」のまま止まり続けないように）。429（回数が多いので少し待って）は待てば通るので数えない。
   * その回の中で一歩でも進んだ時と、ほかの終わり方の時は0に戻す
   */
  refusals?: number;
};

export const EMPTY_TRIAL: Trial = { v: 1, by: null, items: [], lastWriteAt: null, repair: false, broken: false, restoring: false };
const BROKEN: Trial = { ...EMPTY_TRIAL, repair: true, broken: true };

const STEPS = new Set<TrialStep>(["writing", "written", "deals-gone", "txn-deleting", "txn-deleted", "recreating", "recreated"]);
const isId = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;

export function parseTrial(raw: string | null): Trial {
  if (!raw) return EMPTY_TRIAL;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(raw);
  } catch {
    // 読めない記録は、元に戻せるか分からないので要復旧（壊れた印つき）
    return BROKEN;
  }
  if (!d || typeof d !== "object" || d.v !== 1 || !Array.isArray(d.items)) return BROKEN;
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
      (x.deleting === undefined || x.deleting === null || isId(x.deleting)) &&
      (x.assumedGone === undefined || typeof x.assumedGone === "boolean") &&
      STEPS.has(x.step as TrialStep);
    if (!ok) {
      bad = true;
      continue;
    }
    items.push({
      id: x.id as number,
      account: x.account as StatementAccount,
      no: x.no as number,
      use: x.use as CardUse,
      dealIds: (x.dealIds as number[] | null) ?? null,
      deleting: (x.deleting as number | null | undefined) ?? null,
      ...(x.assumedGone === true ? { assumedGone: true } : {}),
      step: x.step as TrialStep,
    });
  }
  return {
    v: 1,
    by: typeof d.by === "string" ? d.by : null,
    items,
    lastWriteAt: typeof d.lastWriteAt === "number" ? d.lastWriteAt : null,
    repair: d.repair === true || bad,
    broken: d.broken === true || bad,
    restoring: d.restoring === true,
    ...(typeof d.refusals === "number" && Number.isSafeInteger(d.refusals) && d.refusals > 0 ? { refusals: d.refusals } : {}),
  };
}

/** 一時的な断りの数を置きかえる（0 なら欄を外す） */
function withRefusals(t: Trial, n: number): Trial {
  const { refusals: _drop, ...rest } = t;
  void _drop;
  return n > 0 ? { ...rest, refusals: n } : rest;
}

/** 取引の番号が分からない明細があるか（返事が途切れた・置き場に書けなかった。消す・作り直すもしない） */
export const hasUnknownDeal = (t: Trial) => t.items.some((i) => i.dealIds === null || i.step === "writing");

export async function loadTrial(store: KvStore): Promise<Trial> {
  return parseTrial(await kv(() => store.get(FREEE_KV.trial)));
}

/** 記録を書く（期限つき）。空なら消す。書けなければ StoreDown */
export async function saveTrial(store: KvStore, settings: FreeeSettings, t: Trial): Promise<void> {
  if (t.items.length === 0 && !t.repair && !t.broken) {
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
  /** 書く直前に、書く時の印がまだ自分の物かを確かめる（無ければ確かめない） */
  held?: StillHeld;
};

/** done：全部元に戻った（記録を消した）・partial：持ち時間などで区切った（次の呼び出しで続き）・repair：要復旧で止めた */
export type RestoreResult = "done" | "partial" | "repair";

/** 印の期限が来ていた（書く前に区切る。この後は置き場に書かない） */
class LockLost extends Error {}

// freee の一時的な断り（429・409・423）は、その一歩が受けられていないので、要復旧にせず区切り、次の回に続ける（置いた一歩は外す）。
// 分け方は api.ts の isTransientRefusal の1か所（鍵を延ばす所と同じ）
export { isTransientRefusal, TRANSIENT_REFUSALS };
/** 一歩を記録に置けなかった（送っていない。一歩は外して区切る） */
class StepNotPlaced extends Error {}

/**
 * 書く時の印の中から呼ぶ。終わった後の記録も返す（書いた直後に置き場を読み直さない）。FreeeExpired は投げる（鍵が切れた。呼ぶ側で扱う）。
 * 一歩ごとに、送る前に「これからすること」を記録に置き、終わったら書きなおす：
 *   - 取引を消す：deleting に番号を置いてから送る。404 を「もう無い」とみなすのは、前の回に送って返事が途切れた時（deleting が同じ番号）だけ。
 *     1回目の 404 は要復旧（この窓口で消せない取引かもしれない。明細を消す・作り直すはしない）
 *   - 明細を消す：記録の明細の番号（作り直した後は記録した新しい番号）と同じ明細だけ。違えば要復旧。txn-deleting を置いてから送り、
 *     返事が途切れた次の回に見つからなければ消えた扱い
 *   - 作り直す：recreating を置いてから送り、返事が途切れた次の回に見つからなければ、もう1つ作らずに要復旧
 */
export async function restoreTrial(c: RestoreCtx): Promise<{ result: RestoreResult; trial: Trial }> {
  let t = await loadTrial(c.store);
  if (t.repair) return { result: "repair", trial: t };
  if (t.items.length === 0) return { result: "done", trial: t };
  const save = async () => saveTrial(c.store, c.settings, t);
  const repair = async (): Promise<{ result: RestoreResult; trial: Trial }> => {
    t = { ...t, repair: true };
    await save();
    return { result: "repair", trial: t };
  };
  /**
   * 一歩（取引を消す・明細を消す・作り直す）の順：① 持ち時間と印を確かめる（一歩を置く前）② 一歩を記録に置く ③ 送る。
   * 送っていないと分かる止まり方（持ち時間が足りない・印を失った・一歩を置けなかった・鍵を受けられなかった 401・
   * 一時的な断り 429／409／423）では、
   * その一歩を記録に残さない（置いていたら外す）。一歩を残すのは、送った後に返事が途切れた時（送ったか分からない時）だけ。
   * place：この回に一歩を置くか（前の回に送った一歩が残っている時は置かない＝そのまま）。undo：置いた一歩を外す。
   */
  const stepped = async <T>(place: boolean, set: () => void, undo: () => void, call: () => Promise<T>): Promise<T> => {
    if (!c.api.canSend()) throw new FreeeOutOfTime("持ち時間が残っていないので送りませんでした");
    if (c.held && !(await c.held())) throw new LockLost();
    if (place) {
      set();
      try {
        await save();
      } catch {
        undo();
        try {
          await save();
        } catch {
          // 外した形も書けない：置き場が使えない（次の回も、置き場が戻ってから続ける）
        }
        throw new StepNotPlaced();
      }
    }
    try {
      return await call();
    } catch (e) {
      // 送る前に止めた（持ち時間）・鍵を受けられなかった・一時的な断り：受けられていないので、置いた一歩を外す
      if (place && (e instanceof FreeeOutOfTime || e instanceof FreeeExpired || isTransientRefusal(e))) {
        undo();
        await save();
      }
      throw e;
    }
  };
  // 取引の番号が分からない明細があれば、消す・作り直すもしない
  if (hasUnknownDeal(t)) return repair();
  if (t.items.some((i) => !c.seed.statement.items.some((s) => s.no === i.no))) return repair();
  if (!t.restoring) {
    t = { ...t, restoring: true };
    await save();
  }
  const prefix = c.settings.markPrefix;
  // この回の中で一歩でも進んだか（取引を消せた・明細を消せた・作り直せた）。進んでいる間は、一時的な断りを数えない
  let progressed = false;
  try {
    // 1. 記録にある取引だけを消す
    for (const item of t.items) {
      while (item.dealIds && item.dealIds.length > 0) {
        const id = item.dealIds[0];
        // 前の回に送って返事が途切れた一歩（送る前に止まった一歩は、その回に外してある）
        const resumed = item.deleting === id;
        try {
          await stepped(
            !resumed,
            () => (item.deleting = id),
            () => (item.deleting = null),
            () => c.api.deleteDeal(id, c.companyId),
          );
        } catch (e) {
          // 一時的な断りは区切り（下の catch で partial）
          if (!(e instanceof FreeeRejected) || isTransientRefusal(e)) throw e;
          // 1回目の 404・ほかの 400 台：消せない（元に戻せない）→ 要復旧。前の回に送った後の 404 だけ「もう無い」
          if (!(e.status === 404 && resumed)) return repair();
          // 前の回の一歩が残っていた 404：本当に消えたかは、手順3で明細が未処理に戻ったかで確かめる
          item.assumedGone = true;
        }
        item.dealIds = item.dealIds.slice(1);
        item.deleting = null;
        progressed = true;
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

    // 3. 戻らない明細は、記録の番号の見本の明細だけを消して作り直す
    let created = false;
    for (const item of t.items) {
      const { w, s, hit } = sameMark(item, txns);
      if (hit.length > 1) return repair();
      const x = hit[0];
      if (item.step === "recreating") {
        // 作り直しの返事が途切れた次の回：見本どおりの物が1つあれば、それが作った物。無ければもう1つ作らずに要復旧
        if (x && isOriginal(c.seed, prefix, s, x, w, c.companyId)) {
          item.id = x.id;
          item.step = "recreated";
          progressed = true;
          await save();
          continue;
        }
        return repair();
      }
      if (x && x.id !== item.id) return repair(); // 印が同じでも番号が違う明細（オーナーが入れ直した など）には触らない
      if (x && isOriginal(c.seed, prefix, s, x, w, c.companyId)) continue;
      // 404 を「もう無い」として受けた明細が未処理に戻っていない：取引が残っているかもしれないので、消す・作り直すをしない
      if (x && item.assumedGone) return repair();
      if (x) {
        // 作り直した明細が戻らない（自動登録のルールに当たった など）・見本と値が違う（手で変えた）→ 要復旧
        if (item.step === "recreated" || x.rule_matched === true || !matchesSeed(c.seed, prefix, s, x, w, c.companyId)) return repair();
        if (markIn(x.description, prefix) === null) return repair();
        const resumed = item.step === "txn-deleting";
        const before = item.step;
        try {
          await stepped(
            !resumed,
            () => (item.step = "txn-deleting"),
            () => (item.step = before),
            () => c.api.deleteWalletTxn(x.id, c.companyId),
          );
        } catch (e) {
          if (!(e instanceof FreeeRejected) || isTransientRefusal(e)) throw e;
          if (!(e.status === 404 && resumed)) return repair();
        }
        item.step = "txn-deleted";
        progressed = true;
        await save();
      } else if (item.step === "txn-deleting") {
        // 消した返事が途切れた次の回：記録の番号の明細が見つからない → 消えた扱い
        item.step = "txn-deleted";
        progressed = true;
        await save();
      } else if (item.step !== "txn-deleted") {
        // 自分で消していないのに見つからない → 自分では決めない
        return repair();
      }
      const p = seedTxnParams(c.seed, prefix, s);
      const before = item.step;
      const made = await stepped(
        true,
        () => (item.step = "recreating"),
        () => (item.step = before),
        () =>
          c.api.createWalletTxn({
            company_id: c.companyId,
            walletable_type: WALLETABLE_TYPE[p.account],
            walletable_id: w.id,
            entry_side: p.entry_side,
            amount: p.amount,
            date: p.date,
            description: p.description,
          }),
      );
      item.id = made.id;
      item.step = "recreated";
      created = true;
      progressed = true;
      await save();
    }

    // 4. 読み直して、全部が元の形か（記録の番号の明細が1つだけで、見本どおりの未処理）を確かめる
    if (created) txns = await readAll();
    for (const item of t.items) {
      const { w, s, hit } = sameMark(item, txns);
      if (hit.length !== 1 || hit[0].id !== item.id || !isOriginal(c.seed, prefix, s, hit[0], w, c.companyId)) return repair();
    }
    t = { ...EMPTY_TRIAL };
    await save();
    return { result: "done", trial: t };
  } catch (e) {
    // 印を失った：置き場に書かない（新しく印を取った呼び出しの記録を、古い中身で上書きしない）。記録は一歩ごとに置いてある
    if (e instanceof LockLost) return { result: "partial", trial: t };
    // 一歩を置けなかった（外してある）・置き場が使えない：書かずに区切る
    if (e instanceof StepNotPlaced) return { result: "partial", trial: t };
    if (e instanceof StoreDown) throw e;
    if (e instanceof FreeeExpired) {
      await save();
      throw e;
    }
    // 一時的な断り 429／409／423（読む所でも。置いた一歩は外してある）：区切る（次の回に、記録の一歩から続ける）。
    // 一歩も進まずに 409・423 で区切られた回が続けて maxTransientRounds 回になったら、要復旧に上げる（オーナーの画面に出る）。
    // 429 は待てば通るので数えない。この回の中で一歩でも進んでいれば、数を0に戻す
    if (isTransientRefusal(e)) {
      const counted = (e as FreeeRejected).status !== 429;
      const n = progressed ? 0 : (t.refusals ?? 0) + (counted ? 1 : 0);
      t = withRefusals(t, n);
      if (n >= c.settings.try.maxTransientRounds) return repair();
      await save();
      return { result: "partial", trial: t };
    }
    // 持ち時間が足りない（送る前に止めた。一歩は外してある）・返事が途切れた（一歩は残す）：区切る（次の回に、記録の一歩から続ける）
    if (e instanceof FreeeOutOfTime || !(e instanceof FreeeRejected)) {
      t = withRefusals(t, 0);
      await save();
      return { result: "partial", trial: t };
    }
    return repair();
  }
}

/**
 * 要復旧の記録を外してよいか（読むだけ。消す・作り直すはしない。オーナーがもう一度つないだ時だけ呼ぶ）。
 * - ふつうの記録：記録の明細が、みな見本どおりの未処理（印があり・1つだけ）に戻っていれば外す
 * - 読めない記録（壊れた）：どれを試したか分からないので、見本の出金がみな「印があり・見本どおり・未処理」と読めた時だけ外す
 * 外したら true。
 */
export async function clearRepairedTrial(c: RestoreCtx): Promise<boolean> {
  const t = await loadTrial(c.store);
  if (!t.repair) return false;
  const list = await c.api.walletables(c.companyId);
  const card = pickCardAccount(list, c.settings.cardName);
  const bank = pickBankAccount(list, c.settings.bankName);
  const prefix = c.settings.markPrefix;
  const nos = t.broken ? c.seed.statement.items.filter((i) => sideOf(i) === "expense").map((i) => i.no) : t.items.map((i) => i.no);
  if (nos.length === 0) return false;
  const read: Partial<Record<StatementAccount, WalletTxn[]>> = {};
  for (const no of nos) {
    const s = c.seed.statement.items.find((x) => x.no === no);
    if (!s) return false;
    const account = accountOf(s);
    const w = account === "card" ? (card.ok ? card.walletable : null) : bank.ok ? bank.walletable : null;
    if (!w) return false;
    read[account] ??= await c.api.walletTxns(c.companyId, w, c.range);
    const mark = seedTxnParams(c.seed, prefix, s).mark;
    const hit = read[account]!.filter((x) => x.company_id === c.companyId && x.walletable_id === w.id && hasMark(x.description, mark));
    if (hit.length !== 1 || !isOriginal(c.seed, prefix, s, hit[0], w, c.companyId)) return false;
  }
  await saveTrial(c.store, c.settings, { ...EMPTY_TRIAL });
  return true;
}
