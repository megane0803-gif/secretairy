// 来た人（審査員など）が合言葉なしで試せる、freee（テスト事業所）の窓口（POST /api/freee/try）の中身（docs/SPEC.md §1.8.2）。AI は呼ばない。
// オーナーが1回つないだ鍵（置き場の kv-token）を使う。オーナーの窓口（start・callback・import・register・check・disconnect）は
// 今どおり cookie だけで、ここからは「明細を入れる」「つなぎを外す」はできない。
//
// できるのは2つだけ（action）：
//   - read：未処理の明細を読む・読み直す（今の読み込みと同じ形・同じ項目）＋ 試した明細がいま freee でどうなっているか
//   - register：1件を「店用」「私用」に決めて登録する（今の登録と同じ中身。科目・税の決め方・useAllowed も今どおり）
// ブラウザから受け取るのは「明細の番号」と「店用か私用か」だけ（金額・日付・科目・摘要・口座・事業所は受け取らない）。
// 登録できるのは、印のある見本の明細で、印から引いた見本と日付・金額・出金・口座・摘要がちょうど合い、出金で未処理の物だけ。
//
// 守り：本番のサイトだけ・Origin（ほかのサイトからは 403。人を確かめる物ではない）・GET は 405・大きさの上限・1回に1件・
// 書く時は「同時に1回」の印（オーナーの書く窓口・元に戻すと同じ1つ）・回数の上限（登録と読むで別。1日（全体）・1分（全体）・同じ送り元から1日。
// 店の日付ごと。先に足してから比べる。置き場が使えない時は受けない 503）。送り元は Vercel が付ける IP を日ごとの塩と合わせたハッシュで数え、生の IP は残さない。
// 窓口の頭で、5分をこえた試しを先に元に戻してから続ける（元に戻すは回数の上限とは別に数え、上限で止めない）。
// 返事とログには決まった短い理由だけ（freee の生のエラー文・事業所の番号・鍵・IP・ハッシュは出さない）。結果が分からない時は送り直さない。

import { accountOf } from "../accounting/rows";
import type { CardUse, StatementAccount } from "../data/types";
import { siteCheck } from "../server/site";
import { sourceBucket, sourceHash, sourceIp } from "../server/source";
import { freeeClient, FreeeExpired, FreeeOutOfTime, isOpen, type FreeeClient, type WalletTxn } from "./api";
import { FREEE_KV, kv, kvAccess, markKvExpired, StoreDown, withWriteLock, type KvCtx, type KvToken, type StillHeld } from "./kv";
import { lookupById, markIn, pickBankAccount, pickCardAccount } from "./match";
import { envProblems, json, kvCtxOf, openRows, prepareOne, readRange, todayIn, writeOne, type FreeeDeps, type ReadAccount } from "./server";
import type { TryInfo, TryPhase } from "./tryClient";
import { hasUnknownDeal, loadTrial, matchesSeed, minutesLeft, restoreDue, restoreTrial, saveTrial, seedItemOfMark, type RestoreResult, type Trial } from "./trial";

export const TRY_MESSAGES = {
  notConnected: "いまは経理につながっていません（オーナーがつなぎ直します）",
  wait: "いま ほかの書き込みをしています。少し待ってから、もう一度押してください",
  noStore: "いまは試せません（数を数える置き場につながりません）",
  repair: "いまは試せません（オーナーが直します）",
  restoring: "元に戻しています。少し待ってから、もう一度押してください",
  limit: "いまは混んでいるので試せません。時間をおいてから、もう一度押してください",
  senderLimit: "今日はここから試せる回数を使い切りました。明日もう一度試してください",
  unknown: "送った後に返事が途切れました。送り直しません。いまは試せません（オーナーが直します）",
  readFailed: "テスト用の事業所から読めませんでした（何も書いていません）",
};

type Kind = "register" | "read";

// ---- 送り元と回数 ----

/** 送り元（Vercel が付ける IP。共通の1か所 src/lib/server/source.ts） */
export const senderIp = sourceIp;

