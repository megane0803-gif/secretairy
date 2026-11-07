// 広告のテスト用アカウントに本当に送る窓口（docs/SPEC.md §1.7.8）。本物の Google は呼ばない（fetch を作り物の Google にする）。
// 鍵はテストの中で crypto.generateKeyPairSync で作る（PEM や鍵の JSON をリポジトリに入れない）。番号・メールも作り物だけ。

import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import { emptyBook } from "../../book/state";
import { getAds } from "../../data/seed";
import { memoryStore, type KvStore } from "../../line/store";
import { checkPasscode } from "../../server/passcode";
import { getAdSettings, getMenus, getShop, getSiteOrigin } from "../../settings";
import { RESULT_FORMAT, SYNC_FORMAT, SYNC_VERSION, syncPayload, type SyncPayload } from "../connect";
import { loadSyncResult } from "../connectLoad";
import { featuredWords } from "../featured";
import { gaqlString, VERIFY_QUERY } from "../live/api";
import { customerIdFrom, liveEnvFrom, LIVE_ENV, serviceKeyFrom } from "../live/env";
import { handleLiveRead, handleLiveSend, handleLiveSetup, handleLiveStatus, keywordProblem, LIVE_KEY, scrub, type LiveDeps } from "../live/server";
import { accessToken, clearTokenCache, signedJwt } from "../live/token";
import { driftOf, outcomeText } from "../live/client";
import { approveAd, approveAdd, EMPTY_ADS, tableOf, withReview, type AdsState } from "../state";
import { buildTable } from "../report";
import { fakeGoogle, type FakeGoogle } from "./fakeGoogle";

const ads = getAdSettings();
const live = ads.live;
const c = ads.connect;
const words = featuredWords(ads, getMenus());
const SITE = getSiteOrigin();
const HOST = new URL(SITE).host;
const MANAGER = "9000000001";
const CUSTOMER = "9000000002";
// 作り物のメール（そのままの形でリポジトリに置かない）
const EMAIL = ["robot", "fake-project.iam.invalid"].join("@");
const PASS = "owner-passcode-fake-0001";
const NOW0 = Date.UTC(2026, 10, 7, 1, 0, 0);

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
/** 鍵の JSON（作り物の鍵で、その場で作る） */
const keyJson = () => JSON.stringify({ type: "service_account", project_id: "fake-project", private_key_id: "abcdef0123456789", private_key: privateKey, client_email: EMAIL });
const KEY_PIECE = privateKey.split("\n")[5];

let clock = NOW0;
const now = () => clock;

function envOf(over: Record<string, string | undefined> = {}) {
  return liveEnvFrom({
    VERCEL_ENV: "production",
    [LIVE_ENV.key]: keyJson(),
    [LIVE_ENV.loginCustomerId]: MANAGER,
    [LIVE_ENV.customerId]: CUSTOMER,
    [LIVE_ENV.ownerPasscode]: PASS,
    ...over,
  });
}

function world(over: { env?: Record<string, string | undefined>; store?: KvStore | null; google?: FakeGoogle } = {}) {
  // 作り物の Google ごとに通行証が違うので、持っている通行証を捨てる
  clearTokenCache();
  const google = over.google ?? fakeGoogle({ publicKeyPem: publicKey, email: EMAIL, managerId: MANAGER, customerId: CUSTOMER, now });
  const store = over.store === undefined ? memoryStore(now) : over.store;
  const deps: LiveDeps = {
    env: envOf(over.env),
    settings: live,
    connect: c,
    towns: ads.towns,
    words,
    setupKeywords: getAds().keywords.map((k) => k.text),
    siteOrigin: SITE,
    fetch: google.fetch,
    now,
    store,
    timeZone: getShop().timezone,
    random: (n) => randomBytes(n),
  };
  return { google, store, deps };
}

function req(path: string, p: { method?: string; origin?: string | null; host?: string; body?: unknown; fetchSite?: string } = {}): Request {
  const method = p.method ?? "POST";
  const h = new Headers({ host: p.host ?? HOST });
  if (p.origin !== null && method === "POST") h.set("origin", p.origin ?? SITE);
  if (p.fetchSite) h.set("sec-fetch-site", p.fetchSite);
  if (p.body !== undefined) h.set("content-type", "application/json");
  return new Request(`${SITE}${path}`, { method, headers: h, body: p.body !== undefined ? JSON.stringify(p.body) : undefined });
}
const bodyOf = async (r: Response) => (await r.json()) as Record<string, any>;

const setupReq = (...a: [passcode?: unknown, extra?: Record<string, unknown>]) => req("/api/ads/live/setup", { body: { passcode: a.length ? a[0] : PASS, ...(a[1] ?? {}) } });
const sendReq = (payload: unknown, ...a: [passcode?: unknown]) => req("/api/ads/live/send", { body: { passcode: a.length ? a[0] : PASS, payload } });
const readReq = () => req("/api/ads/live/read", { body: {} });

const APPROVED = "2026-11-06T01:00:00.000Z";
function payloadOf(items: SyncPayload["items"], over: Partial<SyncPayload> = {}): SyncPayload {
  return { format: SYNC_FORMAT, version: SYNC_VERSION, createdAt: APPROVED, campaign: c.campaign, adGroup: c.adGroup, items, ...over };
}
const STOP = { id: "ad-2", kind: "stop" as const, text: "美容院 安い", approvedAt: APPROVED };
const EXCLUDE = { id: "ad-1", kind: "exclude" as const, text: "美容院 安い 学生", match: "exact" as const, approvedAt: APPROVED };
const ADD = { id: "ad-1-add1", kind: "add" as const, text: "縮毛矯正 くせ毛 ひどい", match: "phrase" as const, approvedAt: APPROVED };

/** 用意を済ませた作り物（キャンペーン・広告グループ・8つの言葉） */
async function prepared(over: Parameters<typeof world>[0] = {}) {
  const w = world(over);
  const r = await handleLiveSetup(setupReq(), w.deps);
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  // 用意で「動いている印」と合言葉の間違いの数は残らない
  return w;
}

/** 書く呼び出し（validateOnly でも本当でも） */
const writes = (g: FakeGoogle) => g.mutateCalls.filter((m) => !m.validateOnly);

// console を見張る（鍵のかけら・番号・メール・合言葉が出ないこと）
const logged: string[] = [];
const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
beforeEach(() => {
  clock = NOW0;
  clearTokenCache();
  logged.length = 0;
  for (const k of ["log", "warn", "error", "info"] as const) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
});
afterEach(() => {
  Object.assign(console, saved);
  const all = logged.join("\n");
  for (const bad of [KEY_PIECE, MANAGER, CUSTOMER, EMAIL, PASS]) assert.ok(!all.includes(bad), "ログに秘密が出ていない");
});

/** 返事の文字に、鍵のかけら・番号・メール・合言葉・resourceName が無い */
function clean(text: string) {
  for (const bad of [KEY_PIECE, MANAGER, CUSTOMER, EMAIL, PASS, "customers/", "resourceName", "fake-access", "@"]) assert.ok(!text.includes(bad), `返事に「${bad}」が出ていない`);
}

// ────────────────────────────────────────────────────────────

