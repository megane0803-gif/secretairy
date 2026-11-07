// 来た人がそのまま試せる freee（テスト事業所）の窓口（/api/freee/try）と、サーバーが持ち続けるつながり・数分後に元に戻す。
// Claude も freee も Upstash も呼ばない（fetch を、テストの中だけの freee に、置き場を memoryStore に置きかえる）。

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { accountOf, sideOf } from "../../accounting/rows";
import { getAccounting } from "../../data/seed";
import { memoryStore, type KvStore } from "../../line/store";
import { getFreeeSettings, type FreeeSettings } from "../../settings";
import { exchangeCode, type WalletTxn } from "../api";
import { advanceGen, currentGen, FREEE_KV, kvAccess, putKvToken, readKvToken, writeLockSeconds, type KvCtx } from "../kv";
import { hasMark, markOf } from "../match";
import { cookieKeyFrom, seal, unseal } from "../seal";
import {
  envFrom,
  guard,
  handleCallback,
  handleCheck,
  handleDisconnect,
  handleImport,
  handleRegister,
  handleStart,
  handleStatus,
  STATE_COOKIE,
  TOKEN_COOKIE,
  type FreeeDeps,
} from "../server";
import { handleTry, senderIp, TRY_MESSAGES } from "../try";
import { loadTrial, parseTrial, seedItemOfMark } from "../trial";

const base = getFreeeSettings();
const seed = getAccounting();
const SITE = base.siteOrigin;
const HOST = new URL(SITE).host;
const COMPANY = 7654321;
const KEY_B64 = Buffer.alloc(32, 9).toString("base64");
const KEY = cookieKeyFrom(KEY_B64)!;
const T0 = Date.parse("2026-11-05T03:00:00.000Z");
const CARD_ID = 11;
const BANK_ID = 21;
const OTHER_ID = 31;
const version = seed.statement.version!;
const mark = (no: number) => markOf(base.markPrefix, version, no);
const items = seed.statement.items;
const item = (no: number) => items.find((i) => i.no === no)!;
const merchantName = (id: string) => seed.merchants.find((m) => m.id === id)!.name;
const shopRule = seed.rules.find((r) => r.use === "shop")!;
const privateRule = seed.rules.find((r) => r.use === "private")!;
const SHOP_ITEM = items.find((i) => i.merchantId === shopRule.merchantId && sideOf(i) === "expense")!;
const PRIVATE_ITEM = items.find((i) => i.merchantId === privateRule.merchantId && sideOf(i) === "expense")!;
const INCOME_ITEM = items.find((i) => sideOf(i) === "income")!;

// ---- 時計 ----

const clock = { now: T0 };
const at = (ms: number) => (clock.now = ms);

// ---- テストの中だけの freee ----

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };

class FakeFreee {
  calls: Call[] = [];
  walletables = [
    { id: CARD_ID, name: base.cardName, type: "credit_card" as const },
    { id: BANK_ID, name: base.bankName, type: "bank_account" as const },
    { id: OTHER_ID, name: "ほかの口座", type: "bank_account" as const },
  ];
  txns: WalletTxn[] = [];
  deals = new Map<number, { txnId: number; private: boolean }>();
  nextId = 900;
  nextDeal = 7000;
  /** 取引を消すと明細が未処理に戻るか（本番では分からない） */
  reopenOnDealDelete = true;
  /** プライベート取引を DELETE /api/1/deals/{id} で消せない時の返事 */
  privateDeleteStatus: number | null = null;
  /** 取引に結び付いた明細を消せない */
  linkedTxnDeleteStatus: number | null = null;
  /** 明細を作ると、自動登録のルールで登録される */
  autoRuleOnCreate = false;
  /** この道で返事を途切れさせる（送った後） */
  dropOn: "create_deal" | "create_private_deal" | "delete_deal" | "delete_txn" | null = null;
  /** 明細を作る前に返事を途切れさせる（作らない） */
  createTxnDropBefore = false;
  /** create_deal の返事を deal_ids: [] にする */
  emptyDealIds = false;
  /** 書く呼び出しの前に（同時に動く物を差しこむ） */
  beforeWrite: ((path: string) => Promise<void>) | null = null;
  /** 鍵 */
  access = "acc-1";
  refresh = "ref-1";
  issued = 1;
  tokenCompany: number | null = COMPANY;
  /** 更新の返事の前に（つなぎを外す・遅らせる） */
  beforeRefreshAnswer: (() => Promise<void>) | null = null;
  refuseRefresh = false;
  /** freee を呼ぶたびに時計を進める（ms） */
  tick = 0;

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    clock.now += this.tick;
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const isToken = url.pathname === "/public_api/token";
    const body = typeof init?.body === "string" && init.body ? (isToken ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body)) : null;
    this.calls.push({ method, path: url.pathname, query: url.searchParams, body });
    const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    const none = () => new Response(null, { status: 204 });
    if (isToken) {
      const b = body as Record<string, string>;
      if (b.grant_type === "refresh_token") {
        if (this.refuseRefresh || b.refresh_token !== this.refresh) return ok({ error: "invalid_grant" }, 400);
        this.issued++;
        this.access = `acc-${this.issued}`;
        this.refresh = `ref-${this.issued}`;
        if (this.beforeRefreshAnswer) await this.beforeRefreshAnswer();
      }
      return ok({ access_token: this.access, token_type: "bearer", expires_in: 21600, refresh_token: this.refresh, company_id: this.tokenCompany });
    }
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (auth !== `Bearer ${this.access}`) return ok({ message: "unauthorized" }, 401);
    if (url.pathname === "/api/1/walletables") return ok({ walletables: this.walletables });
    if (url.pathname === "/api/1/account_items") return ok({ account_items: [{ id: 501, name: base.accountItemName, available: true }] });
    if (url.pathname === `/api/1/taxes/companies/${COMPANY}`) return ok({ taxes: [{ code: 136, name: "x", name_ja: base.taxName, available: true }] });
    if (url.pathname === "/api/1/wallet_txns" && method === "GET") {
      const wid = Number(url.searchParams.get("walletable_id"));
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      return ok({ wallet_txns: this.txns.filter((t) => t.walletable_id === wid).slice(offset, offset + limit) });
    }
    if (method !== "GET" && this.beforeWrite) await this.beforeWrite(url.pathname);
    if (url.pathname === "/api/1/wallet_txns" && method === "POST") {
      if (this.createTxnDropBefore) throw new TypeError("network");
      const b = body as Record<string, unknown>;
      const t: WalletTxn = {
        id: this.nextId++,
        company_id: b.company_id as number,
        date: b.date as string,
        amount: b.amount as number,
        due_amount: this.autoRuleOnCreate ? 0 : (b.amount as number),
        entry_side: b.entry_side as "expense" | "income",
        walletable_type: b.walletable_type as "credit_card" | "bank_account",
        walletable_id: b.walletable_id as number,
        description: b.description as string,
        status: this.autoRuleOnCreate ? 2 : 1,
        rule_matched: this.autoRuleOnCreate,
      };
      this.txns.push(t);
      return ok({ wallet_txn: t }, 201);
    }
    const cd = url.pathname.match(/^\/api\/1\/wallet_txns\/(\d+)\/(create_deal|create_private_deal)$/);
    if (cd && method === "POST") {
      const t = this.txns.find((x) => x.id === Number(cd[1]));
      if (!t) return ok({ message: "x" }, 404);
      t.status = 2;
      t.due_amount = 0;
      const id = this.nextDeal++;
      this.deals.set(id, { txnId: t.id, private: cd[2] === "create_private_deal" });
      if (this.dropOn === cd[2]) throw new TypeError("network");
      return cd[2] === "create_deal" ? ok({ deal_ids: this.emptyDealIds ? [] : [id] }) : ok({ deal_id: id });
    }
    const dd = url.pathname.match(/^\/api\/1\/deals\/(\d+)$/);
    if (dd && method === "DELETE") {
      assert.equal(url.searchParams.get("company_id"), String(COMPANY), "事業所の番号を付ける");
      const d = this.deals.get(Number(dd[1]));
      if (!d) return ok({ message: "x" }, 404);
      if (d.private && this.privateDeleteStatus) return ok({ message: "x" }, this.privateDeleteStatus);
      this.deals.delete(Number(dd[1]));
      const t = this.txns.find((x) => x.id === d.txnId);
      if (t && this.reopenOnDealDelete) {
        t.status = 1;
        t.due_amount = t.amount;
      }
      if (this.dropOn === "delete_deal") throw new TypeError("network");
      return none();
    }
    const dt = url.pathname.match(/^\/api\/1\/wallet_txns\/(\d+)$/);
    if (dt && method === "DELETE") {
      assert.equal(url.searchParams.get("company_id"), String(COMPANY));
      const i = this.txns.findIndex((x) => x.id === Number(dt[1]));
      if (i < 0) return ok({ message: "x" }, 404);
      if (this.linkedTxnDeleteStatus && [...this.deals.values()].some((d) => d.txnId === this.txns[i].id)) return ok({ message: "x" }, this.linkedTxnDeleteStatus);
      this.txns.splice(i, 1);
      if (this.dropOn === "delete_txn") throw new TypeError("network");
      return none();
    }
    return ok({ status_code: 404 }, 404);
  };

  /** 見本の明細を「明細を入れる」と同じ中身で入れる */
  addSeed(no: number, patch: Partial<WalletTxn> = {}): WalletTxn {
    const i = item(no);
    const bank = accountOf(i) === "bank";
    const t: WalletTxn = {
      id: this.nextId++,
      company_id: COMPANY,
      date: i.date,
      amount: i.amount,
      due_amount: i.amount,
      entry_side: sideOf(i),
      walletable_type: bank ? "bank_account" : "credit_card",
      walletable_id: bank ? BANK_ID : CARD_ID,
      description: `${merchantName(i.merchantId)} ${mark(no)}`,
      status: 1,
      rule_matched: false,
      ...patch,
    };
    this.txns.push(t);
    return t;
  }

  addAllSeed() {
    for (const i of items) this.addSeed(i.no);
  }

  txnOf(no: number): WalletTxn | undefined {
    return this.txns.find((x) => hasMark(x.description, mark(no)));
  }

  writes(): Call[] {
    return this.calls.filter((c) => c.method !== "GET" && c.path !== "/public_api/token");
  }
  tokenCalls(kind: string): number {
    return this.calls.filter((c) => c.path === "/public_api/token" && (c.body as Record<string, string>).grant_type === kind).length;
  }
}