/**
 * 日ごとの塩（サーバーが作って置き場に置き、2日で消える）と、送り元の束（IPv4 は1つの番地・IPv6 は /64）を合わせたハッシュ。
 * 塩は、置けた（SET NX が true）時は作った値をそのまま使う（置いた直後の GET は、まだ写っていない写しから古い値で返ることがある）。
 * 読むのは、ほかの呼び出しがもう置いていて置けなかった時だけ。生の IP は置き場にも返事にも出さない。
 */
async function senderHash(deps: FreeeDeps, request: Request, date: string): Promise<string> {
  const store = deps.store!;
  const key = FREEE_KV.salt(date);
  const fresh = deps.random(32).toString("hex");
  if (await kv(() => store.set(key, fresh, { ex: 2 * 86_400, nx: true }))) return sourceHash(fresh, sourceBucket(sourceIp(request)));
  const salt = await kv(() => store.get(key));
  if (!salt) throw new StoreDown("塩を置けません");
  return sourceHash(salt, sourceBucket(sourceIp(request)));
}

/**
 * 先に足してから比べる（同時に来ても数えもれが無い）。同じ送り元 → 全体の1分 → 全体の1日の順で、こえたらそこで止め、
 * 先の数は足さない（1つの送り元が送り続けても、全体の数はその送り元の上限までしか増えない。広告のだれでも試すと同じ数え方）。
 */
async function countUnder(deps: FreeeDeps, kind: Kind, date: string, sender: string): Promise<"ok" | "limit" | "sender"> {
  const store = deps.store!;
  const lim = deps.settings.try[kind];
  const minute = Math.floor(deps.now() / 60_000);
  if ((await kv(() => store.incr(FREEE_KV.count(kind, `sender:${date}:${sender}`), 2 * 86_400))) > lim.perSenderDaily) return "sender";
  if ((await kv(() => store.incr(FREEE_KV.count(kind, `min:${minute}`), 120))) > lim.perMinute) return "limit";
  if ((await kv(() => store.incr(FREEE_KV.count(kind, `day:${date}`), 2 * 86_400))) > lim.daily) return "limit";
  return "ok";
}

// ---- 読む ----

async function readBoth(api: FreeeClient, deps: FreeeDeps, companyId: number, range: { from: string; to: string }, max: number) {
  const list = await api.walletables(companyId);
  const card = pickCardAccount(list, deps.settings.cardName);
  const bank = pickBankAccount(list, deps.settings.bankName);
  const read: ReadAccount[] = [];
  if (card.ok) read.push({ account: "card", walletable: card.walletable, txns: await api.walletTxns(companyId, card.walletable, range, { stopAfterOpen: max }) });
  if (bank.ok) read.push({ account: "bank", walletable: bank.walletable, txns: await api.walletTxns(companyId, bank.walletable, range, { stopAfterOpen: max }) });
  return { card, bank, read };
}

function infoOf(deps: FreeeDeps, t: Trial, sender: string, read: ReadAccount[] | null, note: RestoreResult | "busy" | null): TryInfo {
  const now = deps.now();
  const holdMinutes = Math.round(deps.settings.try.holdSeconds / 60);
  const phase: TryPhase = t.repair || note === "repair" ? "repair" : note === "partial" || note === "busy" || t.restoring || restoreDue(t, now, deps.settings) ? (t.items.length ? "restoring" : "free") : t.items.length ? "holding" : "free";
  const items = t.items.map((i) => {
    const hit = read?.find((r) => r.account === i.account)?.txns.find((x) => x.id === i.id);
    const state: "registered" | "open" | "other" = !hit ? "other" : hit.status === 2 && hit.due_amount === 0 ? "registered" : isOpen(hit) ? "open" : "other";
    return { id: i.id, use: i.use, state };
  });
  return { phase, minutes: phase === "holding" ? Math.max(1, minutesLeft(t, now, deps.settings)) : 0, mine: !!t.by && t.by === sender, items, holdMinutes, maxItems: deps.settings.try.maxItemsPerTrial };
}