describe("鍵と通行証", () => {
  test("鍵の JSON から JWT を作り、1時間の通行証をもらう（作り物の Google が公開鍵で署名を確かめる）", async () => {
    const { google, deps } = world();
    const t = await accessToken({ key: deps.env.key!, settings: live, fetch: google.fetch, now });
    assert.match(t, /^fake-access-/);
    assert.equal(google.tokenCalls, 1);
    const body = new URLSearchParams(google.calls[0].body);
    assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [, claims] = String(body.get("assertion")).split(".");
    const cl = JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
    assert.equal(cl.scope, "https://www.googleapis.com/auth/adwords");
    assert.equal(cl.aud, "https://oauth2.googleapis.com/token");
    assert.equal(cl.exp - cl.iat, 3600);
  });

  test("通行証は切れる5分前まで使い回し、そのあと作り直す", async () => {
    const { google, deps } = world();
    const get = () => accessToken({ key: deps.env.key!, settings: live, fetch: google.fetch, now });
    const a = await get();
    clock += 50 * 60_000;
    assert.equal(await get(), a);
    assert.equal(google.tokenCalls, 1);
    clock += 5 * 60_000;
    assert.notEqual(await get(), a);
    assert.equal(google.tokenCalls, 2);
  });

  test("Vercel に貼った private_key の「\\n」の文字を改行に直して署名できる", () => {
    const pasted = JSON.stringify({ client_email: EMAIL, private_key: privateKey.replace(/\n/g, "\\n") });
    const k = serviceKeyFrom(pasted);
    assert.ok(k);
    assert.equal(signedJwt(k!, live, NOW0).split(".").length, 3);
  });

  test("読めない鍵は「無い」と同じ（理由に鍵の中身を出さない）", async () => {
    for (const bad of ["{", "{}", JSON.stringify({ client_email: EMAIL, private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" }), "not json"])
      assert.equal(serviceKeyFrom(bad), null);
    const { deps } = world({ env: { [LIVE_ENV.key]: "{ broken" } });
    const r = await handleLiveStatus(req("/api/ads/live/status", { method: "GET" }), deps);
    assert.deepEqual(await bodyOf(r), { ok: true, connected: false, canWrite: false });
  });

  test("鍵を作る所がうまくいかない時は、決まった短い理由だけ（返ってきた中身を出さない）", async () => {
    const { deps } = world();
    deps.fetch = async (url) => (url.includes("oauth2") ? new Response(JSON.stringify({ error: "invalid_grant", error_description: `bad ${EMAIL}` }), { status: 400 }) : new Response("{}"));
    const r = await handleLiveRead(readReq(), deps);
    const text = await r.text();
    assert.match(text, /鍵から通行証を作れませんでした/);
    clean(text);
  });

  test("番号は数字だけの10桁にそろえる（ハイフンは除く・違う形は無いのと同じ）", () => {
    assert.equal(customerIdFrom("900-000-0002"), CUSTOMER);
    assert.equal(customerIdFrom("12345"), null);
    assert.equal(customerIdFrom("abcdefghij"), null);
  });
});

describe("つながっているか・止まる時", () => {
  test("札：3つの環境変数がある・本番のサイトの時だけ connected（Google は呼ばない）", async () => {
    const { google, deps } = world();
    const r = await handleLiveStatus(req("/api/ads/live/status", { method: "GET" }), deps);
    assert.deepEqual(await bodyOf(r), { ok: true, connected: true, canWrite: true });
    assert.equal(google.calls.length, 0);
  });

  test("鍵・管理アカウントの番号・広告アカウントの番号のどれかが無い時・プレビューの時は止まる（エラーにしない）", async () => {
    const cases: Record<string, string | undefined>[] = [
      { [LIVE_ENV.key]: undefined },
      { [LIVE_ENV.loginCustomerId]: undefined },
      { [LIVE_ENV.customerId]: undefined },
      { VERCEL_ENV: "preview" },
      { VERCEL_ENV: undefined },
    ];
    for (const env of cases) {
      const { google, deps } = world({ env });
      const s = await bodyOf(await handleLiveStatus(req("/api/ads/live/status", { method: "GET" }), deps));
      assert.equal(s.connected, false, JSON.stringify(env));
      for (const [h, rq] of [
        [handleLiveSetup, setupReq()],
        [handleLiveSend, sendReq(payloadOf([STOP]))],
        [handleLiveRead, readReq()],
      ] as const) {
        const r = await h(rq, deps);
        assert.equal(r.status, 200);
        const b = await bodyOf(r);
        assert.equal(b.code, "not-connected");
        assert.equal(b.message, "テスト用の広告アカウントにつないでいません");
      }
      assert.equal(google.calls.length, 0);
    }
    // プレビューの URL（本番の名前ではない host）でも止まる
    const { google, deps } = world();
    const r = await handleLiveRead(req("/api/ads/live/read", { host: "secretairy-git-x.vercel.app", body: {} }), deps);
    assert.equal((await bodyOf(r)).code, "not-connected");
    assert.equal(google.calls.length, 0);
  });

  test("受ける形のほかは 405・ほかのサイトからは 403（freee と同じ共通の守り）", async () => {
    const { google, deps } = world();
    assert.equal((await handleLiveSend(req("/api/ads/live/send", { method: "GET" }), deps)).status, 405);
    assert.equal((await handleLiveStatus(req("/api/ads/live/status", { method: "POST", body: {} }), deps)).status, 405);
    for (const origin of ["https://evil.example", "http://secretairy.vercel.app", null]) {
      const r = await handleLiveSend(req("/api/ads/live/send", { origin, body: { passcode: PASS, payload: payloadOf([STOP]) } }), deps);
      assert.equal(r.status, 403, String(origin));
      assert.equal((await bodyOf(r)).code, "origin");
    }
    const cross = await handleLiveRead(req("/api/ads/live/read", { body: {}, fetchSite: "cross-site" }), deps);
    assert.equal(cross.status, 403);
    assert.equal(google.calls.length, 0);
  });

  test("つながっている時の札とボタンの所は「くわしく」の中だけ（名前は札だけ・鍵の環境変数を画面のコードで読まない）", () => {
    const page = readFileSync("src/app/ads/page.tsx", "utf8");
    const fold = page.slice(page.indexOf("<Fold"), page.indexOf("</Fold>"));
    assert.ok(fold.indexOf("<AdsConnect />") < fold.indexOf("<AdsLive />"), "渡す形の下");
    const ui = readFileSync("src/app/ads/AdsLive.tsx", "utf8");
    assert.match(ui, /つながっています・広告は出ません・お金は動きません/);
    assert.match(ui, /テスト用アカウントに店の広告を用意する/);
    assert.match(ui, /テスト用アカウントに送る/);
    assert.match(ui, /テスト用アカウントから読み直す/);
    assert.match(ui, /（つなぐ手順は README）/);
    assert.match(ui, /type="password"/);
    assert.doesNotMatch(ui, /localStorage|sessionStorage|writeBrowser/, "合言葉をブラウザに残さない");
    for (const f of ["src/app/ads/AdsLive.tsx", "src/lib/ads/live/client.ts", "src/lib/ads/live/wire.ts", "src/lib/ads/connectLoad.ts"]) {
      const s = readFileSync(f, "utf8");
      assert.doesNotMatch(s, /process\.env|GOOGLE_ADS_|NEXT_PUBLIC_/, f);
      assert.doesNotMatch(s, /from "\.\/(env|token|api|server|deps)"|live\/(env|token|api|server|deps)"/, `${f} はサーバーの部品を読まない`);
    }
    for (const f of ["src/lib/ads/live/env.ts", "src/lib/ads/live/deps.ts"]) assert.doesNotMatch(readFileSync(f, "utf8"), /NEXT_PUBLIC_/);
  });
});

describe("いつもテスト用アカウントかを確かめる（一番大事）", () => {
  test("確かめの GAQL は決まった形で、広告アカウントの番号の URL に・管理アカウントの番号を login-customer-id に・developer-token は送らない", async () => {
    const { google } = await prepared();
    const api = google.calls.filter((x) => x.url.includes("googleads"));
    assert.ok(api.length > 0);
    for (const x of api) {
      assert.ok(x.url.startsWith(`https://googleads.googleapis.com/${live.apiVersion}/customers/${CUSTOMER}/googleAds:`), "広告アカウントの番号だけ");
      assert.equal(x.headers["login-customer-id"], MANAGER);
      assert.ok(!("developer-token" in x.headers));
    }
    assert.ok(api.some((x) => JSON.parse(x.body).query === VERIFY_QUERY));
    assert.equal(VERIFY_QUERY, "SELECT customer.id, customer.test_account, customer.manager FROM customer LIMIT 1");
  });

  test("書き込む前に毎回、新しく確かめる（validateOnly の前も、本当に送る前も）", async () => {
    const { google } = await prepared();
    // 呼び出しの並び：mutate の直前はいつも確かめの検索
    const api = google.calls.filter((x) => x.url.includes("googleads"));
    api.forEach((x, i) => {
      if (x.url.endsWith(":mutate")) assert.equal(JSON.parse(api[i - 1].body).query, VERIFY_QUERY, `${i} 番目の mutate の前`);
    });
    assert.ok(api.filter((x) => x.url.endsWith(":mutate")).length >= 2);
  });

  test("test_account が false の時は、何も書かずに止める（用意・止める・外す・足すのどれも）", async () => {
    const w = await prepared();
    const before = w.google.mutateCalls.length;
    w.google.customers.find((x) => x.id === CUSTOMER)!.testAccount = false;
    for (const items of [[STOP], [EXCLUDE], [ADD]]) {
      const r = await handleLiveSend(sendReq(payloadOf(items)), w.deps);
      const b = await bodyOf(r);
      assert.equal(b.code, "not-test");
      assert.equal(b.message, "テスト用アカウントではないので送りませんでした");
    }
    const s = await bodyOf(await handleLiveSetup(setupReq(), w.deps));
    assert.equal(s.code, "not-test");
    assert.equal(w.google.mutateCalls.length, before, "validateOnly も送っていない");
    assert.equal((await bodyOf(await handleLiveRead(readReq(), w.deps))).code, "not-test");
  });

  test("番号が設定と違う時（管理アカウントの番号を広告アカウントに入れた時も）は送らない", async () => {
    // 広告アカウントの番号に、管理アカウントの番号を入れた（管理アカウントも test_account は true）
    const w = world({ env: { [LIVE_ENV.customerId]: MANAGER } });
    const r = await bodyOf(await handleLiveSetup(setupReq(), w.deps));
    assert.equal(r.code, "not-test");
    assert.equal(w.google.mutateCalls.length, 0);
    // 返ってきた番号が設定と違う
    const w2 = world();
    w2.google.customers.find((x) => x.id === CUSTOMER)!.id = "9000000003";
    w2.google.customers.push({ id: CUSTOMER, testAccount: true, manager: false });
    const realFetch = w2.google.fetch;
    w2.deps.fetch = async (url, init) => {
      const res = await realFetch(url, init);
      if (url.endsWith(":search") && JSON.parse(String(init.body)).query === VERIFY_QUERY)
        return new Response(JSON.stringify({ results: [{ customer: { id: "9000000003", testAccount: true } }] }));
      return res;
    };
    assert.equal((await bodyOf(await handleLiveSetup(setupReq(), w2.deps))).code, "not-test");
    assert.equal(w2.google.mutateCalls.length, 0);
  });

  test("番号はリクエストから受け取らない（中身に番号を入れても、設定の番号の URL だけ）", async () => {
    const w = await prepared();
    await handleLiveSend(req("/api/ads/live/send", { body: { passcode: PASS, customerId: "9000000009", payload: payloadOf([STOP]) } }), w.deps);
    await handleLiveSetup(setupReq(PASS, { customerId: "9000000009", loginCustomerId: "9000000008" }), w.deps);
    for (const x of w.google.calls.filter((y) => y.url.includes("googleads"))) {
      assert.ok(x.url.includes(`/customers/${CUSTOMER}/`));
      assert.equal(x.headers["login-customer-id"], MANAGER);
    }
  });

  test("CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION が返ったら「テスト用アカウントではないので送りませんでした」（返ってきた文は出さない）", async () => {
    const w = await prepared();
    w.google.hooks.notApproved = true;
    const r = await handleLiveSend(sendReq(payloadOf([STOP])), w.deps);
    const text = await r.text();
    assert.equal(JSON.parse(text).code, "not-test");
    assert.match(text, /テスト用アカウントではないので送りませんでした/);
    clean(text);
  });

  test("書き込む関数はほかに無い（post は外に出さず、mutate の入口で必ず確かめる）", () => {
    const src = readFileSync("src/lib/ads/live/api.ts", "utf8");
    assert.doesNotMatch(src, /export async function post|export function post/);
    const m = src.slice(src.indexOf("export async function mutate"));
    assert.match(m.slice(0, m.indexOf("post(ctx")), /await verifyTestAccount\(ctx\);/);
    // server.ts からも googleAds:mutate を直に呼ばない
    assert.doesNotMatch(readFileSync("src/lib/ads/live/server.ts", "utf8"), /googleAds:mutate|ctx\.fetch|d\.fetch\(/);
  });
});

describe("用意（テスト用アカウントの中に店の広告を作る）", () => {
  test("1回の mutate で、予算・止めたキャンペーン・広告グループ・8つの言葉を作る（validateOnly で確かめてから）", async () => {
    const w = world();
    const r = await handleLiveSetup(setupReq(), w.deps);
    const b = await bodyOf(r);
    assert.equal(b.ok, true);
    const muts = w.google.mutateCalls;
    assert.equal(muts.length, 2);
    assert.equal(muts[0].validateOnly, true);
    assert.equal(muts[1].validateOnly, false);
    assert.deepEqual(muts[0].ops, muts[1].ops, "同じ中身");
    assert.equal(muts[1].partialFailure, false, "全部できるか、何もできないか");
    const ops = muts[1].ops;
    assert.deepEqual(
      ops.map((o) => Object.keys(o)[0]),
      ["campaignBudgetOperation", "campaignOperation", "adGroupOperation", ...Array(8).fill("adGroupCriterionOperation")],
    );
    const camp = (ops[1].campaignOperation as any).create;
    assert.equal(camp.status, "PAUSED");
    assert.equal(camp.advertisingChannelType, "SEARCH");
    assert.deepEqual(camp.manualCpc, {});
    assert.equal(camp.containsEuPoliticalAdvertising, "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING");
    assert.deepEqual(camp.networkSettings, { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false });
    const budget = (ops[0].campaignBudgetOperation as any).create;
    assert.equal(budget.deliveryMethod, "STANDARD");
    assert.equal(budget.explicitlyShared, false);
    assert.ok(Number(budget.amountMicros) <= 1_000_000_000, "小さな作り物の額");
    // 仮の番号は種類をまたいで重ならない
    const temps = ops.map((o) => (Object.values(o)[0] as any).create?.resourceName).filter(Boolean).map((x: string) => x.split("/").pop());
    assert.deepEqual(temps, ["-1", "-2", "-3"]);
    // 広告文は作らない
    assert.ok(!ops.some((o) => "adGroupAdOperation" in o));
    assert.equal(w.google.campaigns.length, 1);
    assert.equal(w.google.campaigns[0].status, "PAUSED");
    assert.equal(w.google.criteria.length, 8);
    clean(JSON.stringify(b));
  });

  test("同じ名前の物があれば作らない（2回押しても増えない）", async () => {
    const w = await prepared();
    const before = w.google.mutateCalls.length;
    const b = await bodyOf(await handleLiveSetup(setupReq(), w.deps));
    assert.equal(b.ok, true);
    assert.match(b.lines.join(), /もう用意してあります/);
    assert.equal(w.google.mutateCalls.length, before);
    assert.equal(w.google.campaigns.length, 1);
    assert.equal(w.google.groups.length, 1);
    assert.equal(w.google.criteria.length, 8);
    // 言葉が1つ消えていたら、足りない1つだけ作る
    w.google.criteria = w.google.criteria.slice(1);
    await handleLiveSetup(setupReq(), w.deps);
    assert.equal(w.google.criteria.length, 8);
    assert.equal(w.google.campaigns.length, 1);
  });

  test("REMOVED の物は無い物として探す・同じ名前が2つ以上なら作らない", async () => {
    const w = await prepared();
    w.google.campaigns[0].status = "REMOVED";
    w.google.budgets[0].status = "REMOVED";
    await handleLiveSetup(setupReq(), w.deps);
    assert.equal(w.google.campaigns.filter((x) => x.status !== "REMOVED").length, 1);
    w.google.campaigns.push({ ...w.google.campaigns[1], id: 99999 });
    const before = w.google.mutateCalls.length;
    const b = await bodyOf(await handleLiveSetup(setupReq(), w.deps));
    assert.equal(b.code, "many");
    assert.equal(w.google.mutateCalls.length, before);
  });

  test("validateOnly で通らなければ、何も作らない（Google の文は出さない）", async () => {
    const w = world();
    w.google.hooks.rejectText = getAds().keywords[0].text;
    const r = await handleLiveSetup(setupReq(), w.deps);
    const text = await r.text();
    assert.equal(writes(w.google).length, 0);
    assert.equal(w.google.campaigns.length, 0);
    assert.match(text, /何も作りませんでした/);
    clean(text);
  });

  test("80文字・10語をこえる言葉は送らない", () => {
    assert.equal(keywordProblem("あ".repeat(80), live), null);
    assert.match(String(keywordProblem("あ".repeat(81), live)), /80文字/);
    assert.match(String(keywordProblem(Array(11).fill("a").join(" "), live)), /10語/);
    assert.equal(keywordProblem(Array(10).fill("a").join(" "), live), null);
    assert.match(String(keywordProblem('縮毛矯正 "x"', live)), /使えない印/);
  });

  test("用意する言葉に長すぎる物があれば、その言葉は送らない", async () => {
    const w = world();
    w.deps.setupKeywords = [...w.deps.setupKeywords, "あ".repeat(81)];
    const b = await bodyOf(await handleLiveSetup(setupReq(), w.deps));
    assert.equal(b.ok, true);
    assert.equal(w.google.criteria.length, 8);
    assert.match(b.lines.join(), /長すぎます/);
  });

  test("作り物の Google は、status を書かないキャンペーン・仮の番号の重なりを断る（自分の形にだけ合う作り物にしない）", async () => {
    const w = world();
    const token = await accessToken({ key: w.deps.env.key!, settings: live, fetch: w.google.fetch, now });
    const call = (ops: unknown[]) =>
      w.google.fetch(`https://googleads.googleapis.com/v26/customers/${CUSTOMER}/googleAds:mutate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "login-customer-id": MANAGER },
        body: JSON.stringify({ mutateOperations: ops, validateOnly: true }),
      });
    const budget = { campaignBudgetOperation: { create: { resourceName: `customers/${CUSTOMER}/campaignBudgets/-1`, name: "x", amountMicros: "1000000", deliveryMethod: "STANDARD", explicitlyShared: false } } };
    const campaign = (status?: string, rn = -2) => ({
      campaignOperation: {
        create: {
          resourceName: `customers/${CUSTOMER}/campaigns/${rn}`,
          name: "y",
          advertisingChannelType: "SEARCH",
          ...(status ? { status } : {}),
          campaignBudget: `customers/${CUSTOMER}/campaignBudgets/-1`,
          manualCpc: {},
          containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
          networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false },
        },
      },
    });
    assert.equal((await call([budget, campaign("PAUSED")])).status, 200);
    assert.equal((await call([budget, campaign()])).status, 400, "status なし");
    assert.equal((await call([budget, campaign("PAUSED", -1)])).status, 400, "仮の番号の重なり");
    const upd = (mask?: string) => ({ adGroupCriterionOperation: { update: { resourceName: `customers/${CUSTOMER}/adGroupCriteria/1~2`, status: "PAUSED" }, ...(mask ? { updateMask: mask } : {}) } });
    const r1 = await (await call([upd()])).json();
    assert.ok(r1.error, "updateMask なしは断る");
    const r2 = await (await call([upd("status,name")])).json();
    assert.ok(r2.error, "status だけでない updateMask は断る");
    const withDev = await w.google.fetch(`https://googleads.googleapis.com/v26/customers/${CUSTOMER}/googleAds:search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "login-customer-id": MANAGER, "developer-token": "x" },
      body: JSON.stringify({ query: VERIFY_QUERY }),
    });
    assert.equal(withDev.status, 400, "developer-token を付けると断る");
  });
});

describe("送る（止める・外す・足す）", () => {
  test("3つとも「反映した」・読み直しで本当に変わっている・結果は直しR の形", async () => {
    const w = await prepared();
    const r = await handleLiveSend(sendReq(payloadOf([EXCLUDE, ADD, STOP])), w.deps);
    const text = await r.text();
    const b = JSON.parse(text);
    assert.equal(b.ok, true, text);
    assert.deepEqual(b.lines.map((l: any) => [l.id, l.outcome]), [["ad-1", "done"], ["ad-1-add1", "done"], ["ad-2", "done"]]);
    assert.equal(b.result.format, RESULT_FORMAT);
    assert.equal(b.result.version, 1);
    assert.equal(b.result.campaign, c.campaign);
    assert.deepEqual(b.result.results.map((x: any) => x.status), ["done", "done", "done"]);
    assert.equal(w.google.criteria.find((k) => k.text === STOP.text)!.status, "PAUSED");
    assert.ok(w.google.negatives.some((n) => n.text === EXCLUDE.text && n.match === "EXACT"));
    assert.ok(w.google.criteria.some((k) => k.text === ADD.text && k.match === "PHRASE"));
    clean(text);
  });

  test("止めるの update は updateMask が status だけ・validateOnly で確かめてから送る", async () => {
    const w = await prepared();
    const n = w.google.mutateCalls.length;
    await handleLiveSend(sendReq(payloadOf([STOP])), w.deps);
    const [v, real] = w.google.mutateCalls.slice(n);
    assert.equal(v.validateOnly, true);
    assert.equal(real.validateOnly, false);
    const op = real.ops[0].adGroupCriterionOperation as any;
    assert.equal(op.updateMask, "status");
    assert.deepEqual(Object.keys(op.update).sort(), ["resourceName", "status"]);
    assert.equal(op.update.status, "PAUSED");
  });

  test("止める：ちょうど1つの時だけ。もう止まっていたら重ねない。0や2つ以上なら「できなかった」", async () => {
    const w = await prepared();
    await handleLiveSend(sendReq(payloadOf([STOP])), w.deps);
    const n = writes(w.google).length;
    const again = await bodyOf(await handleLiveSend(sendReq(payloadOf([STOP])), w.deps));
    assert.equal(again.lines[0].outcome, "already");
    assert.equal(again.lines[0].reason, "もう止まっていた");
    assert.equal(again.result.results[0].status, "done", "もう止まっていたも印");
    assert.equal(writes(w.google).length, n, "重ねて送らない");
    const none = await bodyOf(await handleLiveSend(sendReq(payloadOf([{ ...STOP, text: "無い言葉" }])), w.deps));
    assert.equal(none.lines[0].outcome, "failed");
    assert.match(none.lines[0].reason, /見つかりません/);
    // 同じ文字の言葉が別の合い方でもう1つある
    const g = w.google.groups[0];
    w.google.criteria.push({ groupId: g.id, id: 77777, text: "カット 上手い", match: "EXACT", status: "ENABLED" });
    const two = await bodyOf(await handleLiveSend(sendReq(payloadOf([{ ...STOP, text: "カット 上手い" }])), w.deps));
    assert.equal(two.lines[0].outcome, "failed");
    assert.match(two.lines[0].reason, /2つ以上/);
    assert.equal(writes(w.google).length, n);
  });

  test("言葉は空白をそろえて比べる（全角の空白・2つの空白も同じ言葉）", async () => {
    const w = await prepared();
    const b = await bodyOf(await handleLiveSend(sendReq(payloadOf([{ ...STOP, text: "美容院　 安い" }])), w.deps));
    assert.equal(b.lines[0].outcome, "done");
  });

  test("外す：完全一致の除外の言葉として。もうあれば重ねない・町の名前の入った言葉は外さない", async () => {
    const w = await prepared();
    await handleLiveSend(sendReq(payloadOf([EXCLUDE])), w.deps);
    const n = writes(w.google).length;
    const again = await bodyOf(await handleLiveSend(sendReq(payloadOf([EXCLUDE])), w.deps));
    assert.equal(again.lines[0].outcome, "already");
    assert.equal(again.lines[0].reason, "もう外していた");
    assert.equal(writes(w.google).length, n);
    assert.equal(w.google.negatives.length, 1);
    const town = await bodyOf(await handleLiveSend(sendReq(payloadOf([{ ...EXCLUDE, id: "ad-9", text: "もちの木町 美容室" }])), w.deps));
    assert.equal(town.lines[0].outcome, "failed");
    assert.match(town.lines[0].reason, /町の名前/);
    assert.equal(w.google.negatives.length, 1);
  });

  test("足す：フレーズ一致・広告グループがちょうど1つの時だけ・もうあれば重ねない・売りの言葉なしは送らない", async () => {
    const w = await prepared();
    await handleLiveSend(sendReq(payloadOf([ADD])), w.deps);
    const k = w.google.criteria.filter((x) => x.text === ADD.text);
    assert.deepEqual(k.map((x) => x.match), ["PHRASE"]);
    const n = writes(w.google).length;
    const again = await bodyOf(await handleLiveSend(sendReq(payloadOf([ADD])), w.deps));
    assert.equal(again.lines[0].outcome, "already");
    assert.equal(again.lines[0].reason, "もうあった");
    const plain = await bodyOf(await handleLiveSend(sendReq(payloadOf([{ ...ADD, id: "add-x", text: "パーマ 大人 安い" }])), w.deps));
    assert.equal(plain.lines[0].outcome, "failed");
    assert.match(plain.lines[0].reason, /売りの言葉/);
    assert.equal(writes(w.google).length, n);
    // 広告グループが2つ
    w.google.groups.push({ ...w.google.groups[0], id: 88888 });
    const two = await bodyOf(await handleLiveSend(sendReq(payloadOf([{ ...ADD, id: "add-y", text: "ヘッドスパ 癒し 夜" }])), w.deps));
    assert.equal(two.lines[0].outcome, "failed");
    assert.match(two.lines[0].reason, /2つ以上/);
    // 広告グループが無い
    w.google.groups = w.google.groups.map((x) => ({ ...x, status: "REMOVED" as const }));
    const zero = await bodyOf(await handleLiveSend(sendReq(payloadOf([{ ...ADD, id: "add-z", text: "ヘッドスパ 癒し 夜" }])), w.deps));
    assert.match(zero.lines[0].reason, /広告グループが見つかりません/);
    assert.equal(writes(w.google).length, n);
  });

  test("キャンペーンが無い時は、どれも「できなかった」（先に用意）", async () => {
    const w = world();
    const b = await bodyOf(await handleLiveSend(sendReq(payloadOf([STOP, EXCLUDE, ADD])), w.deps));
    assert.ok(b.lines.every((l: any) => l.outcome === "failed" && /キャンペーンが見つかりません/.test(l.reason)));
    assert.equal(w.google.mutateCalls.length, 0);
  });

  test("validateOnly で落ちた物は、本当には送らない（ほかは送る）", async () => {
    const w = await prepared();
    w.google.hooks.rejectText = EXCLUDE.text;
    const n = w.google.mutateCalls.length;
    const b = await bodyOf(await handleLiveSend(sendReq(payloadOf([EXCLUDE, ADD])), w.deps));
    const [v, real] = w.google.mutateCalls.slice(n);
    assert.equal(v.validateOnly, true);
    assert.equal(v.ops.length, 2);
    assert.equal(real.ops.length, 1);
    assert.ok(!JSON.stringify(real.ops).includes(EXCLUDE.text));
    assert.deepEqual(b.lines.map((l: any) => l.outcome), ["failed", "done"]);
    assert.equal(w.google.negatives.length, 0);
  });

  test("送った後に読み直して、変わっていなければ「できなかった」", async () => {
    const w = await prepared();
    w.google.hooks.ignoreStatusUpdate = true;
    const b = await bodyOf(await handleLiveSend(sendReq(payloadOf([STOP])), w.deps));
    assert.equal(b.lines[0].outcome, "failed");
    assert.match(b.lines[0].reason, /読み直しても変わっていません/);
    assert.equal(b.result.results[0].status, "failed");
  });

  test("本当に送った時に受けられなかった物は「できなかった」", async () => {
    const w = await prepared();
    w.google.hooks.rejectTextOnSend = ADD.text;
    const b = await bodyOf(await handleLiveSend(sendReq(payloadOf([ADD, EXCLUDE])), w.deps));
    assert.deepEqual(b.lines.map((l: any) => l.outcome), ["failed", "done"]);
  });

  test("返事が消えた時：結果が分からない時は「分からない」。もう一度「送る」で先に読み直して「もう〜だった」（重ねて変えない）", async () => {
    const w = await prepared();
    w.google.hooks.dropAfterMutate = true;
    w.google.hooks.dropSearchFrom = w.google.searchCount + 1 + 4 + 1 + 1 + 1; // 確かめ・読む4つ・確かめ×2 の後の読み直しで切れる
    const first = await bodyOf(await handleLiveSend(sendReq(payloadOf([STOP])), w.deps));
    assert.equal(first.lines[0].outcome, "unknown");
    assert.match(first.lines[0].reason, /分かりません（読み直してください）/);
    assert.equal(first.result.results.length, 0, "分からない物は印もできなかったも付けない");
    assert.equal(w.google.criteria.find((k) => k.text === STOP.text)!.status, "PAUSED", "本当は変わっていた");
    w.google.hooks = {};
    const n = writes(w.google).length;
    const again = await bodyOf(await handleLiveSend(sendReq(payloadOf([STOP])), w.deps));
    assert.equal(again.lines[0].outcome, "already");
    assert.equal(writes(w.google).length, n);
  });

  test("送る途中で通信が切れ、読み直すと変わっていた時は「反映した」・変わっていなければ「分からない」", async () => {
    const w = await prepared();
    w.google.hooks.dropAfterMutate = true;
    const b = await bodyOf(await handleLiveSend(sendReq(payloadOf([EXCLUDE])), w.deps));
    assert.equal(b.lines[0].outcome, "done");
    const w2 = await prepared();
    w2.google.hooks.dropBeforeMutate = true;
    const b2 = await bodyOf(await handleLiveSend(sendReq(payloadOf([EXCLUDE])), w2.deps));
    assert.equal(b2.lines[0].outcome, "unknown");
  });

  test("本当に送る直前の確かめで通信が切れたら、何も送っていないので「できなかった」（「分からない」にしない）", async () => {
    const w = await prepared();
    w.google.hooks.dropSearchFrom = w.google.searchCount + 1 + 4 + 1 + 1; // 本当に送る前の確かめで切れる
    const n = writes(w.google).length;
    const b = await bodyOf(await handleLiveSend(sendReq(payloadOf([EXCLUDE])), w.deps));
    assert.equal(b.lines[0].outcome, "failed");
    assert.match(b.lines[0].reason, /送れませんでした/);
    assert.equal(writes(w.google).length, n);
  });

  test("大きさ・形・数の上限・キャンペーンの名前で断る（何も送らない）", async () => {
    const w = await prepared();
    const n = w.google.calls.length;
    const big = req("/api/ads/live/send", { body: { passcode: PASS, pad: "x".repeat(live.maxRequestChars) } });
    assert.equal((await handleLiveSend(big, w.deps)).status, 413);
    const bad = [
      { passcode: PASS, payload: { ...payloadOf([STOP]), format: "x" } },
      { passcode: PASS, payload: payloadOf([{ ...STOP, kind: "remove" as any }]) },
      { passcode: PASS, payload: payloadOf([{ ...STOP, id: "a b" }]) },
      { passcode: PASS, payload: payloadOf([{ ...STOP, approvedAt: "x" }]) },
      { passcode: PASS, payload: payloadOf([{ ...EXCLUDE, match: "phrase" as any }]) },
      { passcode: PASS, payload: payloadOf([{ ...ADD, match: "exact" as any }]) },
      { passcode: PASS, payload: payloadOf([]) },
      { passcode: PASS, payload: payloadOf(Array.from({ length: live.maxItems + 1 }, (_, i) => ({ ...STOP, id: `ad-${i}` }))) },
      { passcode: PASS, payload: payloadOf([STOP], { campaign: "ほかのキャンペーン" }) },
      { passcode: PASS, payload: payloadOf([ADD], { adGroup: "ほかの広告グループ" }) },
    ];
    for (const body of bad) {
      const r = await handleLiveSend(req("/api/ads/live/send", { body }), w.deps);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 120));
    }
    const notJson = new Request(`${SITE}/api/ads/live/send`, { method: "POST", headers: { host: HOST, origin: SITE }, body: "{" });
    assert.equal((await handleLiveSend(notJson, w.deps)).status, 400);
    assert.equal(w.google.calls.length, n);
  });

  test("同じ案が2つあれば、1つ目だけ送る", async () => {
    const w = await prepared();
    const b = await bodyOf(await handleLiveSend(sendReq(payloadOf([EXCLUDE, { ...EXCLUDE, id: "ad-1b" }])), w.deps));
    assert.deepEqual(b.lines.map((l: any) => l.outcome), ["done", "failed"]);
    assert.equal(w.google.negatives.length, 1);
  });
});

describe("オーナーだけ（合言葉）", () => {
  test("合言葉なし・違う合言葉は断る（Google は呼ばない・合言葉は返事に出ない）", async () => {
    const w = await prepared();
    const n = w.google.calls.length;
    for (const p of [undefined, "", "ちがう合言葉ちがう合言葉ちがう", 1234, PASS + "x"]) {
      // 間違いの数の上限は下のテストで見る（ここでは1回ずつ数え直す）
      for (const r of [await handleLiveSetup(setupReq(p), w.deps), (await w.store!.del(LIVE_KEY.wrong), await handleLiveSend(sendReq(payloadOf([STOP]), p), w.deps))]) {
        assert.equal(r.status, 401);
        const text = await r.text();
        assert.equal(JSON.parse(text).code, "wrong");
        clean(text);
      }
      await w.store!.del(LIVE_KEY.wrong);
    }
    assert.equal(w.google.calls.length, n);
  });

  test("合言葉の環境変数が無い・16文字より短い時は「用意」「送る」を動かさない（札と読み直すだけ動く）", async () => {
    for (const pass of [undefined, "", "short-pass-15ch"]) {
      const w = world({ env: { [LIVE_ENV.ownerPasscode]: pass } });
      assert.equal("short-pass-15ch".length, 15);
      const s = await bodyOf(await handleLiveStatus(req("/api/ads/live/status", { method: "GET" }), w.deps));
      assert.deepEqual(s, { ok: true, connected: true, canWrite: false });
      for (const r of [await handleLiveSetup(setupReq(pass ?? ""), w.deps), await handleLiveSend(sendReq(payloadOf([STOP]), pass ?? ""), w.deps)]) {
        assert.equal(r.status, 503);
        assert.equal((await bodyOf(r)).code, "no-passcode");
      }
      assert.equal(w.google.mutateCalls.length, 0);
      assert.equal((await handleLiveRead(readReq(), w.deps)).status, 200);
    }
  });

  test("間違いの数は窓口全体で1つ：上限をこえたら、合っている合言葉でも10分は受けない", async () => {
    const w = await prepared();
    const max = live.passcode.maxWrong;
    for (let i = 0; i < max; i++) assert.equal((await bodyOf(await handleLiveSetup(setupReq(`wrong-${i}-xxxxxxxxxxxx`), w.deps))).code, "wrong");
    // ほかのボタン（送る）から来ても同じ数
    assert.equal((await bodyOf(await handleLiveSend(sendReq(payloadOf([STOP]), "wrong-again-xxxxxxxx"), w.deps))).code, "locked");
    const n = w.google.calls.length;
    const right = await handleLiveSend(sendReq(payloadOf([STOP])), w.deps);
    assert.equal(right.status, 429);
    assert.equal((await bodyOf(right)).code, "locked");
    assert.equal(w.google.calls.length, n);
    clock += live.passcode.wrongWindowSeconds * 1000 + 1000;
    assert.equal((await bodyOf(await handleLiveSend(sendReq(payloadOf([STOP])), w.deps))).ok, true);
  });

  test("合言葉の比べ方は共通（試験の合言葉も同じ関数）", () => {
    const evalSrc = readFileSync("src/lib/eval/passcode.ts", "utf8");
    assert.match(evalSrc, /checkPasscode\(given, configured, \{ maxChars \}\)/);
    assert.doesNotMatch(evalSrc, /timingSafeEqual/);
    assert.match(readFileSync("src/lib/ads/live/server.ts", "utf8"), /checkPasscode\(/);
    assert.equal(checkPasscode(PASS, PASS, { maxChars: 200, minChars: 16 }), "ok");
    assert.equal(checkPasscode("x".repeat(15), "x".repeat(15), { maxChars: 200, minChars: 16 }), "no-passcode");
  });

  test("「本番のサイトか・受ける形・Origin」は freee と同じ1つの関数", () => {
    for (const f of ["src/lib/freee/server.ts", "src/lib/ads/live/server.ts"]) {
      const s = readFileSync(f, "utf8");
      assert.match(s, /siteCheck\(request/, f);
      assert.doesNotMatch(s, /request\.headers\.get\("origin"\)/, f);
    }
  });
});

describe("置き場（1日の上限・動いている印）", () => {
  test("「動いている印」が取れない時は「いま送っています」（Google は呼ばない）", async () => {
    const w = await prepared();
    await w.store!.set(LIVE_KEY.lock, "other", { ex: 60 });
    const n = w.google.calls.length;
    for (const r of [await handleLiveSend(sendReq(payloadOf([STOP])), w.deps), await handleLiveSetup(setupReq(), w.deps)]) {
      assert.equal(r.status, 409);
      const b = await bodyOf(r);
      assert.equal(b.code, "busy");
      assert.match(b.message, /いま送っています/);
    }
    assert.equal(w.google.calls.length, n);
    assert.equal(await w.store!.get(LIVE_KEY.lock), "other", "ほかの印は消さない");
  });

  test("同時に2回来ても、片方だけが送る", async () => {
    const w = await prepared();
    const [a, b] = await Promise.all([handleLiveSend(sendReq(payloadOf([EXCLUDE])), w.deps), handleLiveSend(sendReq(payloadOf([EXCLUDE])), w.deps)]);
    const codes = [(await bodyOf(a)).code ?? "ok", (await bodyOf(b)).code ?? "ok"].sort();
    assert.deepEqual(codes, ["busy", "ok"]);
    assert.equal(w.google.negatives.length, 1);
    assert.equal(await w.store!.get(LIVE_KEY.lock), null, "終わったら印を消す");
  });

  test("1日の上限は KvStore で数える（先に足してから比べる。同時に来ても数えもれが無い）", async () => {
    const w = await prepared();
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: getShop().timezone }).format(new Date(clock));
    const rs = await Promise.all(Array.from({ length: live.daily.read + 3 }, () => handleLiveRead(readReq(), w.deps)));
    const codes = await Promise.all(rs.map(async (r) => (await bodyOf(r)).code ?? "ok"));
    assert.equal(codes.filter((x) => x === "ok").length, live.daily.read);
    assert.equal(codes.filter((x) => x === "limit").length, 3);
    assert.equal(await w.store!.get(LIVE_KEY.day(day, "read")), String(live.daily.read + 3));
    // 送る
    await w.store!.set(LIVE_KEY.day(day, "send"), String(live.daily.send), { ex: 3600 });
    assert.equal((await bodyOf(await handleLiveSend(sendReq(payloadOf([STOP])), w.deps))).code, "limit");
    // 用意（もう1回用意してあるので、残りの回数まで）
    await w.store!.set(LIVE_KEY.day(day, "setup"), String(live.daily.setup), { ex: 3600 });
    assert.equal((await bodyOf(await handleLiveSetup(setupReq(), w.deps))).code, "limit");
  });

  test("止めるの1日の数は外す・足すとは別：送る案の中の止めるの数だけ先に足し、こえた分は「できなかった」", async () => {
    const w = await prepared();
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: getShop().timezone }).format(new Date(clock));
    await w.store!.set(LIVE_KEY.day(day, "stop"), String(live.daily.stop - 1), { ex: 3600 });
    const b = await bodyOf(await handleLiveSend(sendReq(payloadOf([STOP, { ...STOP, id: "ad-3", text: "カット 上手い" }, EXCLUDE])), w.deps));
    assert.deepEqual(b.lines.map((l: any) => l.outcome), ["done", "failed", "done"]);
    assert.match(b.lines[1].reason, /止めるは\d+件まで/);
    assert.equal(w.google.criteria.find((k) => k.text === "カット 上手い")!.status, "ENABLED");
  });

  test("置き場が無い・通信に失敗した時は、用意・送る・読み直すを動かさない（サーバーの記憶だけで数えない）", async () => {
    const down: KvStore = {
      get: async () => {
        throw new Error("down");
      },
      set: async () => {
        throw new Error("down");
      },
      del: async () => {
        throw new Error("down");
      },
      getdel: async () => {
        throw new Error("down");
      },
      incr: async () => {
        throw new Error("down");
      },
      rpush: async () => {
        throw new Error("down");
      },
      lpop: async () => {
        throw new Error("down");
      },
      expire: async () => {
        throw new Error("down");
      },
    };
    for (const store of [null, down]) {
      const w = world({ store });
      for (const r of [await handleLiveSetup(setupReq(), w.deps), await handleLiveSend(sendReq(payloadOf([STOP])), w.deps), await handleLiveRead(readReq(), w.deps)]) {
        assert.equal(r.status, 503);
        assert.equal((await bodyOf(r)).code, "no-store");
      }
      assert.equal(w.google.calls.length, 0);
    }
  });
});

describe("読み直す（だれでも）", () => {
  test("キャンペーンの言葉と状態・除外の言葉を一覧で（数は無い・resourceName・番号は返さない）", async () => {
    const w = await prepared();
    await handleLiveSend(sendReq(payloadOf([STOP, EXCLUDE, ADD])), w.deps);
    const r = await handleLiveRead(readReq(), w.deps);
    const text = await r.text();
    const b = JSON.parse(text);
    assert.equal(b.ok, true);
    assert.equal(b.campaign.found, true);
    assert.match(b.campaign.status, /止めている/);
    assert.equal(b.keywords.length, 9);
    assert.deepEqual(b.keywords.find((k: any) => k.text === STOP.text), { text: STOP.text, match: "フレーズ一致", status: "止めている", group: c.adGroup });
    assert.deepEqual(b.negatives, [{ text: EXCLUDE.text, match: "完全一致" }]);
    assert.doesNotMatch(text, /clicks|cost|bookings|impressions/);
    clean(text);
    assert.equal(w.google.mutateCalls.length, 4, "読み直しでは書かない");
  });

  test("キャンペーンがまだ無い時は、その1行", async () => {
    const w = world();
    const b = await bodyOf(await handleLiveRead(readReq(), w.deps));
    assert.equal(b.campaign.found, false);
    assert.match(b.note, /キャンペーンがまだありません/);
  });

  test("返す言葉の中のメールや長い数字の形は伏せる・ほかの広告グループの名前は出さない", async () => {
    assert.equal(scrub(`a ${EMAIL} b`), "a ＊ b");
    assert.equal(scrub("言葉 9000000002"), "言葉 ＊");
    const w = await prepared();
    w.google.groups.push({ id: 5555, campaignId: w.google.campaigns[0].id, name: "オーナーの手で作った名前", status: "ENABLED" });
    w.google.criteria.push({ groupId: 5555, id: 5556, text: "連絡 9000000002", match: "BROAD", status: "ENABLED" });
    const text = await (await handleLiveRead(readReq(), w.deps)).text();
    assert.doesNotMatch(text, /オーナーの手で作った名前/);
    assert.match(text, /ほかの広告グループ/);
    clean(text);
  });

  test("GAQL の文字の中の ' と \\ は逃がす", () => {
    assert.equal(gaqlString("a'b\\c"), "'a\\'b\\\\c'");
    const src = readFileSync("src/lib/ads/live/server.ts", "utf8");
    assert.ok((src.match(/!= 'REMOVED'/g) ?? []).length >= 6, "言葉と除外を探す時は REMOVED を除く");
  });
});

describe("画面の印（直しR の読み込みと同じ道）", () => {
  const settings = getAdSettings();
  const report = getAds();
  const table = buildTable(report, settings);
  const shop = getShop();
  const NOW = "2026-11-07T01:00:00.000Z";
  const TODAY = "2026-11-07";

  function state(): AdsState {
    let s = withReview(
      EMPTY_ADS,
      {
        proposal: { id: "ad-1", action: "exclude", no: 10, text: "美容院 安い 学生", reason: "予約につながっていません。", checks: [] },
        adds: [{ id: "ad-1-add1", no: 11, reason: "売りの言葉です。", checks: [] }],
      },
      table,
      { nowIso: NOW, mode: "script" },
      settings,
    );
    s = approveAd(s, emptyBook(TODAY), "ad-1", { nowIso: NOW, today: TODAY, shop, settings }).ads;
    s = approveAdd(s, "ad-1-add1", { nowIso: NOW, table: tableOf(report, settings, s), words, settings }).ads;
    return {
      ...s,
      proposals: [
        ...s.proposals,
        { id: "ad-2", action: "stop", no: 3, text: "美容院 安い", reason: "予約につながっていません。", total: { clicks: 0, cost: 0, bookings: 0 }, checks: [], createdAt: NOW, state: "approved", decidedAt: NOW, fixed: false, mode: "ai" },
      ],
      applied: [...s.applied, { no: 3, action: "stop", at: NOW, proposalId: "ad-2" }],
    };
  }

  test("送った結果を loadSyncResult で読み、反映した・もう〜だったに印。2回でも1回", async () => {
    let s = state();
    const store = { read: () => s, update: (f: (x: AdsState) => AdsState) => ((s = f(s)), { ok: true as const }), words, settings: c, journal: "テスト用の広告アカウントに送った" };
    const w = await prepared();
    // 外すは先にもうあった（「もう外していた」も印）
    await handleLiveSend(sendReq(payloadOf([EXCLUDE])), w.deps);
    const { payload } = syncPayload(s, words, c, NOW);
    const b = await bodyOf(await handleLiveSend(sendReq(payload), w.deps));
    assert.deepEqual(b.lines.map((l: any) => [l.id, l.outcome]), [["ad-1", "already"], ["ad-1-add1", "done"], ["ad-2", "done"]]);
    const m = loadSyncResult(JSON.stringify(b.result), store);
    assert.ok(m.ok);
    assert.equal(m.ok && m.marked, 3);
    assert.ok(s.proposals.every((p) => p.realAt));
    assert.ok(s.adds!.every((p) => p.realAt));
    const again = loadSyncResult(JSON.stringify(b.result), store);
    assert.equal(again.ok && again.marked, 0);
    // 反映済みの案は次の送る中身に入らない
    assert.equal(syncPayload(s, words, c, NOW).payload.items.length, 0);
    // 読み直しと印がそろっている
    const read = await bodyOf(await handleLiveRead(readReq(), w.deps));
    assert.deepEqual(driftOf(s, read as any, c.adGroup), []);
    // 読み直しの方が正しい：Google の側で止めたのを戻すと、印と違う1行
    w.google.criteria.find((k) => k.text === "美容院 安い")!.status = "ENABLED";
    const read2 = await bodyOf(await handleLiveRead(readReq(), w.deps));
    assert.match(driftOf(s, read2 as any, c.adGroup).join(), /止まっていません/);
  });

  test("分からない物は印を付けない・結果の1行の言い方", () => {
    assert.equal(outcomeText({ outcome: "done", text: "a" }), "「a」：反映した");
    assert.equal(outcomeText({ outcome: "already", reason: "もう止まっていた", text: "a" }), "「a」：もう止まっていた");
    assert.equal(outcomeText({ outcome: "failed", reason: "言葉が見つかりません", text: "a" }), "「a」：できなかった（言葉が見つかりません）");
    assert.equal(outcomeText({ outcome: "unknown", text: "a" }), "「a」：分からない（読み直してください）");
  });
});

describe("鍵の扱い（リポジトリ・設定）", () => {
  test("PEM や鍵の JSON をリポジトリに入れない（テストは generateKeyPairSync で作る）", () => {
    for (const f of ["src/lib/ads/__tests__/live.test.ts", "src/lib/ads/__tests__/fakeGoogle.ts", "config/ads.json", ".env.example"]) {
      const s = readFileSync(f, "utf8");
      assert.doesNotMatch(s, /-----BEGIN (RSA )?PRIVATE KEY-----\n[A-Za-z0-9+/]/, f);
      assert.doesNotMatch(s, /"private_key":\s*"-----BEGIN/, f);
    }
  });

  test(".env.example に4つの名前（値は空）", () => {
    const ex = readFileSync(".env.example", "utf8");
    for (const n of Object.values(LIVE_ENV)) assert.match(ex, new RegExp(`^${n}=$`, "m"));
  });
});

describe("README", () => {
  test("テスト用アカウントの節：何を・どの守りで・確かめていないこと・本番で確かめる前・言いすぎない", () => {
    const readme = readFileSync("README.md", "utf8");
    const sec = readme.slice(readme.indexOf("### Google 広告のテスト用アカウントに本当に送る"), readme.indexOf("### 道1"));
    for (const w of ["止める", "外す", "足す", "読み直す", "validateOnly", "テスト用アカウントかを新しく確かめ", "確かめていないこと", "Explorer", "広告文の無い、止めたキャンペーン"]) assert.ok(sec.includes(w), w);
    assert.match(sec, /本番で確かめる前です/);
    assert.doesNotMatch(sec, /100%|必ず|すぐ反映/);
    assert.doesNotMatch(sec, /出せる広告です/);
    // 「最初に戻す」で戻らない・残る物（データの置き場所の節）
    const data = readme.slice(readme.indexOf("## データの置き場所"), readme.indexOf("## LINE とつなぐ"));
    assert.match(data, /広告のテスト用アカウントに送った変更.*も戻りません/);
    assert.match(data, /「テスト用アカウントから読み直す」でだれでも見られます/);
    assert.match(data, /お客様・予約・カルテ・数字は送りません/);
    // 環境変数の表に4つ（Production だけ・審査では要らない）
    for (const n of Object.values(LIVE_ENV)) assert.match(readme, new RegExp(`\\| \`${n}\` \\| Vercel の Production だけ`));
  });
});
