// 経理の freee（テスト事業所）とのつなぎ。Claude も freee も呼ばない（fetch を、テストの中だけの freee に置きかえる）。
// 確かめること：テスト事業所以外を止める・cookie が無いと止める・POST 以外と本番以外のサイトから来た呼び出しを止める・
// プレビューで止める・明細の状態の分け方・候補2件で止める・結果が分からない時に送り直さない・印で明細を二重に入れない・
// 送っている間は戻せない・口座が0件・2件で止める。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, test } from "node:test";
import { BROWSER_PREFIX, FREEE_KEY } from "../../browser";
import { getAccounting } from "../../data/seed";
import type { CardItem } from "../../data/types";
import { getFreeeSettings } from "../../settings";
import type { WalletTxn } from "../api";
import { hasMark, lookup, markOf, pickCardAccount, verdictOf } from "../match";
import { BUSY_REASON, pressCheck, pressImport, pressRegister, recoverIfIdle, runCheck, runRegister, withFreeeLock, type LockLike, type Post, type RunDeps } from "../run";
import { cookieKeyFrom, seal, unseal } from "../seal";
import {
  envFrom,
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
import { EMPTY_FREEE, importHeld, isSending, keptOnReset, parseFreee, stateOf, withChecked, withItem, withRunStart, withStaleRecovered, type FreeeRecord } from "../state";
import { resetAllWrites } from "../../reset";

const settings = getFreeeSettings();
const seed = getAccounting();
const SITE = settings.siteOrigin;
const HOST = new URL(SITE).host;
const COMPANY = 1234567;
const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const KEY = cookieKeyFrom(KEY_B64)!;
const NOW = Date.parse("2026-11-05T03:00:00.000Z");
const items = seed.statement.items;
const version = seed.statement.version!;
const mark = (no: number) => markOf(settings.markPrefix, version, no);
const item = (no: number) => items.find((i) => i.no === no)!;
// 自動のルール（店用）の明細と、私用の明細
const shopRule = seed.rules.find((r) => r.use === "shop")!;
const privateRule = seed.rules.find((r) => r.use === "private")!;
const SHOP_ITEM = items.find((i) => i.merchantId === shopRule.merchantId)!;
const PRIVATE_ITEM = items.find((i) => i.merchantId === privateRule.merchantId)!;

// ---- テストの中だけの freee ----

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };

class FakeFreee {
  calls: Call[] = [];
  walletables = [{ id: 11, name: settings.cardName, type: "credit_card" as const, bank_id: null, update_date: "2026-11-01" }];
  txns: WalletTxn[] = [];
  accountItems = [
    { id: 501, name: settings.accountItemName, available: true },
    { id: 502, name: "通信費", available: true },
  ];
  taxes = [
    { code: 136, name: "purchase_with_tax_10", name_ja: settings.taxName, available: true },
    { code: 108, name: "x", name_ja: "課税売上10%", available: true },
  ];
  nextId = 900;
  token: Record<string, unknown> = { access_token: "fake-token", token_type: "bearer", expires_in: 86400, refresh_token: "fake-refresh", company_id: COMPANY };
  /** この道の書く呼び出しで、返事を途切れさせる（つながらない） */
  dropOn: string | null = null;
  /** 入れる明細の何件目で返事を途切れさせるか（1から） */
  dropCreateAt: number | null = null;
  created = 0;
  /** サーバーの時計（持ち時間のテストで、freee を呼ぶたびに進める）。null なら NOW のまま */
  serverNow: number | null = null;

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" && init.body ? (url.pathname.endsWith("/token") ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body)) : null;
    this.calls.push({ method, path: url.pathname, query: url.searchParams, body });
    const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/public_api/token") return ok(this.token);
    if (url.pathname === "/api/1/walletables") return ok({ walletables: this.walletables });
    if (url.pathname === "/api/1/account_items") return ok({ account_items: this.accountItems });
    if (url.pathname === `/api/1/taxes/companies/${COMPANY}`) return ok({ taxes: this.taxes });
    if (url.pathname === "/api/1/wallet_txns" && method === "GET") {
      const wid = Number(url.searchParams.get("walletable_id"));
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      const list = this.txns.filter((t) => t.walletable_id === wid);
      return ok({ wallet_txns: list.slice(offset, offset + limit) });
    }
    if (url.pathname === "/api/1/wallet_txns" && method === "POST") {
      this.created++;
      const b = body as Record<string, unknown>;
      const t: WalletTxn = {
        id: this.nextId++,
        company_id: b.company_id as number,
        date: b.date as string,
        amount: b.amount as number,
        due_amount: b.amount as number,
        entry_side: b.entry_side as "expense",
        walletable_type: b.walletable_type as "credit_card",
        walletable_id: b.walletable_id as number,
        description: b.description as string,
        status: 1,
      };
      this.txns.push(t);
      // 書いた後に返事が途切れる
      if (this.dropCreateAt === this.created) throw new TypeError("network");
      return ok({ wallet_txn: t }, 201);
    }
    const m = url.pathname.match(/^\/api\/1\/wallet_txns\/(\d+)\/(create_deal|create_private_deal)$/);
    if (m && method === "POST") {
      const t = this.txns.find((x) => x.id === Number(m[1]))!;
      t.status = 2;
      t.due_amount = 0;
      if (this.dropOn === m[2]) throw new TypeError("network");
      return m[2] === "create_deal" ? ok({ deal_ids: [7000 + t.id] }) : ok({ deal_id: 8000 + t.id });
    }
    return ok({ status_code: 404 }, 404);
  };

  writes(): Call[] {
    return this.calls.filter((c) => c.method === "POST" && c.path !== "/public_api/token");
  }

  addTxn(no: number, patch: Partial<WalletTxn> = {}): WalletTxn {
    const i = item(no);
    const t: WalletTxn = {
      id: this.nextId++,
      company_id: COMPANY,
      date: i.date,
      amount: i.amount,
      due_amount: i.amount,
      entry_side: "expense",
      walletable_type: "credit_card",
      walletable_id: 11,
      description: `x ${mark(no)}`,
      status: 1,
      ...patch,
    };
    this.txns.push(t);
    return t;
  }
}

// 乱数の代わり（呼ぶたびに違う値）
let n = 0;
function makeDeps(freee: FakeFreee, env: Partial<Record<string, string>> = {}): FreeeDeps {
  return {
    env: envFrom({ VERCEL_ENV: "production", FREEE_CLIENT_ID: "cid", FREEE_CLIENT_SECRET: "csecret", FREEE_COMPANY_ID: String(COMPANY), ...env }, cookieKeyFrom(env.FREEE_COOKIE_KEY ?? KEY_B64)),
    settings,
    seed,
    fetch: (input, init) => freee.fetch(input, init),
    now: () => freee.serverNow ?? NOW,
    random: (len) => Buffer.alloc(len, ++n),
  };
}

function tokenCookie(companyId = COMPANY, expiresAt = NOW + 3600_000): string {
  return `${TOKEN_COOKIE}=${seal(KEY, "token", { accessToken: "fake-token", companyId, expiresAt })}`;
}

function req(path: string, p: { method?: string; cookie?: string | null; origin?: string | null; host?: string; body?: unknown; fetchSite?: string } = {}): Request {
  const method = p.method ?? "POST";
  const h = new Headers({ host: p.host ?? HOST });
  if (p.origin !== null && method === "POST") h.set("origin", p.origin ?? SITE);
  if (p.cookie !== null) h.set("cookie", p.cookie ?? tokenCookie());
  if (p.fetchSite) h.set("sec-fetch-site", p.fetchSite);
  if (p.body !== undefined) h.set("content-type", "application/json");
  return new Request(`${SITE}${path}`, { method, headers: h, body: p.body !== undefined ? JSON.stringify(p.body) : undefined });
}

const bodyOf = async (r: Response) => (await r.json()) as Record<string, any>;
const setCookies = (r: Response) => r.headers.getSetCookie();

// ---- 1. つなぐ・戻り先 ----

async function startAndCallback(freee: FakeFreee, env: Partial<Record<string, string>> = {}, mutate?: (q: URLSearchParams) => void) {
  const deps = makeDeps(freee, env);
  const start = await handleStart(req("/api/freee/start", { cookie: null }), deps);
  assert.equal(start.status, 303);
  const loc = new URL(start.headers.get("location")!);
  const stateCookie = setCookies(start).find((c) => c.startsWith(STATE_COOKIE))!.split(";")[0];
  const q = new URLSearchParams({ code: "the-code", state: loc.searchParams.get("state")! });
  mutate?.(q);
  const cb = await handleCallback(req(`/api/freee/callback?${q}`, { method: "GET", cookie: stateCookie }), deps);
  return { start, loc, stateCookie, cb };
}