// ---- 窓口 ----

// 1回の呼び出しの持ち時間（始めた時から serverBudgetSeconds）。元に戻す・読む・書くの全部が同じ締め切りを使う
const started = new WeakMap<FreeeDeps, number>();

/** freee を呼ぶ道具。締め切りは、呼び出しの持ち時間と、書く時の印の期限の早い方（期限の後に書かない） */
function apiFor(deps: FreeeDeps, tok: Pick<KvToken, "accessToken">, lockUntil?: number): FreeeClient {
  const budget = (started.get(deps) ?? deps.now()) + deps.settings.serverBudgetSeconds * 1000;
  return freeeClient({
    fetch: deps.fetch,
    settings: deps.settings,
    accessToken: tok.accessToken,
    now: deps.now,
    deadline: lockUntil === undefined ? budget : Math.min(budget, lockUntil - 1000),
  });
}

const fail = (code: string, message: string, status: number) => json({ ok: false, code, message }, status);
const isId = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;

export async function handleTry(request: Request, deps: FreeeDeps): Promise<Response> {
  started.set(deps, deps.now());
  const site = siteCheck(request, { vercelEnv: deps.env.vercelEnv, siteOrigin: deps.settings.siteOrigin, method: "POST" });
  if (site === "off") return fail("off", "ここでは試せません（本番のサイトだけ）", 404);
  if (site === "method") return fail("method", "受けない形です", 405);
  if (site === "origin") return fail("origin", "本番のサイトから来た呼び出しではないので受けません", 403);
  // 大きさ（字）と形
  const raw = await request.text();
  if (raw.length > deps.settings.try.maxRequestChars) return fail("too-big", "送る物が大きすぎます", 413);
  let body: Record<string, unknown>;
  try {
    const b = raw ? JSON.parse(raw) : {};
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error();
    body = b;
  } catch {
    return fail("bad-request", "形がおかしいです", 400);
  }
  const action = body.action;
  if (action !== "read" && action !== "register") return fail("bad-request", "形がおかしいです", 400);
  // 受け取るのは明細の番号と店用か私用かだけ（ほかの欄は読まない）
  const id = body.id;
  const use = body.use;
  if (action === "register" && (!isId(id) || (use !== "shop" && use !== "private"))) return fail("bad-request", "形がおかしいです", 400);

  const c = kvCtxOf(deps);
  if (envProblems(deps.env).length || deps.env.companyId === null) return fail("not-connected", TRY_MESSAGES.notConnected, 200);
  if (!c) return fail("no-store", TRY_MESSAGES.noStore, 503);
  try {
    return await tryUnder(request, deps, c, action, action === "register" ? { id: id as number, use: use as CardUse } : null);
  } catch (e) {
    if (e instanceof StoreDown) return fail("no-store", TRY_MESSAGES.noStore, 503);
    return fail("failed", TRY_MESSAGES.readFailed, 502);
  }
}