// ---- 道具立て ----

let n = 0;
function makeDeps(freee: FakeFreee, store: KvStore | null, settings: FreeeSettings = base, env: Partial<Record<string, string>> = {}): FreeeDeps {
  return {
    env: envFrom({ VERCEL_ENV: "production", FREEE_CLIENT_ID: "cid", FREEE_CLIENT_SECRET: "csecret", FREEE_COMPANY_ID: String(COMPANY), ...env }, KEY),
    settings,
    seed,
    fetch: (input, init) => freee.fetch(input, init),
    now: () => clock.now,
    random: (len) => Buffer.alloc(len, ++n % 250),
    timeZone: "Asia/Tokyo",
    store,
  };
}

const ctxOf = (store: KvStore, settings = base): KvCtx => ({ store, cookieKey: KEY, settings, now: () => clock.now, random: (len) => Buffer.alloc(len, ++n % 250) });

/** オーナーが1回つないだ後（置き場に鍵がある） */
async function connected(freee: FakeFreee, store: KvStore, p: { expiresAt?: number; companyId?: number } = {}) {
  const ok = await putKvToken(ctxOf(store), { accessToken: freee.access, refreshToken: freee.refresh, companyId: p.companyId ?? COMPANY, expiresAt: p.expiresAt ?? clock.now + 3 * 3600_000 });
  assert.ok(ok);
}

function tryReq(body: unknown, p: { ip?: string; origin?: string | null; method?: string; raw?: string } = {}): Request {
  const method = p.method ?? "POST";
  const h = new Headers({ host: HOST, "x-real-ip": p.ip ?? "203.0.113.7", "content-type": "application/json" });
  if (p.origin !== null && method === "POST") h.set("origin", p.origin ?? SITE);
  return new Request(`${SITE}/api/freee/try`, { method, headers: h, body: method === "POST" ? (p.raw ?? JSON.stringify(body)) : undefined });
}

function ownerReq(path: string, p: { cookie?: string | null; body?: unknown; method?: string } = {}): Request {
  const method = p.method ?? "POST";
  const h = new Headers({ host: HOST });
  if (method === "POST") h.set("origin", SITE);
  if (p.cookie) h.set("cookie", p.cookie);
  if (p.body !== undefined) h.set("content-type", "application/json");
  return new Request(`${SITE}${path}`, { method, headers: h, body: p.body !== undefined ? JSON.stringify(p.body) : undefined });
}

function ownerCookie(accessToken: string): string {
  return `${TOKEN_COOKIE}=${seal(KEY, "token", { accessToken, companyId: COMPANY, expiresAt: clock.now + 3600_000 })}`;
}

const bodyOf = async (r: Response) => (await r.json()) as Record<string, any>;
const read = (deps: FreeeDeps, ip?: string) => handleTry(tryReq({ action: "read" }, { ip }), deps);
const reg = (deps: FreeeDeps, id: number, use: "shop" | "private", ip?: string, extra: Record<string, unknown> = {}) => handleTry(tryReq({ action: "register", id, use, ...extra }, { ip }), deps);
const holdMs = base.try.holdSeconds * 1000;

// ログに鍵・IP が出ないかを見る
let logs: string[] = [];
const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
beforeEach(() => {
  at(T0);
  logs = [];
  for (const k of ["log", "warn", "error", "info"] as const) console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
});
afterEach(() => {
  Object.assign(console, orig);
});

// ---- 1. サーバーがつながりを持ち続ける ----