describe("freee：つなぐ（OAuth の認可コード）", () => {
  test("許可の URL：事業所を選ぶ画面・毎回ちがう合図（state）・PKCE。合図は暗号化した cookie で始めたブラウザに結びつける", async () => {
    const freee = new FakeFreee();
    const { start, loc, stateCookie } = await startAndCallback(freee);
    assert.equal(loc.origin + loc.pathname, settings.authorizeUrl);
    assert.equal(loc.searchParams.get("prompt"), "select_company");
    assert.equal(loc.searchParams.get("response_type"), "code");
    assert.equal(loc.searchParams.get("redirect_uri"), "https://secretairy.vercel.app/api/freee/callback");
    assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
    assert.ok((loc.searchParams.get("state") ?? "").length >= 40);
    assert.match(start.headers.get("cache-control")!, /no-store/);
    const c = setCookies(start).find((x) => x.startsWith(STATE_COOKIE))!;
    assert.match(c, /HttpOnly/);
    assert.match(c, /Secure/);
    assert.match(c, /SameSite=Lax/);
    assert.match(c, /Path=\//);
    assert.match(c, new RegExp(`Max-Age=${settings.stateMinutes * 60}`));
    assert.doesNotMatch(c, /Domain=/i, "このサイトだけ（__Host-）");
    // 中身は読めない（state も verifier も平文では入らない）
    assert.ok(!stateCookie.includes(loc.searchParams.get("state")!));
    // 2回目は別の合図
    const again = await handleStart(req("/api/freee/start", { cookie: null }), makeDeps(freee));
    assert.notEqual(new URL(again.headers.get("location")!).searchParams.get("state"), loc.searchParams.get("state"));
  });

  test("戻り先：合図が合えば鍵を暗号化した cookie に入れる（6時間まで・HttpOnly・Secure・SameSite・このサイトだけ）。合図の cookie は消す。キャッシュさせない", async () => {
    const freee = new FakeFreee();
    const { loc, cb } = await startAndCallback(freee);
    assert.equal(cb.status, 303);
    assert.equal(cb.headers.get("location"), "/accounting?freee=connected#freee");
    assert.match(cb.headers.get("cache-control")!, /no-store/);
    const cookies = setCookies(cb);
    assert.ok(cookies.some((c) => c.startsWith(`${STATE_COOKIE}=;`) && /Max-Age=0/.test(c)), "合図は使ったら消す");
    const t = cookies.find((c) => c.startsWith(`${TOKEN_COOKIE}=`) && !/Max-Age=0/.test(c))!;
    assert.match(t, /HttpOnly/);
    assert.match(t, /Secure/);
    assert.match(t, /SameSite=Strict/);
    assert.match(t, new RegExp(`Max-Age=${settings.maxTokenSeconds}(;|$)`), "freee が長く言っても6時間まで");
    assert.ok(!t.includes("fake-token") && !t.includes("fake-refresh"), "鍵は暗号化して入れる・更新の鍵は持たない");
    const payload = unseal(KEY, "token", t.split(";")[0].slice(TOKEN_COOKIE.length + 1)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), ["accessToken", "companyId", "expiresAt"]);
    assert.equal(payload.companyId, COMPANY);
    // 鍵に換える時：認可コード・PKCE の verifier・戻り先
    const call = freee.calls.find((x) => x.path === "/public_api/token")!;
    const b = call.body as Record<string, string>;
    assert.equal(b.grant_type, "authorization_code");
    assert.equal(b.code, "the-code");
    assert.equal(b.redirect_uri, "https://secretairy.vercel.app/api/freee/callback");
    assert.equal(createHash("sha256").update(b.code_verifier).digest("base64url"), loc.searchParams.get("code_challenge"));
  });

  test("合図が違う・cookie が無い・期限が過ぎた時は止める（鍵に換えない）", async () => {
    for (const bad of ["wrong", "nocookie", "expired"] as const) {
      const freee = new FakeFreee();
      const deps = makeDeps(freee);
      const start = await handleStart(req("/api/freee/start", { cookie: null }), deps);
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const sc = setCookies(start).find((c) => c.startsWith(STATE_COOKIE))!.split(";")[0];
      const q = new URLSearchParams({ code: "c", state: bad === "wrong" ? state.slice(0, -2) + "xx" : state });
      const later = bad === "expired" ? { ...deps, now: () => NOW + (settings.stateMinutes * 60 + 1) * 1000 } : deps;
      const cb = await handleCallback(req(`/api/freee/callback?${q}`, { method: "GET", cookie: bad === "nocookie" ? null : sc }), later);
      assert.equal(cb.headers.get("location"), "/accounting?freee=state#freee", bad);
      assert.equal(freee.calls.length, 0, `${bad}：鍵に換えない`);
      assert.ok(!setCookies(cb).some((c) => c.startsWith(`${TOKEN_COOKIE}=`) && !/Max-Age=0/.test(c)));
    }
  });

  test("テスト事業所以外を止める：鍵の返事の事業所の番号が FREEE_COMPANY_ID と違う・無い時は鍵を捨てる", async () => {
    const other = new FakeFreee();
    other.token = { ...other.token, company_id: 999 };
    const a = await startAndCallback(other);
    assert.equal(a.cb.headers.get("location"), "/accounting?freee=wrong-company#freee");
    assert.ok(!setCookies(a.cb).some((c) => c.startsWith(`${TOKEN_COOKIE}=`) && !/Max-Age=0/.test(c)), "鍵の cookie は置かない");

    const none = new FakeFreee();
    delete none.token.company_id;
    const b = await startAndCallback(none);
    assert.equal(b.cb.headers.get("location"), "/accounting?freee=no-company#freee");
    assert.ok(!setCookies(b.cb).some((c) => c.startsWith(`${TOKEN_COOKIE}=`) && !/Max-Age=0/.test(c)));

    // ブラウザから来た事業所の番号は使わない（戻り先の query に company_id があっても見ない）
    const fake = new FakeFreee();
    fake.token = { ...fake.token, company_id: 999 };
    const c = await startAndCallback(fake, {}, (q) => q.set("company_id", String(COMPANY)));
    assert.equal(c.cb.headers.get("location"), "/accounting?freee=wrong-company#freee");
  });

  test("FREEE_COMPANY_ID がまだ空の時だけ：受け取った事業所の番号を画面に出して、鍵は捨てて止める", async () => {
    const freee = new FakeFreee();
    freee.token = { ...freee.token, company_id: 4242 };
    const { cb } = await startAndCallback(freee, { FREEE_COMPANY_ID: "" });
    assert.equal(cb.status, 200);
    const html = await cb.text();
    assert.match(html, /4242/);
    assert.match(html, /鍵は捨てました/);
    assert.match(cb.headers.get("cache-control")!, /no-store/);
    assert.ok(!setCookies(cb).some((c) => c.startsWith(`${TOKEN_COOKIE}=`) && !/Max-Age=0/.test(c)));
    // 空の間は、ほかの窓口は動かない
    const r = await handleStatus(req("/api/freee/status", { method: "GET" }), makeDeps(freee, { FREEE_COMPANY_ID: "" }));
    assert.equal(r.status, 503);
  });

  test("どの窓口でも、この事業所かを確かめる：cookie の事業所が FREEE_COMPANY_ID と違えば止めて cookie を消す", async () => {
    const freee = new FakeFreee();
    for (const [h, path] of [
      [handleImport, "/api/freee/import"],
      [handleRegister, "/api/freee/register"],
      [handleCheck, "/api/freee/check"],
    ] as const) {
      const r = await h(req(path, { cookie: tokenCookie(999), body: { no: 1, use: "shop", nos: [1] } }), makeDeps(freee));
      assert.equal(r.status, 403, path);
      assert.equal((await bodyOf(r)).code, "wrong-company");
      assert.ok(setCookies(r).some((c) => c.startsWith(`${TOKEN_COOKIE}=;`)));
    }
    const s = await handleStatus(req("/api/freee/status", { method: "GET", cookie: tokenCookie(999) }), makeDeps(freee));
    assert.equal(s.status, 403);
    assert.equal(freee.calls.length, 0, "freee は呼ばない");
  });

  test("書きかえた cookie・別の鍵の cookie・使い道の違う cookie（state を鍵に）は受けない", async () => {
    const freee = new FakeFreee();
    const good = tokenCookie();
    const flipped = good.slice(0, -3) + (good.endsWith("A") ? "B" : "A") + good.slice(-2);
    const otherKey = `${TOKEN_COOKIE}=${seal(Buffer.alloc(32, 9), "token", { accessToken: "x", companyId: COMPANY, expiresAt: NOW + 1000 })}`;
    const wrongPurpose = `${TOKEN_COOKIE}=${seal(KEY, "state", { accessToken: "x", companyId: COMPANY, expiresAt: NOW + 1000 })}`;
    for (const c of [flipped, otherKey, wrongPurpose]) {
      const r = await handleStatus(req("/api/freee/status", { method: "GET", cookie: c }), makeDeps(freee));
      assert.equal(r.status, 401);
    }
    assert.equal((await handleStatus(req("/api/freee/status", { method: "GET", cookie: good }), makeDeps(freee))).status, 200);
  });

  test("鍵が切れたら「もう一度 freee とつなぐ」（自動の更新はしない）", async () => {
    const freee = new FakeFreee();
    const r = await handleStatus(req("/api/freee/status", { method: "GET", cookie: tokenCookie(COMPANY, NOW - 1) }), makeDeps(freee));
    assert.equal(r.status, 401);
    assert.equal((await bodyOf(r)).code, "expired");
    assert.equal(freee.calls.length, 0, "更新の鍵で取りなおさない");
    // freee が 401 を返した時も、切れた扱い
    const f2 = new FakeFreee();
    f2.fetch = async () => new Response(JSON.stringify({}), { status: 401 });
    const r2 = await handleImport(req("/api/freee/import"), makeDeps(f2));
    assert.equal(r2.status, 401);
    assert.equal((await bodyOf(r2)).code, "expired");
  });
});