async function tryUnder(request: Request, deps: FreeeDeps, c: KvCtx, action: Kind, target: { id: number; use: CardUse } | null): Promise<Response> {
  const date = todayIn(deps.timeZone, deps.now());
  const sender = await senderHash(deps, request, date);
  const under = await countUnder(deps, action, date, sender);
  const access = await kvAccess({ ...c, fetch: deps.fetch, clientId: deps.env.clientId!, clientSecret: deps.env.clientSecret!, companyId: deps.env.companyId! });
  if (!access.ok) return access.why === "busy" ? fail("busy", TRY_MESSAGES.wait, 409) : fail("not-connected", TRY_MESSAGES.notConnected, 200);
  const tok = access.token;
  // 書く前に毎回：鍵の中の事業所の番号が FREEE_COMPANY_ID と同じか（違えば何もしない）
  if (tok.companyId !== deps.env.companyId) return fail("not-connected", TRY_MESSAGES.notConnected, 200);
  const range = readRange(deps);

  // 窓口の頭で：5分をこえた試しを先に元に戻す（回数の上限とは別。上限をこえた呼び出しでも戻す）
  let trial = await loadTrial(c.store);
  let note: RestoreResult | "busy" | null = null;
  if (restoreDue(trial, deps.now(), deps.settings)) {
    const r = await withWriteLock(c, async (until, held) => {
      // 5分をこえたかは、印を取った後に読み直した記録で決め直す（印の外の古い記録で決めない）
      const fresh = await loadTrial(c.store);
      if (!restoreDue(fresh, deps.now(), deps.settings)) return { result: null, trial: fresh };
      return runRestore(deps, c, tok, until, held, range);
    });
    if (r === "expired") return fail("not-connected", TRY_MESSAGES.notConnected, 200);
    if (r === "busy") note = "busy";
    else {
      // 戻した後の記録は、返ってきた物を使う（書いた直後に置き場を読み直さない）
      note = r.result;
      trial = r.trial;
    }
  }
  if (under === "sender") return fail("limit", TRY_MESSAGES.senderLimit, 429);
  if (under === "limit") return fail("limit", TRY_MESSAGES.limit, 429);

  if (action === "read") return tryRead(deps, c, tok, sender, trial, note, range);
  return tryRegister(deps, c, tok, sender, target!, range);
}

async function runRestore(
  deps: FreeeDeps,
  c: KvCtx,
  tok: KvToken,
  until: number,
  held: StillHeld,
  range: { from: string; to: string },
): Promise<{ result: RestoreResult; trial: Trial } | "expired"> {
  // 元に戻すは回数の上限とは別に数える（止めない。数えられなくても戻す）
  try {
    await c.store.incr(FREEE_KV.count("restore", `day:${todayIn(deps.timeZone, deps.now())}`), 2 * 86_400);
  } catch {
    // 数えられなくても戻す
  }
  try {
    return await restoreTrial({ api: apiFor(deps, tok, until), store: c.store, settings: deps.settings, seed: deps.seed, companyId: tok.companyId, range, held });
  } catch (e) {
    if (e instanceof FreeeExpired) {
      await markKvExpired(c, tok.accessToken);
      return "expired";
    }
    throw e;
  }
}

async function tryRead(deps: FreeeDeps, c: KvCtx, tok: KvToken, sender: string, trial: Trial, note: RestoreResult | "busy" | null, range: { from: string; to: string }): Promise<Response> {
  const api = apiFor(deps, tok);
  const max = deps.settings.maxListRows;
  let r;
  try {
    r = await readBoth(api, deps, tok.companyId, range, max);
  } catch (e) {
    if (e instanceof FreeeExpired) {
      await markKvExpired(c, tok.accessToken);
      return fail("not-connected", TRY_MESSAGES.notConnected, 200);
    }
    return fail("read", e instanceof FreeeOutOfTime ? "持ち時間の中で読み終わりませんでした（何も書いていません）" : TRY_MESSAGES.readFailed, 502);
  }
  if (!r.card.ok) return fail("card", "カードの口座が見つかりません（オーナーが直します）", 409);
  const open = openRows(r.read, tok.companyId);
  return json({
    ok: true,
    range,
    rows: open.slice(0, max),
    capped: open.length > max,
    bank: r.bank.ok ? null : r.bank.reason,
    trial: infoOf(deps, trial, sender, r.read, note),
  });
}

type RegisterResult = "registered" | "refused" | "failed" | "unknown";
const answer = (id: number, result: RegisterResult, reason: string, extra: Record<string, unknown> = {}) => json({ ok: true, id, result, reason, ...extra });

async function tryRegister(deps: FreeeDeps, c: KvCtx, tok: KvToken, sender: string, target: { id: number; use: CardUse }, range: { from: string; to: string }): Promise<Response> {
  const r = await withWriteLock(c, async (until, held) => registerUnderLock(deps, c, tok, sender, target, range, until, held));
  if (r === "busy") return fail("busy", TRY_MESSAGES.wait, 409);
  return r;
}