describe("freee：サーバーがつながりを持ち続ける（置き場の鍵）", () => {
  test("refresh_token を形を確かめて読む（無い・空なら null）", async () => {
    const f = new FakeFreee();
    const a = await exchangeCode({ fetch: f.fetch, settings: base, clientId: "c", clientSecret: "s", code: "x", codeVerifier: "v", redirectUri: "r" });
    assert.equal(a.refreshToken, "ref-1");
    const g = new FakeFreee();
    g.refresh = "";
    const b = await exchangeCode({ fetch: g.fetch, settings: base, clientId: "c", clientSecret: "s", code: "x", codeVerifier: "v", redirectUri: "r" });
    assert.equal(b.refreshToken, null);
  });

  test("つなぐと、置き場に新しい用途（kv-token）の暗号で置く。cookie には更新の鍵を入れない。入れ替えても読めない。生の鍵は返事とログに出ない", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    const deps = makeDeps(f, store);
    const start = await handleStart(ownerReq("/api/freee/start"), deps);
    const loc = new URL(start.headers.get("location")!);
    const sc = start.headers.getSetCookie().find((c) => c.startsWith(STATE_COOKIE))!.split(";")[0];
    const q = new URLSearchParams({ code: "the-code", state: loc.searchParams.get("state")! });
    const cb = await handleCallback(ownerReq(`/api/freee/callback?${q}`, { method: "GET", cookie: sc }), deps);
    assert.equal(cb.headers.get("location"), "/accounting?freee=connected#freee");
    const raw = await store.get(FREEE_KV.token);
    assert.ok(raw);
    assert.ok(!raw!.includes("acc-1") && !raw!.includes("ref-1"), "置き場にも平文では置かない");
    const kvPayload = unseal(KEY, "kv-token", raw) as Record<string, unknown>;
    assert.deepEqual(Object.keys(kvPayload).sort(), ["accessToken", "companyId", "expiresAt", "gen", "refreshToken"]);
    assert.equal(kvPayload.companyId, COMPANY);
    assert.equal(unseal(KEY, "token", raw), null, "KV の中身は cookie の用途では読めない");
    const tc = cb.headers.getSetCookie().find((c) => c.startsWith(`${TOKEN_COOKIE}=`) && !/Max-Age=0/.test(c))!;
    const cookieVal = tc.split(";")[0].slice(TOKEN_COOKIE.length + 1);
    assert.deepEqual(Object.keys(unseal(KEY, "token", cookieVal) as object).sort(), ["accessToken", "companyId", "expiresAt"], "cookie には更新の鍵を入れない");
    assert.equal(unseal(KEY, "kv-token", cookieVal), null, "cookie の中身は KV の用途では読めない");
    // KV の中身を cookie に入れても、オーナーの窓口は通らない
    const swapped = guard(ownerReq("/api/freee/check", { cookie: `${TOKEN_COOKIE}=${raw}` }), deps, { method: "POST", session: true });
    assert.equal(swapped.ok, false);
    if (!swapped.ok) assert.equal(swapped.response.status, 401);
    // cookie の中身を KV に入れても、来た人の窓口は使えない
    await store.set(FREEE_KV.token, cookieVal, { ex: 600 });
    f.addAllSeed();
    const r = await read(deps);
    assert.equal((await bodyOf(r)).code, "not-connected");
    // 返事とログに生の鍵が出ない
    await connected(f, store);
    const ok = await read(deps);
    const text = await ok.text();
    for (const s of ["acc-1", "ref-1", "csecret", String(COMPANY)]) {
      assert.ok(!text.includes(s), `返事に ${s} が出ない`);
      assert.ok(!logs.join("\n").includes(s), `ログに ${s} が出ない`);
    }
  });

  test("更新用の鍵が返ってこない時は、今どおり cookie だけでつなぐ（置き場には置かない・来た人は試せない）", async () => {
    const f = new FakeFreee();
    f.refresh = "";
    const store = memoryStore(() => clock.now);
    const deps = makeDeps(f, store);
    const start = await handleStart(ownerReq("/api/freee/start"), deps);
    const loc = new URL(start.headers.get("location")!);
    const sc = start.headers.getSetCookie().find((c) => c.startsWith(STATE_COOKIE))!.split(";")[0];
    const q = new URLSearchParams({ code: "c", state: loc.searchParams.get("state")! });
    const cb = await handleCallback(ownerReq(`/api/freee/callback?${q}`, { method: "GET", cookie: sc }), deps);
    assert.equal(cb.headers.get("location"), "/accounting?freee=connected-cookie#freee");
    assert.ok(cb.headers.getSetCookie().some((c) => c.startsWith(`${TOKEN_COOKIE}=`) && !/Max-Age=0/.test(c)), "cookie には入れる");
    assert.equal(await store.get(FREEE_KV.token), null);
    assert.equal((await bodyOf(await read(deps))).code, "not-connected");
  });

  test("事業所の番号が FREEE_COMPANY_ID と違う時は置かない・置いてあっても使わない", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await putKvToken(ctxOf(store), { accessToken: f.access, refreshToken: f.refresh, companyId: 999, expiresAt: clock.now + 3600_000 });
    f.addAllSeed();
    const r = await reg(makeDeps(f, store), f.txnOf(SHOP_ITEM.no)!.id, "shop");
    assert.equal((await bodyOf(r)).message, TRY_MESSAGES.notConnected);
    assert.equal(f.writes().length, 0);
  });

  test("切れていたら更新用の鍵で延ばす（同時に1回だけ）。延ばしている最中の呼び出しは「少し待ってから」", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store, { expiresAt: clock.now + 10_000 }); // 期限の少し前（延ばす）
    f.addAllSeed();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    f.beforeRefreshAnswer = () => gate;
    const deps = makeDeps(f, store);
    const first = read(deps, "198.51.100.1");
    await new Promise((r) => setTimeout(r, 20));
    at(clock.now + 20_000); // 古い鍵は切れた（延ばす印はまだある）
    const second = await read(makeDeps(f, store), "198.51.100.2");
    assert.equal(second.status, 409);
    assert.equal((await bodyOf(second)).message, TRY_MESSAGES.wait);
    release();
    assert.equal((await first).status, 200);
    assert.equal(f.tokenCalls("refresh_token"), 1, "延ばすのは1回だけ");
    const now = await readKvToken(ctxOf(store));
    assert.equal(now!.token.refreshToken, "ref-2", "新しい更新用の鍵を置いた");
    assert.equal(await store.get(FREEE_KV.refreshLock), null, "自分の印は消す");
    // 次は延ばさずに使える
    assert.equal((await read(makeDeps(f, store), "198.51.100.3")).status, 200);
    assert.equal(f.tokenCalls("refresh_token"), 1);
  });

  test("延ばせなかった時は「いまは経理につながっていません（オーナーがつなぎ直します）」だけ。自分でつなぎ直さない", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store, { expiresAt: clock.now - 1 });
    f.refuseRefresh = true;
    const r = await read(makeDeps(f, store));
    const b = await bodyOf(r);
    assert.equal(b.message, TRY_MESSAGES.notConnected);
    assert.equal(b.message, "いまは経理につながっていません（オーナーがつなぎ直します）");
    assert.ok(await store.get(FREEE_KV.token), "消さない（ほかの呼び出しが延ばして置いた新しい鍵を、古い写しを読んだこちらが消さないため）");
    assert.equal(f.tokenCalls("authorization_code"), 0);
  });

  test("延ばせたのに置き場に書けない時は、つながっていない扱い（古い更新用の鍵はもう使えない）", async () => {
    const f = new FakeFreee();
    const mem = memoryStore(() => clock.now);
    await connected(f, mem, { expiresAt: clock.now - 1 });
    const store: KvStore = { ...mem, set: async (k, v, o) => (k === FREEE_KV.token ? Promise.reject(new Error("down")) : mem.set(k, v, o)) };
    const r = await read(makeDeps(f, store));
    assert.equal((await bodyOf(r)).message, TRY_MESSAGES.notConnected);
    assert.equal(f.tokenCalls("refresh_token"), 1);
    assert.equal(await mem.get(FREEE_KV.token), null);
  });

  test("延ばしている途中でつなぎを外されたら、延ばした鍵を置き場に書かない（番号が変わっていたら捨てる）", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store, { expiresAt: clock.now - 1 });
    const c = ctxOf(store);
    f.beforeRefreshAnswer = async () => {
      // オーナーが「つなぎを外す」を押した（番号を進めて鍵を消す）
      await advanceGen(c);
      await store.del(FREEE_KV.token);
    };
    const a = await kvAccess({ ...c, fetch: f.fetch, clientId: "cid", clientSecret: "csecret", companyId: COMPANY });
    assert.equal(a.ok, false);
    assert.equal(await store.get(FREEE_KV.token), null, "延ばした鍵は書かない");
  });

  test("今の窓口（import・register・check・disconnect）は、置き場に鍵があっても cookie が無ければ 401 のまま", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    const deps = makeDeps(f, store);
    const t = f.txnOf(SHOP_ITEM.no)!;
    for (const [h, path, body] of [
      [handleImport, "/api/freee/import", undefined],
      [handleRegister, "/api/freee/register", { id: t.id, use: "shop", account: "card", date: t.date, amount: t.amount }],
      [handleCheck, "/api/freee/check", { ids: [] }],
      [handleDisconnect, "/api/freee/disconnect", undefined],
    ] as const) {
      const r = await h(ownerReq(path, { body }), deps);
      assert.equal(r.status, 401, path);
    }
    assert.equal(f.writes().length, 0);
    assert.ok(await store.get(FREEE_KV.token), "来た人は「つなぎを外す」をできない");
    const st = await handleStatus(ownerReq("/api/freee/status", { method: "GET" }), deps);
    assert.equal(st.status, 401);
  });
});

// ---- 2. 来た人が試せる ----