describe("freee：守り（cookie・POST・本番のサイト・プレビュー）", () => {
  const handlers = [
    ["/api/freee/import", handleImport, "POST"],
    ["/api/freee/register", handleRegister, "POST"],
    ["/api/freee/check", handleCheck, "POST"],
    ["/api/freee/disconnect", handleDisconnect, "POST"],
    ["/api/freee/status", handleStatus, "GET"],
  ] as const;

  test("cookie が無い呼び出しは受けない（freee は呼ばない）", async () => {
    const freee = new FakeFreee();
    for (const [path, h, method] of handlers) {
      const r = await h(req(path, { method, cookie: null, body: method === "POST" ? { no: 1, use: "shop", nos: [1] } : undefined }), makeDeps(freee));
      assert.equal(r.status, 401, path);
      assert.equal((await bodyOf(r)).code, "no-cookie", path);
    }
    assert.equal(freee.calls.length, 0);
  });

  test("明細を入れる・登録する・読み直す・つなぎを外す・つなぐは POST だけ（GET は 405）", async () => {
    const freee = new FakeFreee();
    for (const [path, h] of [...handlers.filter((x) => x[2] === "POST").map((x) => [x[0], x[1]] as const), ["/api/freee/start", handleStart] as const]) {
      const r = await h(req(path, { method: "GET" }), makeDeps(freee));
      assert.equal(r.status, 405, path);
    }
    assert.equal((await handleStatus(req("/api/freee/status", { method: "POST" }), makeDeps(freee))).status, 405);
    assert.equal(freee.calls.length, 0);
  });

  test("本番のサイト（https://secretairy.vercel.app）から来た POST だけ受ける（Origin・Sec-Fetch-Site）", async () => {
    const freee = new FakeFreee();
    for (const [path, h, method] of handlers.filter((x) => x[2] === "POST")) {
      for (const origin of ["https://evil.example", "https://secretairy-git-x.vercel.app", "http://secretairy.vercel.app", null]) {
        const r = await h(req(path, { method, origin, body: { no: 1, use: "shop", nos: [1] } }), makeDeps(freee));
        assert.equal(r.status, 403, `${path} ${origin}`);
        assert.equal((await bodyOf(r)).code, "origin");
      }
      const cross = await h(req(path, { method, fetchSite: "cross-site", body: { no: 1, use: "shop", nos: [1] } }), makeDeps(freee));
      assert.equal(cross.status, 403);
    }
    const s = await handleStart(req("/api/freee/start", { cookie: null, origin: "https://evil.example" }), makeDeps(freee));
    assert.equal(s.status, 403);
    assert.equal(freee.calls.length, 0);
  });

  test("プレビューの URL・手元・本番の別の名前では、freee の窓口を全部止める", async () => {
    const freee = new FakeFreee();
    const all = [...handlers, ["/api/freee/start", handleStart, "POST"] as const, ["/api/freee/callback?code=x&state=y", handleCallback, "GET"] as const];
    for (const env of [{ VERCEL_ENV: "preview" }, { VERCEL_ENV: "development" }, { VERCEL_ENV: "" }]) {
      for (const [path, h, method] of all) {
        const r = await h(req(path, { method, body: method === "POST" ? { no: 1, use: "shop", nos: [1] } : undefined }), makeDeps(freee, env));
        assert.equal(r.status, 404, `${env.VERCEL_ENV} ${path}`);
        assert.equal((await bodyOf(r)).code, "off");
      }
    }
    // 本番の環境でも、本番のサイトの名前でなければ止める（Vercel の別の URL）
    for (const [path, h, method] of all) {
      const r = await h(req(path, { method, host: "secretairy-abc123.vercel.app", body: method === "POST" ? { no: 1 } : undefined }), makeDeps(freee));
      assert.equal(r.status, 404, path);
    }
    assert.equal(freee.calls.length, 0);
  });

  test("鍵がそろっていない（FREEE_COOKIE_KEY が32バイトでない など）時は止める", async () => {
    assert.equal(cookieKeyFrom(Buffer.alloc(16).toString("base64")), null);
    assert.equal(cookieKeyFrom(""), null);
    const freee = new FakeFreee();
    const deps = { ...makeDeps(freee), env: { ...makeDeps(freee).env, cookieKey: null } };
    assert.equal((await handleStart(req("/api/freee/start", { cookie: null }), deps)).status, 503);
    const noSecret = makeDeps(freee, { FREEE_CLIENT_SECRET: "" });
    assert.equal((await handleStart(req("/api/freee/start", { cookie: null }), noSecret)).status, 503);
  });

  test("つなぎを外す：鍵の cookie を消す", async () => {
    const r = await handleDisconnect(req("/api/freee/disconnect"), makeDeps(new FakeFreee()));
    assert.equal(r.status, 200);
    assert.ok(setCookies(r).some((c) => c.startsWith(`${TOKEN_COOKIE}=;`) && /Max-Age=0/.test(c)));
  });
});

describe("freee：口座（プログラムでは作らない）", () => {
  test("「SecretAIry カード」という名前の口座がちょうど1つの時だけ使う。0件・2件以上・カードでない時は止めて理由を出す", async () => {
    const card = { id: 1, name: settings.cardName, type: "credit_card" as const };
    assert.equal(pickCardAccount([card, { id: 2, name: "現金", type: "wallet" }], settings.cardName).ok, true);
    const zero = pickCardAccount([{ id: 2, name: "現金", type: "wallet" }], settings.cardName);
    const two = pickCardAccount([card, { ...card, id: 3 }], settings.cardName);
    const notCard = pickCardAccount([{ ...card, type: "bank_account" }], settings.cardName);
    assert.equal(zero.ok, false);
    assert.equal(two.ok, false);
    assert.equal(notCard.ok, false);
    if (!zero.ok) assert.match(zero.reason, /ありません/);
    if (!two.ok) assert.match(two.reason, /2つあります/);

    for (const list of [[], [card, { ...card, id: 3 }]]) {
      const freee = new FakeFreee();
      freee.walletables = list.map((w) => ({ ...w, bank_id: null, update_date: "2026-11-01" }));
      const r = await handleImport(req("/api/freee/import"), makeDeps(freee));
      assert.equal(r.status, 409);
      assert.equal((await bodyOf(r)).code, "card");
      const g = await handleRegister(req("/api/freee/register", { body: { no: SHOP_ITEM.no, use: "shop" } }), makeDeps(freee));
      assert.equal((await bodyOf(g)).result, "failed");
      assert.equal(freee.writes().length, 0, "口座を作らない・何も書かない");
    }
  });
});