async function registerUnderLock(
  deps: FreeeDeps,
  c: KvCtx,
  tok: KvToken,
  sender: string,
  target: { id: number; use: CardUse },
  range: { from: string; to: string },
  until: number,
  held: StillHeld,
): Promise<Response> {
  const { id, use } = target;
  const s = deps.settings;
  const now = deps.now();
  // 印の中で、もう一度記録を読む（印を取る前に、ほかの呼び出しが書いたかもしれない）。5分をこえたかもこの記録で決める
  let trial = await loadTrial(c.store);
  if (trial.repair) return answer(id, "refused", TRY_MESSAGES.repair);
  // 取引の番号が分からない明細がある（番号を置けなかった など）：その場で要復旧にして断る（5分の間の2件目も）
  if (hasUnknownDeal(trial)) {
    await saveTrial(c.store, s, { ...trial, repair: true });
    return answer(id, "refused", TRY_MESSAGES.repair);
  }
  if (restoreDue(trial, now, s)) {
    const r = await runRestore(deps, c, tok, until, held, range);
    if (r === "expired") return fail("not-connected", TRY_MESSAGES.notConnected, 200);
    if (r.result === "repair") return answer(id, "refused", TRY_MESSAGES.repair);
    if (r.result === "partial") return answer(id, "refused", TRY_MESSAGES.restoring);
    trial = r.trial;
  }
  if (trial.items.length) {
    const left = Math.max(1, minutesLeft(trial, now, s));
    if (trial.by !== sender) return answer(id, "refused", `ほかの人が試しています（あと ${left}分で元に戻ります）`);
    if (trial.items.some((i) => i.id === id)) return answer(id, "refused", `この明細はもう試しました（あと ${left}分たった後に、次にだれかが経理のタブを開いた時に元に戻ります）`);
    if (trial.items.length >= s.try.maxItemsPerTrial) return answer(id, "refused", `1回に試せるのは${s.try.maxItemsPerTrial}件までです（あと ${left}分たった後に、次にだれかが経理のタブを開いた時に元に戻ります）`);
  }

  const api = apiFor(deps, tok, until);
  // 明細の番号から口座を決める（カードと銀行の2つの口座の明細から番号で探す）
  let read: ReadAccount[];
  let found: { account: StatementAccount; txn: WalletTxn } | null = null;
  try {
    const r = await readBoth(api, deps, tok.companyId, range, Number.MAX_SAFE_INTEGER);
    if (!r.card.ok) return answer(id, "failed", "カードの口座が見つかりません（オーナーが直します）");
    read = r.read;
    const hits: { account: StatementAccount; txn: WalletTxn }[] = [];
    for (const x of read) {
      const l = lookupById(x.txns, { companyId: tok.companyId, walletable: x.walletable, id, markPrefix: s.markPrefix });
      if (l.kind === "found") hits.push({ account: x.account, txn: l.txn });
      else if (l.kind !== "missing") return answer(id, "failed", "同じ番号や印の明細が2つ以上あるので、決められません（何も書いていません）");
    }
    if (hits.length !== 1) return answer(id, "failed", "この明細が見つかりません。読み直してください（何も書いていません）");
    found = hits[0];
  } catch (e) {
    if (e instanceof FreeeExpired) {
      await markKvExpired(c, tok.accessToken);
      return fail("not-connected", TRY_MESSAGES.notConnected, 200);
    }
    return answer(id, "failed", e instanceof FreeeOutOfTime ? "持ち時間の中で読み終わりませんでした（何も書いていません）" : TRY_MESSAGES.readFailed);
  }

  // 書けるのは、印のある見本の明細で、見本とちょうど合う出金だけ（印だけで決めない。見本の値はサーバーが持つ物）
  const txn = found.txn;
  if (txn.entry_side !== "expense") return answer(id, "refused", "入金は登録しません（売上の入金は、会計のルールで売上にしています）");
  const mark = markIn(txn.description, s.markPrefix);
  const item = mark ? seedItemOfMark(deps.seed, s.markPrefix, mark) : null;
  if (!item) return answer(id, "refused", "この明細は試せません（試せるのは、アプリが入れた見本の明細だけです）");
  const acc = read.find((x) => x.account === found!.account)!;
  if (accountOf(item) !== found.account || !matchesSeed(deps.seed, s.markPrefix, item, txn, acc.walletable, tok.companyId))
    return answer(id, "refused", "見本の明細と合わないので登録しません（何も書いていません）");

  const p = await prepareOne(
    deps,
    api,
    tok,
    { id, use, account: found.account, date: item.date, amount: item.amount },
    range,
    { txns: acc.txns, fixedErrors: true, extra: (t) => (t.rule_matched === true ? "自動登録のルールで登録された明細には書きません" : null) },
  );
  if (p.kind === "answer") {
    const a = p.answer;
    if (a === "expired") {
      await markKvExpired(c, tok.accessToken);
      return fail("not-connected", TRY_MESSAGES.notConnected, 200);
    }
    if (a.result === "already") return answer(id, "refused", "もう処理済みの明細です（何も書いていません）");
    if (a.result === "check") return answer(id, "refused", "未処理の見本の明細ではないので登録しません（何も書いていません）");
    // 来た人の画面ではサービスの名前を札だけにする（理由の文の名前は言いかえる）
    if (a.result === "failed") return answer(id, "failed", a.reason.replace(/「freee から読み直す」/g, "「読み直す」").replace(/freee/g, "テスト用の事業所"));
    return answer(id, "failed", TRY_MESSAGES.readFailed);
  }

  // 書く前に、置き場に「書くかもしれない明細の番号」を置く（置けなければ書かない）
  trial = {
    ...trial,
    by: trial.items.length ? trial.by : sender,
    items: [...trial.items, { id, account: found.account, no: item.no, use, dealIds: null, deleting: null, step: "writing" }],
    lastWriteAt: deps.now(),
    restoring: false,
  };
  await saveTrial(c.store, s, trial);

  const drop = async () => {
    trial = { ...trial, items: trial.items.filter((i) => i.id !== id) };
    await saveTrial(c.store, s, trial);
  };
  // 書く直前に、印がまだ自分の物か（期限の後に書かない）
  if (!(await held())) {
    await drop();
    return answer(id, "failed", "持ち時間が足りないので送りませんでした（何も書いていません）。もう一度押してください");
  }
  const w = await writeOne(api, tok, use, p.txn, p.line);
  if (w.kind === "registered") {
    trial = { ...trial, items: trial.items.map((i) => (i.id === id ? { ...i, dealIds: w.dealIds, step: "written" as const } : i)), lastWriteAt: deps.now() };
    try {
      await saveTrial(c.store, s, trial);
    } catch {
      // 取引の番号を置けなかった：元に戻す時に番号が分からないので、要復旧になる（消す・作り直すはしない）
    }
    return answer(id, "registered", "テスト用の事業所に登録しました", { trial: infoOf(deps, trial, sender, null, null) });
  }
  if (w.kind === "time") {
    await drop();
    return answer(id, "failed", "持ち時間が足りないので送りませんでした（何も書いていません）。もう一度押してください");
  }
  if (w.kind === "rejected") {
    await drop();
    return answer(id, "failed", "テスト用の事業所が受けませんでした（何も書いていません）");
  }
  if (w.kind === "expired") {
    await drop();
    await markKvExpired(c, tok.accessToken);
    return fail("not-connected", TRY_MESSAGES.notConnected, 200);
  }
  // 結果が分からない：送り直さない。取引の番号が分からないので、要復旧の印を置いて来た人の登録を止める
  trial = { ...trial, repair: true, lastWriteAt: deps.now() };
  try {
    await saveTrial(c.store, s, trial);
  } catch {
    // 置けなくても、記録の取引の番号が null のままなので、元に戻す時に要復旧になる
  }
  return answer(id, "unknown", TRY_MESSAGES.unknown);
}