describe("freee：来た人の窓口（読む・登録する・読み直す）", () => {
  test("守り：本番のサイトだけ・GET は 405・Origin が違えば 403・大きさ・形", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    const deps = makeDeps(f, store);
    assert.equal((await handleTry(tryReq(null, { method: "GET" }), deps)).status, 405);
    assert.equal((await handleTry(tryReq({ action: "read" }, { origin: "https://evil.example" }), deps)).status, 403);
    assert.equal((await handleTry(tryReq({ action: "read" }, { origin: null }), deps)).status, 403);
    assert.equal((await handleTry(tryReq({ action: "read" }), makeDeps(f, store, base, { VERCEL_ENV: "preview" }))).status, 404);
    assert.equal((await handleTry(tryReq(null, { raw: JSON.stringify({ action: "read", x: "a".repeat(base.try.maxRequestChars) }) }), deps)).status, 413);
    assert.equal((await handleTry(tryReq({ action: "import" }), deps)).status, 400, "明細を入れるはできない");
    assert.equal((await handleTry(tryReq({ action: "disconnect" }), deps)).status, 400, "つなぎを外すはできない");
    assert.equal((await handleTry(tryReq({ action: "register", id: [1, 2], use: "shop" }), deps)).status, 400, "1回に1件");
    assert.equal(f.calls.length, 0);
  });

  test("読む：今の読み込みと同じ形の、まだ処理していない明細（カードと銀行）と、試しの様子", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    const r = await read(makeDeps(f, store));
    assert.equal(r.status, 200);
    const b = await bodyOf(r);
    assert.equal(b.rows.length, items.length);
    assert.deepEqual(Object.keys(b.rows[0]).sort(), ["account", "amount", "date", "description", "id", "side"]);
    assert.equal(b.trial.phase, "free");
    assert.equal(b.trial.holdMinutes, 5);
    assert.equal(f.writes().length, 0, "読むだけでは書かない");
  });

  test("登録：受け取るのは明細の番号と店用か私用かだけ。金額・科目・口座・事業所・日付を付けて送っても使わない", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    const t = f.txnOf(SHOP_ITEM.no)!;
    const r = await reg(makeDeps(f, store), t.id, "shop", undefined, { amount: 1, account: "bank", company_id: 1, account_item_id: 999, tax_code: 1, date: "2026-01-01", description: "x" });
    const b = await bodyOf(r);
    assert.equal(b.result, "registered", JSON.stringify(b));
    const w = f.writes();
    assert.equal(w.length, 1);
    assert.equal(w[0].path, `/api/1/wallet_txns/${t.id}/create_deal`);
    const body = w[0].body as { company_id: number; deal_lines: { amount: number; account_item_id: number; tax_code: number }[] };
    assert.equal(body.company_id, COMPANY);
    assert.deepEqual(body.deal_lines, [{ amount: t.amount, account_item_id: 501, tax_code: 136 }]);
    // 書く前に「書くかもしれない明細」を、書いた後に取引の番号を置いた
    const trial = await loadTrial(store);
    assert.equal(trial.items.length, 1);
    assert.equal(trial.items[0].id, t.id);
    assert.equal(trial.items[0].dealIds!.length, 1);
    assert.equal(trial.lastWriteAt, clock.now);
    assert.ok(!JSON.stringify(b).includes(String(trial.items[0].dealIds![0])), "取引の番号は返さない");
  });

  test("私用は create_private_deal。読み直しで「登録した」が見える", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    const t = f.txnOf(PRIVATE_ITEM.no)!;
    const deps = makeDeps(f, store);
    assert.equal((await bodyOf(await reg(deps, t.id, "private"))).result, "registered");
    assert.equal(f.writes()[0].path, `/api/1/wallet_txns/${t.id}/create_private_deal`);
    const b = await bodyOf(await read(deps));
    assert.equal(b.trial.phase, "holding");
    assert.equal(b.trial.mine, true);
    assert.deepEqual(b.trial.items, [{ id: t.id, use: "private", state: "registered" }]);
    assert.ok(!b.rows.some((x: { id: number }) => x.id === t.id), "処理済みになったので未処理の一覧から消えた");
  });

  test("書かない：事業所が違う明細・口座が違う・印が無い・入金・処理済み・見本と値が合わない・手で変えた摘要・購入先のルールと合わない", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    const otherCompany = f.addSeed(SHOP_ITEM.no, { company_id: 999 });
    const otherAccount = f.addSeed(SHOP_ITEM.no, { walletable_id: OTHER_ID, walletable_type: "bank_account" });
    const noMark = f.addSeed(SHOP_ITEM.no, { description: merchantName(SHOP_ITEM.merchantId) });
    const income = f.addSeed(INCOME_ITEM.no);
    const done = f.addSeed(PRIVATE_ITEM.no, { status: 2, due_amount: 0 });
    const other = items.find((i) => sideOf(i) === "expense" && i.no !== SHOP_ITEM.no && i.no !== PRIVATE_ITEM.no && accountOf(i) === "card")!;
    const amount = f.addSeed(other.no, { amount: other.amount + 1, due_amount: other.amount + 1 });
    const another = items.find((i) => sideOf(i) === "expense" && ![SHOP_ITEM.no, PRIVATE_ITEM.no, other.no].includes(i.no) && accountOf(i) === "card")!;
    const desc = f.addSeed(another.no, { description: `手で変えた ${mark(another.no)}` });
    const deps = makeDeps(f, store);
    for (const t of [otherCompany, otherAccount, noMark, income, done, amount, desc]) {
      const b = await bodyOf(await reg(deps, t.id, t.entry_side === "expense" ? "shop" : "shop"));
      assert.notEqual(b.result, "registered", `${t.id}：${JSON.stringify(b)}`);
    }
    assert.equal(f.writes().length, 0, "どれも書かない");
    assert.equal((await loadTrial(store)).items.length, 0);
  });

  test("見本どおりでも、購入先の自動のルールと逆の選びは書かない（useAllowed は今どおり）", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    const deps = makeDeps(f, store);
    const r = await bodyOf(await reg(deps, f.txnOf(SHOP_ITEM.no)!.id, "private"));
    assert.equal(r.result, "failed");
    assert.equal(r.reason, "店用・私用の選びが、購入先の自動のルールと合いません");
    assert.equal(f.writes().length, 0);
    assert.equal((await loadTrial(store)).items.length, 0);
  });

  test("印から見本を引く：版が違う・番号の見本が無い・形が違う印は引かない", () => {
    assert.equal(seedItemOfMark(seed, base.markPrefix, mark(1))?.no, 1);
    assert.equal(seedItemOfMark(seed, base.markPrefix, markOf(base.markPrefix, "v0", 1)), null);
    assert.equal(seedItemOfMark(seed, base.markPrefix, markOf(base.markPrefix, version, 9999)), null);
    assert.equal(seedItemOfMark(seed, base.markPrefix, `${base.markPrefix}:${version}:01`), null);
    assert.equal(seedItemOfMark(seed, base.markPrefix, `Other:${version}:1`), null);
  });

  test("結果が分からない時は送り直さず、要復旧の印を置いて来た人の登録を止める", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    f.dropOn = "create_deal";
    const deps = makeDeps(f, store);
    const t = f.txnOf(SHOP_ITEM.no)!;
    const b = await bodyOf(await reg(deps, t.id, "shop"));
    assert.equal(b.result, "unknown");
    assert.equal(b.reason, TRY_MESSAGES.unknown);
    const trial = await loadTrial(store);
    assert.equal(trial.repair, true);
    assert.equal(trial.items[0].dealIds, null, "取引の番号は分からないまま");
    f.dropOn = null;
    const again = await bodyOf(await reg(deps, f.txnOf(PRIVATE_ITEM.no)!.id, "private"));
    assert.equal(again.reason, TRY_MESSAGES.repair);
    assert.equal(f.writes().length, 1, "送り直さない");
    // 5分の後も、消す・作り直すはしない（要復旧で止まる）
    at(clock.now + holdMs + 1000);
    const rd = await bodyOf(await read(deps));
    assert.equal(rd.trial.phase, "repair");
    assert.equal(f.writes().length, 1, "取引を消す・明細を消す・作り直すのどれもしない");
  });

  test("登録できたのに取引の番号を置き場に書けなかった時も、元に戻す時に作り直さずに要復旧で止まる", async () => {
    const f = new FakeFreee();
    const mem = memoryStore(() => clock.now);
    await connected(f, mem);
    f.addAllSeed();
    let trialWrites = 0;
    const store: KvStore = {
      ...mem,
      set: async (k, v, o) => {
        if (k === FREEE_KV.trial && ++trialWrites === 2) throw new Error("down");
        return mem.set(k, v, o);
      },
    };
    const deps = makeDeps(f, store);
    assert.equal((await bodyOf(await reg(deps, f.txnOf(SHOP_ITEM.no)!.id, "shop"))).result, "registered");
    assert.equal((await loadTrial(mem)).items[0].dealIds, null);
    at(clock.now + holdMs + 1000);
    const rd = await bodyOf(await read(makeDeps(f, mem)));
    assert.equal(rd.trial.phase, "repair");
    assert.equal(f.writes().length, 1, "消す・作り直すはしない");
    assert.equal((await loadTrial(mem)).repair, true);
  });
});

// ---- 3. 上限 ----

describe("freee：来た人の窓口の上限", () => {
  test("設定の数：登録は1日100・1分6・同じ送り元から1日10、読むは1日600・1分30・同じ送り元から1日100。5分で元に戻す", () => {
    assert.deepEqual(base.try.register, { daily: 100, perMinute: 6, perSenderDaily: 10 });
    assert.deepEqual(base.try.read, { daily: 600, perMinute: 30, perSenderDaily: 100 });
    assert.equal(base.try.holdSeconds, 300);
    assert.ok(base.try.lockSeconds > base.serverBudgetSeconds, "印の期限は持ち時間より長い");
  });

  test("登録：1分（全体）・同じ送り元から1日・1日（全体）。先に足してから比べる", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    const id = f.txnOf(INCOME_ITEM.no)!.id; // 入金（書かない）で数だけ見る
    let deps = makeDeps(f, store);
    for (let i = 0; i < 6; i++) assert.notEqual((await reg(deps, id, "shop", `10.0.0.${i}`)).status, 429);
    assert.equal((await reg(deps, id, "shop", "10.0.0.99")).status, 429, "1分に6回まで（全体）");
    // 同じ送り元から1日10回
    const s2 = memoryStore(() => clock.now);
    await connected(f, s2);
    deps = makeDeps(f, s2);
    for (let i = 0; i < 10; i++) {
      at(T0 + i * 61_000);
      assert.notEqual((await reg(deps, id, "shop", "10.1.1.1")).status, 429, `${i}`);
    }
    at(T0 + 11 * 61_000);
    const over = await reg(deps, id, "shop", "10.1.1.1");
    assert.equal(over.status, 429);
    assert.equal((await bodyOf(over)).message, TRY_MESSAGES.senderLimit);
    assert.notEqual((await reg(deps, id, "shop", "10.1.1.2")).status, 429, "ほかの送り元は数えない");
    // 1日（全体）100回
    const s3 = memoryStore(() => clock.now);
    await connected(f, s3);
    deps = makeDeps(f, s3);
    for (let i = 0; i < 100; i++) {
      at(T0 + Math.floor(i / 6) * 61_000);
      assert.notEqual((await reg(deps, id, "shop", `10.2.${Math.floor(i / 10)}.${i % 10}`)).status, 429, `${i}`);
    }
    at(T0 + 20 * 61_000);
    assert.equal((await reg(deps, id, "shop", "10.3.3.3")).status, 429, "1日に100回まで（全体）");
    assert.equal(f.writes().length, 0);
  });

  test("読む・読み直す：1分30（全体）・同じ送り元から1日100・1日600（全体）。登録とは別に数える", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    let deps = makeDeps(f, store);
    for (let i = 0; i < 30; i++) assert.equal((await read(deps, `10.9.0.${i}`)).status, 200);
    assert.equal((await read(deps, "10.9.1.1")).status, 429);
    assert.notEqual((await reg(deps, 1, "shop", "10.9.1.1")).status, 429, "登録の数とは別");
    const s2 = memoryStore(() => clock.now);
    await connected(f, s2);
    deps = makeDeps(f, s2);
    for (let i = 0; i < 100; i++) {
      at(T0 + Math.floor(i / 30) * 61_000);
      assert.equal((await read(deps, "10.8.8.8")).status, 200, `${i}`);
    }
    at(T0 + 5 * 61_000);
    assert.equal((await read(deps, "10.8.8.8")).status, 429);
    const s3 = memoryStore(() => clock.now);
    await connected(f, s3);
    deps = makeDeps(f, s3);
    for (let i = 0; i < 600; i++) {
      at(T0 + Math.floor(i / 30) * 61_000);
      assert.equal((await read(deps, `10.${Math.floor(i / 100)}.${i % 100}.1`)).status, 200, `${i}`);
    }
    at(T0 + 21 * 61_000);
    assert.equal((await read(deps, "10.200.0.1")).status, 429);
  });

  test("生の IP は置き場にも返事にも残らない（日ごとの塩と合わせたハッシュで数える）", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    const ip = "192.0.2.123";
    const r = await read(makeDeps(f, store), ip);
    const text = await r.text();
    assert.ok(!text.includes(ip));
    for (const k of store.keys()) {
      assert.ok(!k.includes(ip), k);
      assert.ok(!((await store.get(k)) ?? "").includes(ip), k);
    }
    assert.ok(!logs.join("\n").includes(ip));
    assert.equal(senderIp(new Request(SITE, { headers: { "x-vercel-forwarded-for": "198.51.100.9, 10.0.0.1" } })), "198.51.100.9");
  });

  test("置き場が使えない時は受けない（503）", async () => {
    const f = new FakeFreee();
    const down: KvStore = {
      get: async () => Promise.reject(new Error("down")),
      set: async () => Promise.reject(new Error("down")),
      del: async () => Promise.reject(new Error("down")),
      getdel: async () => Promise.reject(new Error("down")),
      incr: async () => Promise.reject(new Error("down")),
      rpush: async () => Promise.reject(new Error("down")),
      lpop: async () => Promise.reject(new Error("down")),
      expire: async () => Promise.reject(new Error("down")),
    };
    assert.equal((await read(makeDeps(f, down))).status, 503);
    assert.equal((await reg(makeDeps(f, down), 1, "shop")).status, 503);
    assert.equal((await read(makeDeps(f, null))).status, 503);
    assert.equal(f.calls.length, 0);
  });

  test("元に戻すは上限で止まらない（来た人が使い切っても、窓口の頭で元に戻す）", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    const deps = makeDeps(f, store);
    const t = f.txnOf(SHOP_ITEM.no)!;
    assert.equal((await bodyOf(await reg(deps, t.id, "shop", "10.5.5.5"))).result, "registered");
    // 読むの1日の上限を使い切った
    const date = "2026-11-05";
    await store.set(FREEE_KV.count("read", `day:${date}`), String(base.try.read.daily), { ex: 600 });
    at(clock.now + holdMs + 1000);
    const r = await read(deps, "10.6.6.6");
    assert.equal(r.status, 429);
    assert.equal((await loadTrial(store)).items.length, 0, "元に戻した");
    assert.equal(f.deals.size, 0);
    assert.equal(f.txnOf(SHOP_ITEM.no)!.status, 1);
  });
});