describe("freee：明細を入れる（印で二重に入れない）", () => {
  test("20件を1件ずつ、出金・日付・金額・摘要の印つきで入れる。2回目は入れない", async () => {
    const freee = new FakeFreee();
    const r = await bodyOf(await handleImport(req("/api/freee/import"), makeDeps(freee)));
    assert.deepEqual({ created: r.created, existed: r.existed, check: r.check, stopped: r.stopped }, { created: items.length, existed: 0, check: 0, stopped: null });
    const posts = freee.writes();
    assert.equal(posts.length, items.length);
    for (const [i, c] of posts.entries()) {
      const b = c.body as Record<string, unknown>;
      assert.deepEqual(Object.keys(b).sort(), ["amount", "company_id", "date", "description", "entry_side", "walletable_id", "walletable_type"]);
      assert.equal(b.company_id, COMPANY, "事業所の番号はサーバーの物");
      assert.equal(b.entry_side, "expense");
      assert.equal(b.walletable_type, "credit_card");
      assert.equal(b.amount, items[i].amount);
      assert.equal(b.date, items[i].date);
      assert.ok(hasMark(b.description as string, mark(items[i].no)));
    }
    const again = await bodyOf(await handleImport(req("/api/freee/import"), makeDeps(freee)));
    assert.equal(again.created, 0);
    assert.equal(again.existed, items.length);
    assert.equal(freee.writes().length, items.length, "2回目は書かない");
  });

  test("途中で返事が途切れても、もう一度押すと読み直して残りだけ入れる", async () => {
    const freee = new FakeFreee();
    freee.dropCreateAt = 5;
    const first = await bodyOf(await handleImport(req("/api/freee/import"), makeDeps(freee)));
    assert.equal(first.created, 4);
    assert.equal(first.stopped.kind, "unknown");
    assert.equal(first.stopped.no, items[4].no);
    freee.dropCreateAt = null;
    const second = await bodyOf(await handleImport(req("/api/freee/import"), makeDeps(freee)));
    assert.equal(second.existed, 5, "途切れた1件も freee にあれば入れない");
    assert.equal(second.created, items.length - 5);
    assert.equal(freee.txns.length, items.length, "二重に入っていない");
  });

  test("印は「…:1」と「…:10」を取りちがえない。ほかの口座・ほかの事業所の明細は数えない", () => {
    assert.equal(hasMark(`A ${mark(10)}`, mark(1)), false);
    assert.equal(hasMark(`A ${mark(1)}`, mark(1)), true);
    const i = item(1);
    const base: WalletTxn = { id: 1, company_id: COMPANY, date: i.date, amount: i.amount, due_amount: i.amount, entry_side: "expense", walletable_type: "credit_card", walletable_id: 11, description: mark(1), status: 1 };
    assert.equal(lookup([{ ...base, walletable_id: 12 }], { companyId: COMPANY, walletableId: 11, mark: mark(1), item: i }).kind, "missing");
    assert.equal(lookup([{ ...base, company_id: 5 }], { companyId: COMPANY, walletableId: 11, mark: mark(1), item: i }).kind, "missing");
  });

  test("明細はページをめくって全部読む（100件ずつ）", async () => {
    const freee = new FakeFreee();
    for (let k = 0; k < 230; k++) freee.txns.push({ id: 10_000 + k, company_id: COMPANY, date: "2026-09-01", amount: 100, due_amount: 100, entry_side: "expense", walletable_type: "credit_card", walletable_id: 11, description: "ほかの明細", status: 1 });
    freee.addTxn(SHOP_ITEM.no);
    const r = await bodyOf(await handleRegister(req("/api/freee/register", { body: { no: SHOP_ITEM.no, use: "shop" } }), makeDeps(freee)));
    assert.equal(r.result, "registered");
    const pages = freee.calls.filter((c) => c.path === "/api/1/wallet_txns" && c.method === "GET");
    assert.deepEqual(pages.map((c) => c.query.get("offset")), ["0", "100", "200"]);
    assert.ok(pages.every((c) => c.query.get("limit") === String(settings.pageLimit) && c.query.get("company_id") === String(COMPANY)));
  });
});

describe("freee：登録（状態の分け方）", () => {
  const t = (patch: Partial<WalletTxn>, i: CardItem = item(1)): WalletTxn => ({
    id: 1,
    company_id: COMPANY,
    date: i.date,
    amount: i.amount,
    due_amount: i.amount,
    entry_side: "expense",
    walletable_type: "credit_card",
    walletable_id: 11,
    description: mark(i.no),
    status: 1,
    ...patch,
  });
  const v = (txns: WalletTxn[]) => verdictOf(lookup(txns, { companyId: COMPANY, walletableId: 11, mark: mark(1), item: item(1) })).kind;

  test("表のとおり：未処理で登録待ち＝金額 → 登録する／処理済みで登録待ち0 → 処理済み／無視・一部・値が合わない・候補2件 → 確かめが要る", () => {
    const amount = item(1).amount;
    assert.equal(v([t({})]), "ready");
    assert.equal(v([t({ status: 2, due_amount: 0 })]), "done");
    assert.equal(v([t({ status: 3 })]), "check", "無視");
    assert.equal(v([t({ status: 4, due_amount: amount - 100 })]), "check", "一部だけ登録");
    assert.equal(v([t({ status: 6 })]), "check", "対象外");
    assert.equal(v([t({ due_amount: amount - 1 })]), "check", "未処理なのに登録待ちが合わない");
    assert.equal(v([t({ status: 2, due_amount: 5 })]), "check", "処理済みなのに登録待ちが残る");
    assert.equal(v([t({ amount: amount + 1, due_amount: amount + 1 })]), "check", "金額");
    assert.equal(v([t({ date: "2026-01-01" })]), "check", "日付");
    assert.equal(v([t({ entry_side: "income" })]), "check", "入金");
    assert.equal(v([t({}), t({ id: 2 })]), "check", "候補2件");
    assert.equal(v([]), "missing");
  });

  test("店用：create_deal に内訳1行（明細の金額・科目1つ・税区分1つ）。取引の番号は配列で返る", async () => {
    const freee = new FakeFreee();
    const tx = freee.addTxn(SHOP_ITEM.no);
    const r = await bodyOf(await handleRegister(req("/api/freee/register", { body: { no: SHOP_ITEM.no, use: "shop", amount: 1 } }), makeDeps(freee)));
    assert.equal(r.result, "registered");
    assert.deepEqual(r.dealIds, [7000 + tx.id]);
    const w = freee.writes();
    assert.equal(w.length, 1);
    assert.equal(w[0].path, `/api/1/wallet_txns/${tx.id}/create_deal`);
    assert.deepEqual(w[0].body, { company_id: COMPANY, deal_lines: [{ amount: SHOP_ITEM.amount, account_item_id: 501, tax_code: 136 }] }, "金額は明細のまま（ブラウザの数は使わない）");
  });

  test("私用：create_private_deal（事業所の番号だけ）。取引の番号は1つで返る", async () => {
    const freee = new FakeFreee();
    const tx = freee.addTxn(PRIVATE_ITEM.no);
    const r = await bodyOf(await handleRegister(req("/api/freee/register", { body: { no: PRIVATE_ITEM.no, use: "private" } }), makeDeps(freee)));
    assert.deepEqual(r.dealIds, [8000 + tx.id]);
    const w = freee.writes();
    assert.equal(w[0].path, `/api/1/wallet_txns/${tx.id}/create_private_deal`);
    assert.deepEqual(w[0].body, { company_id: COMPANY });
  });

  test("処理済み → 「freee で処理済み」（送り直さない）・候補2件 → 止める・無視 → 止める", async () => {
    const done = new FakeFreee();
    done.addTxn(SHOP_ITEM.no, { status: 2, due_amount: 0 });
    assert.equal((await bodyOf(await handleRegister(req("/api/freee/register", { body: { no: SHOP_ITEM.no, use: "shop" } }), makeDeps(done)))).result, "already");
    assert.equal(done.writes().length, 0);

    const two = new FakeFreee();
    two.addTxn(SHOP_ITEM.no);
    two.addTxn(SHOP_ITEM.no);
    const r2 = await bodyOf(await handleRegister(req("/api/freee/register", { body: { no: SHOP_ITEM.no, use: "shop" } }), makeDeps(two)));
    assert.equal(r2.result, "check");
    assert.match(r2.reason, /2件/);
    assert.equal(two.writes().length, 0);

    const ignored = new FakeFreee();
    ignored.addTxn(SHOP_ITEM.no, { status: 3 });
    assert.equal((await bodyOf(await handleRegister(req("/api/freee/register", { body: { no: SHOP_ITEM.no, use: "shop" } }), makeDeps(ignored)))).result, "check");
    assert.equal(ignored.writes().length, 0);
  });

  test("科目・税区分は freee から名前で引き、1つに決まらなければ止める", async () => {
    for (const patch of [(f: FakeFreee) => (f.accountItems = []), (f: FakeFreee) => f.accountItems.push({ id: 503, name: settings.accountItemName, available: true }), (f: FakeFreee) => (f.taxes = f.taxes.map((x) => ({ ...x, available: false })))]) {
      const freee = new FakeFreee();
      freee.addTxn(SHOP_ITEM.no);
      patch(freee);
      const r = await bodyOf(await handleRegister(req("/api/freee/register", { body: { no: SHOP_ITEM.no, use: "shop" } }), makeDeps(freee)));
      assert.equal(r.result, "failed");
      assert.equal(freee.writes().length, 0);
    }
  });

  test("店用／私用の選びが購入先の自動のルールと合わない・無い明細の番号は受けない", async () => {
    const freee = new FakeFreee();
    freee.addTxn(SHOP_ITEM.no);
    assert.equal((await handleRegister(req("/api/freee/register", { body: { no: SHOP_ITEM.no, use: "private" } }), makeDeps(freee))).status, 400);
    assert.equal((await handleRegister(req("/api/freee/register", { body: { no: 999, use: "shop" } }), makeDeps(freee))).status, 400);
    assert.equal(freee.writes().length, 0);
  });

  test("送った後に返事が途切れた → 「結果が分からない」（freee の中では済んでいても、送り直さない）", async () => {
    const freee = new FakeFreee();
    freee.dropOn = "create_deal";
    freee.addTxn(SHOP_ITEM.no);
    const r = await bodyOf(await handleRegister(req("/api/freee/register", { body: { no: SHOP_ITEM.no, use: "shop" } }), makeDeps(freee)));
    assert.equal(r.result, "unknown");
    assert.equal(freee.writes().length, 1);
    // 500 台も同じ
    const f5 = new FakeFreee();
    f5.addTxn(SHOP_ITEM.no);
    const base = f5.fetch;
    f5.fetch = async (input, init) => (/create_deal/.test(input) ? new Response("oops", { status: 502 }) : base(input, init));
    assert.equal((await bodyOf(await handleRegister(req("/api/freee/register", { body: { no: SHOP_ITEM.no, use: "shop" } }), makeDeps(f5)))).result, "unknown");
  });

  test("売上・お客様・カルテ・予約のデータは送らない（送るのは明細の日付・購入先（架空）・金額・印と、科目・税区分の番号だけ）", async () => {
    const freee = new FakeFreee();
    await handleImport(req("/api/freee/import"), makeDeps(freee));
    for (const no of items.map((i) => i.no)) {
      const use = seed.rules.find((r) => r.merchantId === item(no).merchantId)?.use ?? "shop";
      await handleRegister(req("/api/freee/register", { body: { no, use } }), makeDeps(freee));
    }
    const sent = JSON.stringify(freee.calls.map((c) => c.body));
    for (const word of ["sales", "visits", "customer", "karte", "reservation", "現金", "コード決済"]) assert.ok(!sent.includes(word), word);
  });
});