// ---- 4. 5分の間・5分の後 ----

describe("freee：試した物を数分後に元の形に戻す", () => {
  test("5分の間は、ほかの人は登録できず読める。同じ人は決めた件数まで。5分後の最初の呼び出しで元に戻ってから続く", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    const deps = makeDeps(f, store);
    const a = f.txnOf(SHOP_ITEM.no)!;
    const p = f.txnOf(PRIVATE_ITEM.no)!;
    assert.equal((await bodyOf(await reg(deps, a.id, "shop", "10.0.0.1"))).result, "registered");
    at(clock.now + 60_000);
    const other = await bodyOf(await reg(deps, p.id, "private", "10.0.0.2"));
    assert.equal(other.result, "refused");
    assert.equal(other.reason, "ほかの人が試しています（あと 4分で元に戻ります）");
    const rd = await bodyOf(await read(deps, "10.0.0.2"));
    assert.equal(rd.trial.phase, "holding");
    assert.equal(rd.trial.mine, false);
    assert.equal(rd.trial.minutes, 4);
    // 同じ人の2件目は登録できる（決めた件数まで）
    assert.equal((await bodyOf(await reg(deps, p.id, "private", "10.0.0.1"))).result, "registered");
    const third = items.find((i) => sideOf(i) === "expense" && i.no !== SHOP_ITEM.no && i.no !== PRIVATE_ITEM.no && !seed.rules.some((r) => r.merchantId === i.merchantId))!;
    assert.equal((await bodyOf(await reg(deps, f.txnOf(third.no)!.id, "shop", "10.0.0.1"))).result, "refused");
    assert.equal(f.deals.size, 2);
    // 5分（最後に書いた時から）をこえた後の最初の呼び出し：元に戻してから登録する
    at(clock.now + holdMs + 1);
    const b = await bodyOf(await reg(deps, f.txnOf(third.no)!.id, "shop", "10.0.0.2"));
    assert.equal(b.result, "registered", JSON.stringify(b));
    assert.equal(f.txnOf(SHOP_ITEM.no)!.status, 1, "前の試しは未処理に戻った");
    assert.equal(f.txnOf(PRIVATE_ITEM.no)!.status, 1);
    assert.equal(f.deals.size, 1, "残っているのは今の試しの取引だけ");
    const trial = await loadTrial(store);
    assert.equal(trial.items.length, 1);
  });

  test("元に戻すで消すのは置き場に残した取引だけ（オーナーが cookie の道で登録した物・ほかの取引には触らない）", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    const deps = makeDeps(f, store);
    // オーナーが cookie の道で登録した
    const own = f.txnOf(PRIVATE_ITEM.no)!;
    const or = await handleRegister(ownerReq("/api/freee/register", { cookie: ownerCookie(f.access), body: { id: own.id, use: "private", account: "card", date: own.date, amount: own.amount } }), deps);
    assert.equal((await bodyOf(or)).result, "registered");
    const ownerDeal = [...f.deals.keys()][0];
    f.deals.set(4242, { txnId: 1, private: false }); // ほかの取引
    const t = f.txnOf(SHOP_ITEM.no)!;
    assert.equal((await bodyOf(await reg(deps, t.id, "shop"))).result, "registered");
    at(clock.now + holdMs + 1);
    await read(deps);
    const deletes = f.calls.filter((c) => c.method === "DELETE").map((c) => c.path);
    assert.equal(deletes.length, 1);
    assert.ok(f.deals.has(ownerDeal), "オーナーの取引は残る");
    assert.ok(f.deals.has(4242));
    assert.equal(f.txnOf(PRIVATE_ITEM.no)!.status, 2, "オーナーが登録した明細はそのまま");
  });

  test("取引を消しても未処理に戻らない時は、印のある見本の明細だけを消して同じ中身と印で作り直す（同期の明細には触らない）", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    const synced = f.addSeed(SHOP_ITEM.no, { walletable_id: BANK_ID, walletable_type: "bank_account", description: "同期した明細", status: 2, due_amount: 0 });
    f.reopenOnDealDelete = false;
    const deps = makeDeps(f, store);
    const t = f.txnOf(SHOP_ITEM.no)!;
    assert.equal((await bodyOf(await reg(deps, t.id, "shop"))).result, "registered");
    at(clock.now + holdMs + 1);
    const b = await bodyOf(await read(deps));
    assert.equal(b.trial.phase, "free", JSON.stringify(b.trial));
    const deletes = f.calls.filter((c) => c.method === "DELETE").map((c) => c.path);
    assert.deepEqual(deletes, [`/api/1/deals/${7000}`, `/api/1/wallet_txns/${t.id}`]);
    const again = f.txnOf(SHOP_ITEM.no)!;
    assert.notEqual(again.id, t.id);
    assert.equal(again.description, `${merchantName(SHOP_ITEM.merchantId)} ${mark(SHOP_ITEM.no)}`);
    assert.equal(again.amount, SHOP_ITEM.amount);
    assert.equal(again.date, SHOP_ITEM.date);
    assert.equal(again.status, 1);
    assert.ok(f.txns.includes(synced), "同期の明細には触らない");
    assert.equal((await loadTrial(store)).items.length, 0);
  });

  test("作り直した明細が自動登録のルールで登録されたら、要復旧で止める（書かない）", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    f.reopenOnDealDelete = false;
    const deps = makeDeps(f, store);
    assert.equal((await bodyOf(await reg(deps, f.txnOf(SHOP_ITEM.no)!.id, "shop"))).result, "registered");
    f.autoRuleOnCreate = true;
    at(clock.now + holdMs + 1);
    const b = await bodyOf(await read(deps));
    assert.equal(b.trial.phase, "repair");
    const writesBefore = f.writes().length;
    const r = await bodyOf(await reg(deps, f.txnOf(PRIVATE_ITEM.no)!.id, "private", "10.7.7.7"));
    assert.equal(r.reason, TRY_MESSAGES.repair);
    assert.equal(f.writes().length, writesBefore, "要復旧の間は書かない");
    at(clock.now + holdMs * 3);
    await read(deps);
    assert.equal(f.writes().length, writesBefore, "要復旧のまま、もう作り直さない");
  });

  test("プライベート取引を消せない（freee が受けない）時は、明細を消さずに要復旧", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    f.privateDeleteStatus = 400;
    const deps = makeDeps(f, store);
    assert.equal((await bodyOf(await reg(deps, f.txnOf(PRIVATE_ITEM.no)!.id, "private"))).result, "registered");
    at(clock.now + holdMs + 1);
    assert.equal((await bodyOf(await read(deps))).trial.phase, "repair");
    assert.ok(!f.calls.some((c) => c.method === "DELETE" && c.path.startsWith("/api/1/wallet_txns/")));
  });

  test("元に戻すが持ち時間で区切られた時は、次の呼び出しで続きからやり、終わるまで登録させない", async () => {
    const settings: FreeeSettings = { ...base, serverBudgetSeconds: 20, timeoutSeconds: 5 };
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    f.reopenOnDealDelete = false;
    const deps = () => makeDeps(f, store, settings);
    const a = f.txnOf(SHOP_ITEM.no)!;
    const p = f.txnOf(PRIVATE_ITEM.no)!;
    assert.equal((await bodyOf(await reg(deps(), a.id, "shop"))).result, "registered");
    assert.equal((await bodyOf(await reg(deps(), p.id, "private"))).result, "registered");
    at(clock.now + holdMs + 1);
    f.tick = 4000; // freee を呼ぶたびに4秒たつ
    const r1 = await bodyOf(await reg(deps(), a.id, "shop", "10.4.4.4"));
    assert.equal(r1.result, "refused");
    assert.equal(r1.reason, TRY_MESSAGES.restoring);
    const mid = await loadTrial(store);
    assert.equal(mid.restoring, true);
    assert.ok(mid.items.length > 0);
    let rounds = 0;
    while ((await loadTrial(store)).items.length && rounds++ < 10) {
      const b = await bodyOf(await read(deps(), `10.4.4.${rounds + 10}`));
      if ((await loadTrial(store)).items.length) assert.ok(["restoring"].includes(b.trial?.phase ?? "restoring"), JSON.stringify(b));
    }
    f.tick = 0;
    assert.equal((await loadTrial(store)).items.length, 0, "続きからやり終えた");
    assert.equal(f.txnOf(SHOP_ITEM.no)!.status, 1);
    assert.equal(f.txnOf(PRIVATE_ITEM.no)!.status, 1);
    assert.equal(f.txns.filter((t) => hasMark(t.description, mark(SHOP_ITEM.no))).length, 1, "作り直しは1つだけ");
    assert.equal((await bodyOf(await reg(deps(), f.txnOf(SHOP_ITEM.no)!.id, "shop", "10.4.4.4"))).result, "registered");
  });
});

// ---- 5. 印は1つ ----

describe("freee：書く時の印は1つ（来た人の登録・元に戻す・オーナーの明細を入れる・登録）", () => {
  test("印をだれかが持っている間は、来た人の登録もオーナーの明細を入れる・登録も「少し待ってから」", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    const deps = makeDeps(f, store);
    await store.set(FREEE_KV.writeLock, "someone", { ex: 120, nx: true });
    const t = f.txnOf(SHOP_ITEM.no)!;
    assert.equal((await reg(deps, t.id, "shop")).status, 409);
    const cookie = ownerCookie(f.access);
    const or = await handleRegister(ownerReq("/api/freee/register", { cookie, body: { id: t.id, use: "shop", account: "card", date: t.date, amount: t.amount } }), deps);
    assert.equal(or.status, 409);
    const oi = await handleImport(ownerReq("/api/freee/import", { cookie }), deps);
    assert.equal(oi.status, 409);
    assert.equal(f.writes().length, 0);
    assert.equal(await store.get(FREEE_KV.writeLock), "someone", "ほかの人の印は消さない");
    await store.del(FREEE_KV.writeLock);
    assert.equal((await bodyOf(await handleRegister(ownerReq("/api/freee/register", { cookie, body: { id: t.id, use: "shop", account: "card", date: t.date, amount: t.amount } }), deps))).result, "registered");
    assert.equal(await store.get(FREEE_KV.writeLock), null, "終わったら自分の印を消す");
  });

  test("置き場の無いオーナーの窓口は、今どおり印なしで動く", async () => {
    const f = new FakeFreee();
    f.addAllSeed();
    const deps = makeDeps(f, null);
    const t = f.txnOf(SHOP_ITEM.no)!;
    const or = await handleRegister(ownerReq("/api/freee/register", { cookie: ownerCookie(f.access), body: { id: t.id, use: "shop", account: "card", date: t.date, amount: t.amount } }), deps);
    assert.equal((await bodyOf(or)).result, "registered");
  });

  test("印の期限の後には書かない：印の期限は持ち時間より長く、持ち時間をこえそうなら書く前に区切る", async () => {
    const settings: FreeeSettings = { ...base, serverBudgetSeconds: 30, timeoutSeconds: 10, try: { ...base.try, lockSeconds: 5 } };
    assert.ok(writeLockSeconds(settings) > settings.serverBudgetSeconds + settings.timeoutSeconds, "短い設定でも、印の期限は持ち時間より長くする");
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    f.tick = 6_000; // freee を呼ぶたびに6秒
    const deps = makeDeps(f, store, settings);
    const b = await bodyOf(await reg(deps, f.txnOf(SHOP_ITEM.no)!.id, "shop"));
    assert.notEqual(b.result, "registered", JSON.stringify(b));
    assert.ok(!f.calls.some((c) => c.path.includes("create_deal")), "持ち時間をこえそうなので書かない");
    assert.equal((await loadTrial(store)).items.length, 0, "書かなかった物は記録に残さない");
    assert.equal(await store.get(FREEE_KV.writeLock), null);
  });
});

// ---- 6. つなぎを外す ----

describe("freee：つなぎを外す時は、先に元に戻してから置き場の鍵を消す", () => {
  test("まだ元に戻していない物があれば、オーナーの鍵で先に元に戻してから消す", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    const deps = makeDeps(f, store);
    assert.equal((await bodyOf(await reg(deps, f.txnOf(SHOP_ITEM.no)!.id, "shop"))).result, "registered");
    const genBefore = await currentGen(store);
    const r = await handleDisconnect(ownerReq("/api/freee/disconnect", { cookie: ownerCookie(f.access) }), deps);
    const b = await bodyOf(r);
    assert.equal(b.restored, "done");
    assert.equal(f.deals.size, 0);
    assert.equal(f.txnOf(SHOP_ITEM.no)!.status, 1);
    assert.equal(await store.get(FREEE_KV.token), null, "置き場の鍵を消した");
    assert.equal(await currentGen(store), genBefore + 1, "つないだ回の番号を進めた");
    assert.equal((await bodyOf(await read(deps))).code, "not-connected");
  });

  test("戻せなければ元に戻す記録は残し、次につないだ時に元に戻す", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    const deps = makeDeps(f, store);
    const t = f.txnOf(SHOP_ITEM.no)!;
    assert.equal((await bodyOf(await reg(deps, t.id, "shop"))).result, "registered");
    f.dropOn = "delete_deal";
    f.reopenOnDealDelete = false; // 返事が途切れ、まだ戻っていない
    const deal = [...f.deals.keys()][0];
    const origFetch = f.fetch;
    f.fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "DELETE") throw new TypeError("network");
      return origFetch(input, init);
    };
    const r = await bodyOf(await handleDisconnect(ownerReq("/api/freee/disconnect", { cookie: ownerCookie(f.access) }), makeDeps(f, store)));
    assert.equal(r.restored, "partial");
    assert.equal(await store.get(FREEE_KV.token), null);
    const kept = await loadTrial(store);
    assert.equal(kept.items.length, 1, "明細と取引の番号は残す");
    assert.deepEqual(kept.items[0].dealIds, [deal]);
    // 次につないだ時（戻り先）に元に戻す
    f.fetch = origFetch;
    f.dropOn = null;
    f.reopenOnDealDelete = true;
    const d2 = makeDeps(f, store);
    const start = await handleStart(ownerReq("/api/freee/start"), d2);
    const loc = new URL(start.headers.get("location")!);
    const sc = start.headers.getSetCookie().find((c) => c.startsWith(STATE_COOKIE))!.split(";")[0];
    const q = new URLSearchParams({ code: "c2", state: loc.searchParams.get("state")! });
    const cb = await handleCallback(ownerReq(`/api/freee/callback?${q}`, { method: "GET", cookie: sc }), d2);
    assert.equal(cb.headers.get("location"), "/accounting?freee=connected#freee");
    assert.equal((await loadTrial(store)).items.length, 0, "つないだ時に元に戻した");
    assert.equal(f.deals.size, 0);
    assert.equal(f.txnOf(SHOP_ITEM.no)!.status, 1);
  });

  test("要復旧の記録は、オーナーが freee の側で見本どおりに直してから、もう一度つなぐと外れる（消す・作り直すはしない）", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    f.dropOn = "create_deal";
    const deps = makeDeps(f, store);
    const t = f.txnOf(SHOP_ITEM.no)!;
    await reg(deps, t.id, "shop");
    assert.equal((await loadTrial(store)).repair, true);
    f.dropOn = null;
    // オーナーが freee の画面で取引を消し、明細を未処理に戻した
    f.deals.clear();
    t.status = 1;
    t.due_amount = t.amount;
    const before = f.writes().length;
    const start = await handleStart(ownerReq("/api/freee/start"), deps);
    const loc = new URL(start.headers.get("location")!);
    const sc = start.headers.getSetCookie().find((c) => c.startsWith(STATE_COOKIE))!.split(";")[0];
    const q = new URLSearchParams({ code: "c3", state: loc.searchParams.get("state")! });
    await handleCallback(ownerReq(`/api/freee/callback?${q}`, { method: "GET", cookie: sc }), deps);
    assert.equal(f.writes().length, before, "確かめるだけ");
    const tr = await loadTrial(store);
    assert.equal(tr.repair, false);
    assert.equal(tr.items.length, 0);
  });

  test("記録の形がおかしい時は、元に戻せるか分からないので要復旧", () => {
    assert.equal(parseTrial("{").repair, true);
    assert.equal(parseTrial(JSON.stringify({ v: 1, items: [{ id: 1 }] })).repair, true);
    assert.equal(parseTrial(null).repair, false);
  });
});

// ---- 直しV の追加の直し ----

/** オーナーがもう一度つなぐ（戻り先まで） */
async function reconnect(f: FakeFreee, deps: FreeeDeps): Promise<Response> {
  const start = await handleStart(ownerReq("/api/freee/start"), deps);
  const loc = new URL(start.headers.get("location")!);
  const sc = start.headers.getSetCookie().find((c) => c.startsWith(STATE_COOKIE))!.split(";")[0];
  const q = new URLSearchParams({ code: `c-${++n}`, state: loc.searchParams.get("state")! });
  return handleCallback(ownerReq(`/api/freee/callback?${q}`, { method: "GET", cookie: sc }), deps);
}