// ---- ブラウザの側（1件ずつ順に送る・送り直さない・送っている間は戻せない） ----

describe("freee：画面の記録と流れ", () => {
  const g = globalThis as { window?: unknown };
  let had: unknown;
  let store: Map<string, string>;
  beforeEach(() => {
    had = g.window;
    store = new Map();
    g.window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
      addEventListener() {},
      removeEventListener() {},
    };
  });
  afterEach(() => {
    g.window = had;
  });

  /** 画面の窓口の呼び出しを、本当の窓口（handleRegister / handleCheck）とテストの中の freee につなぐ */
  /**
   * 画面の窓口の呼び出しを、本当の窓口（handleImport / handleRegister / handleCheck）とテストの中の freee につなぐ。
   * box：記録の置き場所（2つのタブで同じ物を渡すと、同じブラウザの localStorage のつもり）。locks：タブどうしの排他。
   */
  function wire(
    freee: FakeFreee,
    opts: {
      during?: (rec: FreeeRecord) => void;
      transport?: (path: string, body: unknown) => Promise<{ status: number; body: unknown }> | null;
      realClock?: boolean;
      box?: { rec: FreeeRecord };
      locks?: LockLike | null;
      clock?: { ms: number };
    } = {},
  ) {
    const box = opts.box ?? { rec: EMPTY_FREEE };
    const clock = opts.clock ?? { ms: opts.realClock ? Date.now() : NOW };
    const sent: { path: string; body: unknown }[] = [];
    const post: Post = async (path, body) => {
      sent.push({ path, body });
      opts.during?.(box.rec);
      const t = opts.transport?.(path, body);
      if (t) return t;
      const h = path === "/api/freee/register" ? handleRegister : path === "/api/freee/import" ? handleImport : handleCheck;
      const r = await h(req(path, { body }), makeDeps(freee));
      return { status: r.status, body: await r.json() };
    };
    const deps: RunDeps = {
      read: () => box.rec,
      write: (r) => (box.rec = r),
      post,
      now: () => new Date((clock.ms += 1000)),
      staleSeconds: settings.sendingStaleSeconds,
      locks: opts.locks ?? null,
      importWaitSeconds: settings.importUnknownWaitSeconds,
      maxImportCalls: settings.maxImportCalls,
    };
    return { deps, sent, clock, get rec() { return box.rec; }, set rec(r: FreeeRecord) { box.rec = r; } };
  }

  const usesAll = () => {
    const out: Record<string, "shop" | "private"> = {};
    for (const i of items) out[String(i.no)] = seed.rules.find((r) => r.merchantId === i.merchantId)?.use ?? "shop";
    return out;
  };
  const nos = items.map((i) => i.no);

  test("1件ずつ順に送り、登録した・もう処理済みを分ける。送り始めたら選びを固定する", async () => {
    const freee = new FakeFreee();
    await handleImport(req("/api/freee/import"), makeDeps(freee));
    freee.txns.find((x) => hasMark(x.description, mark(2)))!.status = 2;
    freee.txns.find((x) => hasMark(x.description, mark(2)))!.due_amount = 0;
    const w = wire(freee);
    const out = await runRegister(w.deps, { uses: usesAll(), nos });
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.equal(out.run.registered, items.length - 1);
    assert.equal(out.run.already, 1);
    assert.equal(stateOf(w.rec, 2), "already");
    assert.equal(stateOf(w.rec, 1), "registered");
    assert.deepEqual(w.sent.map((s) => (s.body as { no: number }).no), nos, "明細の順に1件ずつ");
    assert.equal(w.rec.sendingAt, null);
    assert.ok(w.rec.uses);
    // 固定した後は、新しい選びを渡しても固定した方を使う
    const changed = { ...usesAll(), "1": "private" as const };
    const again = withRunStart(w.rec, changed, "2026-11-05T04:00:00.000Z");
    assert.equal(again.uses!["1"], usesAll()["1"]);
  });

  test("結果が分からない時：そこで止め、次の「登録」でも送り直さない。読み直した後でだけ決める", async () => {
    const freee = new FakeFreee();
    await handleImport(req("/api/freee/import"), makeDeps(freee));
    const first = items[0].no;
    let dropped = false;
    const w = wire(freee, {
      transport: (path, body) => {
        // 1件目は freee の中では済んだが、返事が途切れた
        if (path === "/api/freee/register" && (body as { no: number }).no === first && !dropped) {
          dropped = true;
          const tx = freee.txns.find((x) => hasMark(x.description, mark(first)))!;
          tx.status = 2;
          tx.due_amount = 0;
          return Promise.reject(new TypeError("network"));
        }
        return null;
      },
    });
    const out = await runRegister(w.deps, { uses: usesAll(), nos });
    assert.ok(out.ok && out.stoppedBy);
    assert.equal(stateOf(w.rec, first), "unknown");
    assert.equal(stateOf(w.rec, items[1].no), "pending", "止めた後は送らない");
    const sentBefore = w.sent.length;
    await runRegister(w.deps, { uses: usesAll(), nos });
    assert.ok(!w.sent.slice(sentBefore).some((s) => s.path === "/api/freee/register" && (s.body as { no: number }).no === first), "結果が分からない明細は送り直さない");
    // 読み直すと「もう処理済み」
    const c = await runCheck(w.deps, [first]);
    assert.ok(c.ok);
    assert.equal(stateOf(w.rec, first), "already");
    // 途切れた1件（freee の中では済んだ）は送り直していない。ほかは1回ずつ
    const creates = freee.writes().filter((x) => /create_/.test(x.path)).map((x) => x.path);
    assert.equal(creates.length, items.length - 1);
    assert.equal(new Set(creates).size, creates.length, "1件も二重に登録していない");
  });

  test("サーバーが 500 台・読めない返事の時も「結果が分からない」。つなぎが切れた時は「失敗」で止める（会計に切り替えない）", async () => {
    const freee = new FakeFreee();
    await handleImport(req("/api/freee/import"), makeDeps(freee));
    const w5 = wire(freee, { transport: () => Promise.resolve({ status: 504, body: null }) });
    await runRegister(w5.deps, { uses: usesAll(), nos });
    assert.equal(stateOf(w5.rec, items[0].no), "unknown");
    const w4 = wire(freee, { transport: (path) => (path === "/api/freee/register" ? Promise.resolve({ status: 401, body: { ok: false, code: "expired", message: "freee の鍵が切れました" } }) : null) });
    const out = await runRegister(w4.deps, { uses: usesAll(), nos });
    assert.ok(out.ok && out.stoppedBy);
    assert.equal(stateOf(w4.rec, items[0].no), "failed");
    assert.equal(stateOf(w4.rec, items[1].no), "pending");
  });

  test("送っている間は戻せない：送っている印があれば「最初に戻す」を止め、ほかの画面からは始めない", async () => {
    const { freeeSendingNow } = await import("../useFreee");
    const freee = new FakeFreee();
    await handleImport(req("/api/freee/import"), makeDeps(freee));
    const seen: boolean[] = [];
    const w = wire(freee, {
      during: () => {
        // 送っている間に、画面（ResetBook）が見る印
        store.set(BROWSER_PREFIX + FREEE_KEY, JSON.stringify(w.rec));
        seen.push(freeeSendingNow());
      },
      realClock: true,
    });
    await runRegister(w.deps, { uses: usesAll(), nos: nos.slice(0, 3) });
    assert.ok(seen.length >= 3 && seen.every(Boolean), "送っている間はずっと止める");
    store.set(BROWSER_PREFIX + FREEE_KEY, JSON.stringify(w.rec));
    assert.equal(freeeSendingNow(), false, "終わったら戻せる");

    // ほかの画面で送っている（印が新しい）時は始めない
    const busy = wire(freee);
    busy.rec = { ...EMPTY_FREEE, sendingAt: new Date(NOW + 500).toISOString() };
    const r = await runRegister(busy.deps, { uses: usesAll(), nos });
    assert.equal(r.ok, false);
    assert.equal(busy.sent.length, 0);
    assert.ok(isSending(busy.rec, NOW + 2000, settings.sendingStaleSeconds));
  });

  test("送っている途中で画面が止まった（印が古い）時：「送っている」は「結果が分からない」にする", () => {
    const rec: FreeeRecord = { ...EMPTY_FREEE, uses: {}, sendingAt: "2026-11-05T00:00:00.000Z", items: { "3": { state: "sending", at: "2026-11-05T00:00:00.000Z" } } };
    const r = withStaleRecovered(rec, Date.parse("2026-11-05T01:00:00.000Z"), settings.sendingStaleSeconds, "2026-11-05T01:00:00.000Z");
    assert.equal(stateOf(r, 3), "unknown");
    assert.equal(r.sendingAt, null);
    // 形のおかしい記録は落とす
    assert.deepEqual(parseFreee('{"items":{"x":{"state":"done"}}}').items, {});
  });

  // ---- レビューの直し：取り合いを止める鍵・明細を入れる時の時間切れ・読み込み直し・読み直しの競合 ----

  class FakeLocks implements LockLike {
    held = new Set<string>();
    async request<T>(name: string, _o: { ifAvailable: true }, cb: (lock: unknown | null) => Promise<T>): Promise<T> {
      if (this.held.has(name)) return cb(null);
      this.held.add(name);
      try {
        return await cb({ name });
      } finally {
        this.held.delete(name);
      }
    }
  }
  const deferred = () => {
    let resolve!: () => void;
    const p = new Promise<void>((r) => (resolve = r));
    return { p, resolve };
  };
  const real = async (freee: FakeFreee, path: string, body: unknown) => {
    const h = path === "/api/freee/register" ? handleRegister : path === "/api/freee/import" ? handleImport : handleCheck;
    const r = await h(req(path, { body }), makeDeps(freee));
    return { status: r.status, body: (await r.json()) as unknown };
  };

  test("取り合いを止める鍵：明細を入れる・登録（前の読み直しから終わるまで）・読み直す・最初に戻すは、同じ排他。ほかのタブは始めない", async () => {
    const freee = new FakeFreee();
    const locks = new FakeLocks();
    const box = { rec: EMPTY_FREEE };
    const gate = deferred();
    // タブ A：明細を入れている途中（返事を待っている）
    const a = wire(freee, { box, locks, transport: (path, body) => gate.p.then(() => real(freee, path, body)) });
    const running = pressImport(a.deps);
    await Promise.resolve();
    // タブ B：同じブラウザのほかのタブ
    const b = wire(freee, { box, locks });
    for (const r of [await pressImport(b.deps), await pressRegister(b.deps, { uses: usesAll(), nos }), await pressCheck(b.deps, nos)]) {
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, BUSY_REASON);
    }
    let resetRan = false;
    const reset = await withFreeeLock(locks, async () => (resetRan = true));
    assert.equal(resetRan, false, "やりとりしている間は「最初に戻す」も動かない");
    assert.equal((reset as { ok: boolean }).ok, false);
    assert.equal(b.sent.length, 0, "タブ B は何も送っていない");
    gate.resolve();
    const done = await running;
    assert.ok(done.ok && done.done);
    assert.equal(freee.txns.length, items.length);
    // 終わったら、ほかのタブも始められる
    assert.ok((await pressCheck(b.deps, [1])).ok);

    // 登録の前の読み直しから、登録が終わるまで排他を持つ
    const gate2 = deferred();
    const c = wire(freee, { box, locks, transport: (path, body) => (path === "/api/freee/check" ? gate2.p.then(() => real(freee, path, body)) : null) });
    const reg = pressRegister(c.deps, { uses: usesAll(), nos: nos.slice(0, 2) });
    await Promise.resolve();
    const other = await pressRegister(b.deps, { uses: usesAll(), nos: nos.slice(0, 2) });
    assert.equal(other.ok, false);
    gate2.resolve();
    const out = await reg;
    assert.ok(out.ok);
    assert.equal(freee.writes().filter((x) => /create_/.test(x.path)).length, 2, "二重に登録していない");
  });

  for (const mode of ["つながらない", "504", "読めない返事", "200 でも中が「結果が分からない」"] as const) {
    test(`明細を入れる：${mode} → 「結果が分からない」で待つ期限を残し（読み込み直しても残る）、期限の後は読み直して、まだ無い物だけ入れる`, async () => {
      const freee = new FakeFreee();
      if (mode === "200 でも中が「結果が分からない」") freee.dropCreateAt = 7;
      let first = true;
      const w = wire(freee, {
        locks: new FakeLocks(),
        transport: (path, body) => {
          if (!first || mode === "200 でも中が「結果が分からない」") return null;
          first = false;
          // サーバーは freee に書いた（20件）が、返事が画面に届かなかった
          return real(freee, path, body).then(() => {
            if (mode === "つながらない") throw new TypeError("network");
            if (mode === "504") return { status: 504, body: null };
            return { status: 200, body: null };
          });
        },
      });
      const r1 = await pressImport(w.deps);
      assert.ok(r1.ok && r1.holdUntil, "待つ期限を出す");
      // 読み込み直しても残る（記録に保存）
      const reloaded = parseFreee(JSON.stringify(w.rec));
      assert.ok(reloaded.importHold);
      assert.ok(importHeld(reloaded, w.clock.ms));
      // 期限の前は、押しても呼ばない
      const sentBefore = w.sent.length;
      const r2 = await pressImport(w.deps);
      assert.equal(r2.ok, false);
      assert.equal(w.sent.length, sentBefore);
      // 期限の後：読み直して、まだ無い物だけ入れる（書き終わったとは見なさない）
      freee.dropCreateAt = null;
      w.clock.ms += settings.importUnknownWaitSeconds * 1000;
      const r3 = await pressImport(w.deps);
      assert.ok(r3.ok && r3.done);
      assert.equal(w.rec.importHold, null);
      assert.equal(freee.txns.length, items.length, "同じ印の明細を2件にしない");
      for (const i of items) assert.equal(freee.txns.filter((x) => hasMark(x.description, mark(i.no))).length, 1, `${i.no}番`);
    });
  }

  test("明細を入れる：サーバーにも持ち時間。返事の時間を残して次の書き込みを止め、そこまでの結果を返す。画面が続きを呼ぶ", async () => {
    const freee = new FakeFreee();
    freee.serverNow = NOW;
    const base = freee.fetch;
    freee.fetch = async (input, init) => {
      freee.serverNow! += 4000; // freee の1回の呼び出しに4秒
      return base(input, init);
    };
    // 1回の呼び出し：持ち時間の中で止める
    const t0 = freee.serverNow;
    const one = await bodyOf(await handleImport(req("/api/freee/import"), makeDeps(freee)));
    assert.equal(one.done, false);
    assert.equal(one.stopped.kind, "time");
    assert.ok(one.created > 0 && one.created < items.length);
    assert.ok(freee.serverNow - t0 <= settings.serverBudgetSeconds * 1000, "持ち時間の中で返事をする");
    // 画面が続きを呼ぶ
    const w = wire(freee, { locks: new FakeLocks() });
    const r = await pressImport(w.deps);
    assert.ok(r.ok && r.done);
    assert.ok(w.sent.length >= 2, "続けて呼んだ");
    assert.equal(r.holdUntil, null, "区切っただけなので、待つ期限は出さない");
    assert.equal(freee.txns.length, items.length);
    // 登録も、持ち時間が足りない時は送らない
    const late = new FakeFreee();
    late.addTxn(SHOP_ITEM.no);
    late.serverNow = NOW;
    const lb = late.fetch;
    late.fetch = async (input, init) => {
      late.serverNow! += 10_000;
      return lb(input, init);
    };
    const g = await bodyOf(await handleRegister(req("/api/freee/register", { body: { no: SHOP_ITEM.no, use: "shop" } }), makeDeps(late)));
    assert.equal(g.result, "failed");
    assert.equal(late.writes().length, 0);
  });

  test("読み込み直した時の「送っている」：排他が空いていれば「結果が分からない」に。同じ押しでは読み直しにも入れず、送らない", async () => {
    const freee = new FakeFreee();
    await handleImport(req("/api/freee/import"), makeDeps(freee));
    const locks = new FakeLocks();
    const w = wire(freee, { locks });
    // 送っている途中で読み込み直した（印はまだ新しい）
    const fresh = new Date(w.clock.ms).toISOString();
    w.rec = { ...EMPTY_FREEE, uses: usesAll(), sendingAt: fresh, items: { "3": { state: "sending", at: fresh } } };
    await recoverIfIdle(w.deps);
    assert.equal(stateOf(w.rec, 3), "unknown");
    assert.equal(w.rec.sendingAt, null);

    // 直していない記録のまま登録を押しても、3番は読み直しにも登録にも入らない
    w.rec = { ...EMPTY_FREEE, uses: usesAll(), sendingAt: fresh, items: { "3": { state: "sending", at: fresh } } };
    const out = await pressRegister(w.deps, { uses: usesAll(), nos });
    assert.ok(out.ok);
    const checked = w.sent.filter((s) => s.path === "/api/freee/check").flatMap((s) => (s.body as { nos: number[] }).nos);
    assert.ok(!checked.includes(3), "読み直しに入れない");
    assert.ok(!w.sent.some((s) => s.path === "/api/freee/register" && (s.body as { no: number }).no === 3), "送らない");
    assert.equal(stateOf(w.rec, 3), "unknown");
    // もう一度押しても送らない。「freee から読み直す」の後でだけ送る
    await pressRegister(w.deps, { uses: usesAll(), nos });
    assert.ok(!w.sent.some((s) => s.path === "/api/freee/register" && (s.body as { no: number }).no === 3));
    assert.ok((await pressCheck(w.deps, [3])).ok);
    assert.equal(stateOf(w.rec, 3), "pending");
    await pressRegister(w.deps, { uses: usesAll(), nos });
    assert.equal(stateOf(w.rec, 3), "registered");
  });

  test("読み直しの競合：遅れて届いた読み直しの答えは、読み直しを始めた後の記録（登録した）を「まだ」に戻さない", async () => {
    const freee = new FakeFreee();
    const w = wire(freee, {
      transport: (path) => {
        if (path !== "/api/freee/check") return null;
        // 読み直しの答えが届く前に、ほかの画面が1番を登録した
        w.rec = withItem(w.rec, 1, { state: "registered", dealIds: [42] }, new Date((w.clock.ms += 1000)).toISOString());
        return Promise.resolve({ status: 200, body: { ok: true, items: [{ no: 1, kind: "ready" }, { no: 2, kind: "done" }], setup: null } });
      },
    });
    const r = await runCheck(w.deps, [1, 2]);
    assert.ok(r.ok);
    assert.equal(stateOf(w.rec, 1), "registered", "上書きしない");
    assert.deepEqual(w.rec.items["1"].dealIds, [42]);
    assert.equal(stateOf(w.rec, 2), "already");
    // 関数そのもの：始めた時刻より古い記録だけ書きかえる
    const old = withItem(EMPTY_FREEE, 5, { state: "failed", reason: "x" }, "2026-11-05T00:00:00.000Z");
    assert.equal(stateOf(withChecked(old, [{ no: 5, kind: "ready" }], "2026-11-05T02:00:00.000Z", Date.parse("2026-11-05T01:00:00.000Z")), 5), "pending");
    assert.equal(stateOf(withChecked(old, [{ no: 5, kind: "ready" }], "2026-11-05T02:00:00.000Z", Date.parse("2026-11-04T23:00:00.000Z")), 5), "failed");
  });

  test("同じ押しの中で「確かめが要る」「明細が無い」になった明細は送らず、件数だけ返す", async () => {
    const freee = new FakeFreee();
    await handleImport(req("/api/freee/import"), makeDeps(freee));
    freee.txns.find((x) => hasMark(x.description, mark(2)))!.status = 3; // 無視
    freee.txns = freee.txns.filter((x) => !hasMark(x.description, mark(4))); // 明細が無い
    const w = wire(freee, { locks: new FakeLocks() });
    const out = await pressRegister(w.deps, { uses: usesAll(), nos });
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.deepEqual(out.skipped, { check: 1, missing: 1 });
    const sentNos = w.sent.filter((s) => s.path === "/api/freee/register").map((s) => (s.body as { no: number }).no);
    assert.ok(!sentNos.includes(2) && !sentNos.includes(4));
    assert.equal(out.run.registered, items.length - 2);
    // 送る物が無い押し：登録0件（画面は日誌を書かない）
    const again = await pressRegister(w.deps, { uses: usesAll(), nos });
    assert.ok(again.ok && again.run.registered === 0);
  });

  test("最初に戻す：画面の記録は戻すが、「結果が分からない」の明細と、明細を入れるのを待つ期限は残す", () => {
    const now = Date.parse("2026-11-05T05:00:00.000Z");
    const rec: FreeeRecord = {
      ...EMPTY_FREEE,
      uses: { "1": "shop" },
      items: { "1": { state: "registered", at: "x", dealIds: [1] }, "5": { state: "unknown", at: "x" } },
      importHold: { until: "2026-11-05T05:01:00.000Z", reason: "r" },
    };
    const w = resetAllWrites("2026-11-05", null, JSON.stringify(rec), now).find((x) => x.key === FREEE_KEY)!;
    const kept = parseFreee(w.value);
    assert.equal(kept.uses, null, "選びは戻す");
    assert.equal(stateOf(kept, 1), "pending");
    assert.equal(stateOf(kept, 5), "unknown");
    assert.ok(kept.importHold);
    assert.equal(keptOnReset({ ...rec, items: {}, importHold: { until: "2026-11-05T04:00:00.000Z", reason: "" } }, now), null);
  });

  test("明細は期間（start_date／end_date）で読み、明細の番号で重なりを除く。読み直しは科目・税区分が1つに決まるかも返す", async () => {
    const freee = new FakeFreee();
    const tx = freee.addTxn(SHOP_ITEM.no);
    freee.txns.push(tx); // 同じ明細が2回返ってきた
    const r = await bodyOf(await handleRegister(req("/api/freee/register", { body: { no: SHOP_ITEM.no, use: "shop" } }), makeDeps(freee)));
    assert.equal(r.result, "registered", "重なりは1件として数える（候補2件にしない）");
    const q = freee.calls.find((c) => c.path === "/api/1/wallet_txns" && c.method === "GET")!.query;
    assert.equal(q.get("start_date"), seed.statement.from);
    assert.equal(q.get("end_date"), seed.statement.to);
    const c = await bodyOf(await handleCheck(req("/api/freee/check", { body: { nos: [SHOP_ITEM.no] } }), makeDeps(freee)));
    assert.deepEqual(c.setup, { card: settings.cardName, accountItem: { name: settings.accountItemName, count: 1 }, tax: { name: settings.taxName, count: 1 } });
    freee.accountItems.push({ id: 503, name: settings.accountItemName, available: true });
    const c2 = await bodyOf(await handleCheck(req("/api/freee/check", { body: { nos: [SHOP_ITEM.no] } }), makeDeps(freee)));
    assert.equal(c2.setup.accountItem.count, 2);
    assert.equal(freee.writes().filter((x) => /create_/.test(x.path)).length, 1, "読み直しは書かない");
  });
});