/**
 * 置いた直後の GET が古い値を返す作り物の置き場（1回の呼び出しごとに作る。書いたこの置き場から、すぐ後に同じ鍵を読むと、書く前の値が返る）。
 * 別に作った置き場（別の呼び出し）からは、新しい値が読める。
 */
function laggingStore(base: ReturnType<typeof memoryStore>): KvStore {
  const before = new Map<string, string | null>();
  const wrote = async (k: string) => {
    if (!before.has(k)) before.set(k, await base.get(k));
  };
  return {
    get: async (k) => (before.has(k) ? (before.get(k) ?? null) : base.get(k)),
    set: async (k, v, o) => {
      await wrote(k);
      return base.set(k, v, o);
    },
    del: async (k) => {
      await wrote(k);
      return base.del(k);
    },
    getdel: (k) => base.getdel(k),
    incr: async (k, ex) => {
      await wrote(k);
      return base.incr(k, ex);
    },
    rpush: (k, v, ex) => base.rpush(k, v, ex),
    lpop: (k, c) => base.lpop(k, c),
    expire: (k, ex) => base.expire(k, ex),
  };
}

describe("freee：置き場の書いた直後の読み直し（直しW と同じ考え）", () => {
  test("置いた直後の GET が古い値を返す置き場でも、つないだ時に「cookie だけ」に倒れない・来た人の窓口が 503 にならない", async () => {
    const f = new FakeFreee();
    const mem = memoryStore(() => clock.now);
    // 前につないだ回がある（番号が進んでいる）
    await advanceGen(ctxOf(mem));
    const cb = await reconnect(f, makeDeps(f, laggingStore(mem)));
    assert.equal(cb.headers.get("location"), "/accounting?freee=connected#freee");
    f.addAllSeed();
    const r = await read(makeDeps(f, laggingStore(mem)));
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    assert.equal((await bodyOf(r)).rows.length, items.length);
  });
});

describe("freee：数え方は同じ送り元 → 1分 → 1日（1つの送り元で全体を使い切れない）", () => {
  test("1つの送り元が上限をこえて送り続けても、全体の1日の数はその送り元の上限までしか増えず、ほかの送り元は通る", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    const deps = makeDeps(f, store);
    const id = f.txnOf(INCOME_ITEM.no)!.id;
    for (let i = 0; i < 100; i++) {
      at(T0 + i * 61_000);
      await reg(deps, id, "shop", "198.51.100.50");
    }
    assert.equal(await store.get(FREEE_KV.count("register", "day:2026-11-05")), String(base.try.register.perSenderDaily), "全体の1日はその送り元の上限まで");
    for (let i = 0; i < 200; i++) {
      at(T0 + i * 3_000);
      await read(deps, "198.51.100.50");
    }
    assert.equal(await store.get(FREEE_KV.count("read", "day:2026-11-05")), String(base.try.read.perSenderDaily));
    at(T0 + 200 * 61_000);
    assert.notEqual((await reg(deps, id, "shop", "198.51.100.51")).status, 429, "ほかの送り元は通る");
    assert.equal((await read(deps, "198.51.100.51")).status, 200);
  });

  test("同じ /64 の違う IPv6 は同じ送り元（IPv4 を写した IPv6 は IPv4）", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    const deps = makeDeps(f, store);
    for (let i = 0; i < base.try.read.perSenderDaily; i++) {
      at(T0 + Math.floor(i / 25) * 61_000);
      assert.equal((await read(deps, `2001:db8:1:2::${(i + 1).toString(16)}`)).status, 200, `${i}`);
    }
    at(T0 + 10 * 61_000);
    assert.equal((await read(deps, "2001:db8:1:2:ffff:ffff:ffff:ffff")).status, 429, "同じ /64");
    assert.equal((await read(deps, "2001:db8:1:3::1")).status, 200, "違う /64");
    // IPv4 と、それを写した IPv6 は同じ送り元
    const s2 = memoryStore(() => clock.now);
    await connected(f, s2);
    const d2 = makeDeps(f, s2);
    for (let i = 0; i < base.try.read.perSenderDaily; i++) {
      at(T0 + Math.floor(i / 25) * 61_000);
      await read(d2, i % 2 ? "192.0.2.80" : "::ffff:192.0.2.80");
    }
    at(T0 + 10 * 61_000);
    assert.equal((await read(d2, "::ffff:192.0.2.80")).status, 429);
  });
});

describe("freee：元に戻す時に消す物は、記録の番号の物だけ", () => {
  test("私用の取引を消すと 404 が返る時、1回目は要復旧（明細を消さない・作り直さない）", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    f.reopenOnDealDelete = false;
    f.privateDeleteStatus = 404;
    const deps = makeDeps(f, store);
    assert.equal((await bodyOf(await reg(deps, f.txnOf(PRIVATE_ITEM.no)!.id, "private"))).result, "registered");
    at(clock.now + holdMs + 1);
    assert.equal((await bodyOf(await read(deps))).trial.phase, "repair");
    assert.ok(!f.calls.some((c) => c.method === "DELETE" && c.path.startsWith("/api/1/wallet_txns/")), "明細を消さない");
    assert.ok(!f.calls.some((c) => c.method === "POST" && c.path === "/api/1/wallet_txns"), "作り直さない");
    assert.equal(f.deals.size, 1, "取引は残っている（記録も残す）");
    assert.equal((await loadTrial(store)).items[0].dealIds!.length, 1);
  });

  test("取引を消した返事が途切れた次の回は、404 を「もう無い」として進める", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    const deps = makeDeps(f, store);
    assert.equal((await bodyOf(await reg(deps, f.txnOf(SHOP_ITEM.no)!.id, "shop"))).result, "registered");
    at(clock.now + holdMs + 1);
    f.dropOn = "delete_deal";
    assert.equal((await bodyOf(await read(deps))).trial.phase, "restoring");
    assert.equal(f.deals.size, 0, "freee の中では消えた");
    assert.ok((await loadTrial(store)).items[0].deleting, "消している番号を記録に置いた");
    f.dropOn = null;
    const b = await bodyOf(await read(deps));
    assert.equal(b.trial.phase, "free", JSON.stringify(b.trial));
    assert.equal((await loadTrial(store)).items.length, 0);
    assert.equal(f.txnOf(SHOP_ITEM.no)!.status, 1);
  });

  test("印が同じでも番号の違う明細は消さない（オーナーが freee の画面で入れ直した明細を含む）", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    f.reopenOnDealDelete = false;
    const deps = makeDeps(f, store);
    const t = f.txnOf(SHOP_ITEM.no)!;
    assert.equal((await bodyOf(await reg(deps, t.id, "shop"))).result, "registered");
    // オーナーが freee の画面で、元の明細を消して同じ中身と印で入れ直した
    f.txns = f.txns.filter((x) => x !== t);
    const again = f.addSeed(SHOP_ITEM.no, { status: 2, due_amount: 0 });
    at(clock.now + holdMs + 1);
    assert.equal((await bodyOf(await read(deps))).trial.phase, "repair");
    assert.ok(f.txns.includes(again), "番号の違う明細には触らない");
    assert.ok(!f.calls.some((c) => c.method === "DELETE" && c.path.startsWith("/api/1/wallet_txns/")));
  });

  test("明細を消した返事が途切れた次の回に、見つからなければ消えた扱いで作り直す", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    f.reopenOnDealDelete = false;
    const deps = makeDeps(f, store);
    const t = f.txnOf(SHOP_ITEM.no)!;
    assert.equal((await bodyOf(await reg(deps, t.id, "shop"))).result, "registered");
    at(clock.now + holdMs + 1);
    f.dropOn = "delete_txn";
    assert.equal((await bodyOf(await read(deps))).trial.phase, "restoring");
    assert.equal(f.txnOf(SHOP_ITEM.no), undefined, "freee の中では消えた");
    assert.equal((await loadTrial(store)).items[0].step, "txn-deleting");
    f.dropOn = null;
    assert.equal((await bodyOf(await read(deps))).trial.phase, "free");
    const now = f.txnOf(SHOP_ITEM.no)!;
    assert.notEqual(now.id, t.id);
    assert.equal(now.status, 1);
    assert.equal(f.txns.filter((x) => hasMark(x.description, mark(SHOP_ITEM.no))).length, 1);
  });

  test("作り直しの返事が途切れて、次の回に見つからない時は、もう1つ作らずに要復旧", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    f.reopenOnDealDelete = false;
    const deps = makeDeps(f, store);
    assert.equal((await bodyOf(await reg(deps, f.txnOf(SHOP_ITEM.no)!.id, "shop"))).result, "registered");
    at(clock.now + holdMs + 1);
    f.createTxnDropBefore = true;
    assert.equal((await bodyOf(await read(deps))).trial.phase, "restoring");
    assert.equal((await loadTrial(store)).items[0].step, "recreating");
    f.createTxnDropBefore = false;
    const posts = () => f.calls.filter((c) => c.method === "POST" && c.path === "/api/1/wallet_txns").length;
    const before = posts();
    assert.equal((await bodyOf(await read(deps))).trial.phase, "repair");
    assert.equal(posts(), before, "もう1つ作らない");
  });

  test("create_deal の返事が deal_ids: [] の時は「登録できた」ではなく、結果が分からない（要復旧）", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    f.emptyDealIds = true;
    const deps = makeDeps(f, store);
    const b = await bodyOf(await reg(deps, f.txnOf(SHOP_ITEM.no)!.id, "shop"));
    assert.equal(b.result, "unknown");
    assert.equal((await loadTrial(store)).repair, true);
  });
});

describe("freee：オーナーの道との重なり", () => {
  test("区切りをまたいで、オーナーの登録は試しの記録にある明細を断る（要復旧の記録も）", async () => {
    const settings: FreeeSettings = { ...base, serverBudgetSeconds: 20, timeoutSeconds: 5 };
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    f.reopenOnDealDelete = false;
    const t = f.txnOf(SHOP_ITEM.no)!;
    assert.equal((await bodyOf(await reg(makeDeps(f, store, settings), t.id, "shop"))).result, "registered");
    at(clock.now + holdMs + 1);
    f.tick = 4000;
    await read(makeDeps(f, store, settings));
    f.tick = 0;
    const mid = await loadTrial(store);
    assert.equal(mid.restoring, true, "区切られた");
    const now = f.txnOf(SHOP_ITEM.no) ?? t;
    const or = await handleRegister(ownerReq("/api/freee/register", { cookie: ownerCookie(f.access), body: { id: now.id, use: "shop", account: "card", date: now.date, amount: now.amount } }), makeDeps(f, store, settings));
    const ob = await bodyOf(or);
    assert.equal(ob.reason, "来た人の試しを元に戻すまで、この明細は登録しません");
    // 要復旧の記録にある明細も
    const s2 = memoryStore(() => clock.now);
    const g = new FakeFreee();
    await connected(g, s2);
    g.addAllSeed();
    g.dropOn = "create_private_deal";
    const p = g.txnOf(PRIVATE_ITEM.no)!;
    await reg(makeDeps(g, s2), p.id, "private");
    g.dropOn = null;
    p.status = 1;
    p.due_amount = p.amount;
    const r2 = await handleRegister(ownerReq("/api/freee/register", { cookie: ownerCookie(g.access), body: { id: p.id, use: "private", account: "card", date: p.date, amount: p.amount } }), makeDeps(g, s2));
    assert.equal((await bodyOf(r2)).reason, "来た人の試しを元に戻すまで、この明細は登録しません");
  });

  test("外す時に印が取れなければ鍵を消さない（409・cookie も残す）。書いている途中に外しても、外した後に書きが入らない", async () => {
    const f = new FakeFreee();
    const store = memoryStore(() => clock.now);
    await connected(f, store);
    f.addAllSeed();
    const deps = makeDeps(f, store);
    let disconnectAnswer: Response | null = null;
    f.beforeWrite = async (path) => {
      if (path.endsWith("/create_deal") && !disconnectAnswer) disconnectAnswer = await handleDisconnect(ownerReq("/api/freee/disconnect", { cookie: ownerCookie(f.access) }), makeDeps(f, store));
    };
    assert.equal((await bodyOf(await reg(deps, f.txnOf(SHOP_ITEM.no)!.id, "shop"))).result, "registered");
    const d = disconnectAnswer!;
    assert.equal(d.status, 409);
    assert.equal((await d.json()).message, "いま来た人の試しを書いています。少し待ってから、もう一度押してください");
    assert.ok(!d.headers.getSetCookie().some((c) => c.startsWith(`${TOKEN_COOKIE}=`)), "cookie は消さない");
    assert.ok(await store.get(FREEE_KV.token), "鍵は消さない");
    f.beforeWrite = null;
    // 外す：書いていない時は、先に元に戻してから消す。外した後は書きが入らない
    const ok = await handleDisconnect(ownerReq("/api/freee/disconnect", { cookie: ownerCookie(f.access) }), makeDeps(f, store));
    assert.equal(ok.status, 200);
    assert.equal(await store.get(FREEE_KV.token), null);
    const writes = f.writes().length;
    const after = await reg(makeDeps(f, store), f.txnOf(PRIVATE_ITEM.no)!.id, "private", "10.20.30.40");
    assert.equal((await bodyOf(after)).code, "not-connected");
    assert.equal(f.writes().length, writes);
  });

  test("外す時に置き場が落ちたら 503 で、cookie は消えない", async () => {
    const f = new FakeFreee();
    const mem = memoryStore(() => clock.now);
    await connected(f, mem);
    const down: KvStore = { ...mem, set: async () => Promise.reject(new Error("down")), get: async () => Promise.reject(new Error("down")), incr: async () => Promise.reject(new Error("down")), del: async () => Promise.reject(new Error("down")) };
    const r = await handleDisconnect(ownerReq("/api/freee/disconnect", { cookie: ownerCookie(f.access) }), makeDeps(f, down));
    assert.equal(r.status, 503);
    assert.equal((await r.json()).message, "サーバーの鍵を消せませんでした。少し待ってから、もう一度押してください");
    assert.ok(!r.headers.getSetCookie().some((c) => c.startsWith(`${TOKEN_COOKIE}=`)), "cookie は消さない（もう一度押せる）");
    assert.ok(await mem.get(FREEE_KV.token));
  });

  test("書いた後に番号が変わったら、markKvExpired は自分が書いた物を消す（延ばす所と同じ順）", async () => {
    const f = new FakeFreee();
    const mem = memoryStore(() => clock.now);
    await connected(f, mem);
    let after = false;
    const store: KvStore = {
      ...mem,
      set: async (k, v, o) => {
        const r = await mem.set(k, v, o);
        // 鍵を書いた直後に、オーナーが外した（番号が進んだ）
        if (k === FREEE_KV.token && !after) {
          after = true;
          await mem.incr(FREEE_KV.gen, 600);
        }
        return r;
      },
    };
    const { markKvExpired } = await import("../kv");
    await markKvExpired(ctxOf(store), f.access);
    assert.equal(await mem.get(FREEE_KV.token), null, "書いた物を消した");
  });
});

describe("freee：要復旧で止める所", () => {
  test("番号を置けなかった後の、同じ人の2件目は断る（その場で要復旧）", async () => {
    const f = new FakeFreee();
    const mem = memoryStore(() => clock.now);
    await connected(f, mem);
    f.addAllSeed();
    let trialWrites = 0;
    const store: KvStore = {
      ...mem,
      set: async (k, v, o) => {
        if (k === FREEE_KV.trial && ++trialWrites === 2) throw new Error("down");
        return mem.set(k, v, o);
      },
    };
    assert.equal((await bodyOf(await reg(makeDeps(f, store), f.txnOf(SHOP_ITEM.no)!.id, "shop", "10.1.2.3"))).result, "registered");
    const writes = f.writes().length;
    const second = await bodyOf(await reg(makeDeps(f, mem), f.txnOf(PRIVATE_ITEM.no)!.id, "private", "10.1.2.3"));
    assert.equal(second.reason, TRY_MESSAGES.repair);
    assert.equal(f.writes().length, writes);
    assert.equal((await loadTrial(mem)).repair, true);
  });

  test("読めない記録・壊れた項目のある記録は、つなぎ直しで確かめずには消えない（見本の出金がみな見本どおりの未処理の時だけ消す）", async () => {
    for (const raw of ["{", JSON.stringify({ v: 1, by: null, items: [{ id: "x" }], lastWriteAt: 1, repair: false, restoring: false })]) {
      const f = new FakeFreee();
      const store = memoryStore(() => clock.now);
      f.addAllSeed();
      // 見本の出金の1つが、まだ登録されたまま
      const left = f.txnOf(SHOP_ITEM.no)!;
      left.status = 2;
      left.due_amount = 0;
      await store.set(FREEE_KV.trial, raw, { ex: 600 });
      await reconnect(f, makeDeps(f, store));
      const t = await loadTrial(store);
      assert.equal(t.repair, true, raw);
      assert.equal(t.broken, true);
      assert.ok(f.calls.some((c) => c.path === "/api/1/wallet_txns" && c.method === "GET"), "読んで確かめた");
      // 直したら消える
      left.status = 1;
      left.due_amount = left.amount;
      await reconnect(f, makeDeps(f, store));
      assert.equal((await loadTrial(store)).repair, false, raw);
    }
  });

  test("期限の後に書かない：印の期限が持ち時間より先に来る作り物の時計（置き場の時計が早く進む）で、freee に送らない", async () => {
    const f = new FakeFreee();
    const storeClock = { now: T0 };
    const store = memoryStore(() => storeClock.now);
    await connected(f, store);
    storeClock.now = clock.now;
    f.addAllSeed();
    // freee を呼ぶたびに、置き場の時計だけが印の期限をこえて進む（こちらの時計はほとんど進まない）
    const origFetch = f.fetch;
    f.fetch = async (input, init) => {
      storeClock.now += (base.try.lockSeconds + 60) * 1000;
      return origFetch(input, init);
    };
    const deps = makeDeps(f, store);
    const b = await bodyOf(await reg(deps, f.txnOf(SHOP_ITEM.no)!.id, "shop"));
    assert.notEqual(b.result, "registered", JSON.stringify(b));
    assert.ok(!f.calls.some((c) => c.path.includes("create_deal")), "freee に送らない");
  });
});