// ---- 本番で見つかった直し：cookie が無い・切れた時は「つながっていない」（環境変数が欠けている時と分ける） ----

describe("freee：つながっているか（cookie が無い・切れた時と、環境変数が欠けている時を分ける）", () => {
  test("環境変数がそろっていて cookie が無い → 401「つながっていない」・canConnect（503 の「環境変数がそろっていません」にしない）", async () => {
    const freee = new FakeFreee();
    const r = await handleStatus(req("/api/freee/status", { method: "GET", cookie: null }), makeDeps(freee));
    assert.equal(r.status, 401);
    const b = await bodyOf(r);
    assert.equal(b.code, "no-cookie");
    assert.equal(b.canConnect, true);
    assert.equal(b.missing, undefined);
    assert.equal(freee.calls.length, 0);
    // 同じ環境変数で、つなぐ窓口も動く
    assert.equal((await handleStart(req("/api/freee/start", { cookie: null }), makeDeps(freee))).status, 303);
  });

  test("鍵が切れた cookie・読めない cookie → 401「つながっていない」・canConnect。cookie は消す", async () => {
    const freee = new FakeFreee();
    const expired = await handleStatus(req("/api/freee/status", { method: "GET", cookie: tokenCookie(COMPANY, NOW - 1) }), makeDeps(freee));
    assert.equal(expired.status, 401);
    const e = await bodyOf(expired);
    assert.equal(e.code, "expired");
    assert.equal(e.canConnect, true);
    assert.ok(setCookies(expired).some((c) => c.startsWith(`${TOKEN_COOKIE}=;`) && /Max-Age=0/.test(c)));
    const broken = await handleStatus(req("/api/freee/status", { method: "GET", cookie: `${TOKEN_COOKIE}=1.AAAA` }), makeDeps(freee));
    assert.equal(broken.status, 401);
    assert.equal((await bodyOf(broken)).canConnect, true);
  });

  test("環境変数が本当に欠けている時：cookie が無ければ「つながっていない」＋ canConnect: false と読めていない名前（中身は出さない）", async () => {
    const freee = new FakeFreee();
    for (const [env, name] of [
      [{ FREEE_CLIENT_ID: "" }, "FREEE_CLIENT_ID"],
      [{ FREEE_CLIENT_SECRET: "" }, "FREEE_CLIENT_SECRET"],
      [{ FREEE_COOKIE_KEY: Buffer.alloc(16, 1).toString("base64") }, "FREEE_COOKIE_KEY（32バイトを base64 にした文字ではない）"],
      [{ FREEE_COMPANY_ID: "12a" }, "FREEE_COMPANY_ID（数ではない）"],
    ] as const) {
      const deps = makeDeps(freee, env);
      const r = await handleStatus(req("/api/freee/status", { method: "GET", cookie: null }), deps);
      assert.equal(r.status, 401, name);
      const b = await bodyOf(r);
      assert.equal(b.code, "no-cookie");
      assert.equal(b.canConnect, false);
      assert.deepEqual(b.missing, [name]);
      assert.ok(!JSON.stringify(b).includes("csecret") && !JSON.stringify(b).includes(KEY_B64), "中身は出さない");
      // つなぐ窓口は、欠けていれば今までどおり 503（名前つき）
      const s = await handleStart(req("/api/freee/start", { cookie: null }), deps);
      assert.equal(s.status, 503);
      assert.deepEqual((await bodyOf(s)).missing, [name]);
    }
    // FREEE_COOKIE_KEY が無い時は「無い」
    const none = makeDeps(freee);
    const r = await handleStatus(req("/api/freee/status", { method: "GET", cookie: null }), { ...none, env: { ...none.env, cookieKey: null, cookieKeyGiven: false } });
    assert.deepEqual((await bodyOf(r)).missing, ["FREEE_COOKIE_KEY"]);
  });

  test("cookie がある時は今までどおり：つながっている 200・事業所の番号が空なら 503 no-company-id・違う事業所は 403", async () => {
    const freee = new FakeFreee();
    assert.equal((await handleStatus(req("/api/freee/status", { method: "GET" }), makeDeps(freee))).status, 200);
    const empty = await handleStatus(req("/api/freee/status", { method: "GET" }), makeDeps(freee, { FREEE_COMPANY_ID: "" }));
    assert.equal(empty.status, 503);
    assert.equal((await bodyOf(empty)).code, "no-company-id");
    assert.equal((await handleStatus(req("/api/freee/status", { method: "GET", cookie: tokenCookie(999) }), makeDeps(freee))).status, 403);
  });

  test("返事は CDN にも覚えさせない（cookie の有る無しで答えが変わるので Vary: Cookie）", async () => {
    const r = await handleStatus(req("/api/freee/status", { method: "GET", cookie: null }), makeDeps(new FakeFreee()));
    assert.match(r.headers.get("cache-control")!, /no-store/);
    assert.equal(r.headers.get("cdn-cache-control"), "no-store");
    assert.equal(r.headers.get("vercel-cdn-cache-control"), "no-store");
    assert.match(r.headers.get("vary")!, /Cookie/);
  });

  test("画面：cookie が無い・切れた・事業所の番号が空の時は「オーナー用」の「freee とつなぐ」を出す。プレビューでは出さない", async () => {
    const { readStatusAnswer, showConnect } = await import("../useFreee");
    const deps = makeDeps(new FakeFreee());
    const answerOf = async (r: Response) => readStatusAnswer(r.status, r.status === 200 ? null : await r.json());
    const noCookie = await answerOf(await handleStatus(req("/api/freee/status", { method: "GET", cookie: null }), deps));
    assert.deepEqual(noCookie, { status: "none", missing: [] });
    assert.equal(showConnect(noCookie), true);
    const expired = await answerOf(await handleStatus(req("/api/freee/status", { method: "GET", cookie: tokenCookie(COMPANY, NOW - 1) }), deps));
    assert.equal(expired.status, "expired");
    assert.equal(showConnect(expired), true);
    const emptyId = await answerOf(await handleStatus(req("/api/freee/status", { method: "GET" }), makeDeps(new FakeFreee(), { FREEE_COMPANY_ID: "" })));
    assert.equal(showConnect(emptyId), true);
    // 環境変数が欠けていても、cookie が無ければ出す（名前を添える）
    const missing = await answerOf(await handleStatus(req("/api/freee/status", { method: "GET", cookie: null }), makeDeps(new FakeFreee(), { FREEE_CLIENT_SECRET: "" })));
    assert.deepEqual(missing, { status: "none", missing: ["FREEE_CLIENT_SECRET"] });
    assert.equal(showConnect(missing), true);
    // つながっている・プレビューでは出さない
    assert.equal(showConnect(await answerOf(await handleStatus(req("/api/freee/status", { method: "GET" }), deps))), false);
    const preview = await answerOf(await handleStatus(req("/api/freee/status", { method: "GET", cookie: null }), makeDeps(new FakeFreee(), { VERCEL_ENV: "preview" })));
    assert.equal(preview.status, "off");
    assert.equal(showConnect(preview), false);
  });
});
