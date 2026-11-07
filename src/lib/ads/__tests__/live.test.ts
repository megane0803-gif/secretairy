// 広告のテスト用アカウントに本当に送る窓口（docs/SPEC.md §1.7.8）。本物の Google は呼ばない（fetch を作り物の Google にする）。
// 鍵はテストの中で crypto.generateKeyPairSync で作る（PEM や鍵の JSON をリポジトリに入れない）。番号・メールも作り物だけ。

import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import { emptyBook } from "../../book/state";
import { getAds } from "../../data/seed";
import { memoryStore, upstashStore, type KvStore } from "../../line/store";
import { fakeUpstash } from "../../line/__tests__/fakeUpstash";
import { checkPasscode } from "../../server/passcode";
import { getAdSettings, getMenus, getShop, getSiteOrigin } from "../../settings";
import { RESULT_FORMAT, SYNC_FORMAT, SYNC_VERSION, syncPayload, type SyncPayload } from "../connect";
import { loadSyncResult } from "../connectLoad";
import { featuredWords } from "../featured";
import { gaqlString, VERIFY_QUERY } from "../live/api";
import { customerIdFrom, liveEnvFrom, LIVE_ENV, serviceKeyFrom } from "../live/env";
import { handleLiveRead, handleLiveSend, handleLiveSetup, handleLiveStatus, handleLiveTry, keywordProblem, LIVE_KEY, planTry, scrub, sourceBucket, sourceHash, sourceIp, type LiveDeps } from "../live/server";
import { accessToken, clearTokenCache, signedJwt } from "../live/token";
import { driftOf, LOST_MESSAGE, outcomeText, RESET_BY_TRY_NOTE } from "../live/client";
import { approvedNotice } from "../live/notice";
import { driftShown, livePanel, READ_LATER_NOTE, READ_LIMIT_NOTE, readFailedAfter, RESET_WHILE_SENDING, visibleRead, type LivePanelDeps, type LivePanelView } from "../live/panel";
import type { LiveReadResponse } from "../live/wire";
import { approveAd, approveAdd, EMPTY_ADS, tableOf, withReview, type AdsState } from "../state";
import { buildTable } from "../report";
import { fakeGoogle, type FakeGoogle } from "./fakeGoogle";
import { trialTable } from "../live/trial";

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
    trial: trialTable(getAds(), ads, words),
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
const tryReq = (body: unknown, h: Record<string, string> = {}) => {
  const r = req("/api/ads/live/try", { body });
  const headers = new Headers(r.headers);
  for (const [k, v] of Object.entries({ "x-real-ip": "203.0.113.7", ...h })) headers.set(k, v);
  return new Request(r.url, { method: "POST", headers, body: JSON.stringify(body) });
};

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
    for (const bad of ["{", "{}", JSON.stringify({ client_email: EMAIL, private_key: ["-----BEGIN", "PRIVATE KEY-----\nAAAA\n-----END", "PRIVATE KEY-----"].join(" ") }), "not json"])
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

  test("オーナーの用意・送るは「くわしく」の中・札と読み直すは広告の管理画面の下（名前は札だけ・鍵の環境変数を画面のコードで読まない）", () => {
    const page = readFileSync("src/app/ads/page.tsx", "utf8");
    const fold = page.slice(page.indexOf("<Fold"), page.indexOf("</Fold>"));
    assert.ok(fold.indexOf("<AdsConnect />") < fold.indexOf("<AdsLive />"), "渡す形の下");
    const ui = readFileSync("src/app/ads/AdsLive.tsx", "utf8");
    const view = readFileSync("src/app/ads/AdsLiveRead.tsx", "utf8");
    const report = readFileSync("src/app/ads/AdsReport.tsx", "utf8");
    assert.match(view, /つながっています・広告は出ません・お金は動きません/);
    assert.match(ui, /テスト用アカウントに店の広告を用意する/);
    assert.match(ui, /テスト用アカウントに送る/);
    assert.match(ui, /読み直しの一覧は、広告の管理画面の下に出ます/);
    assert.match(view, /テスト用アカウントから読み直す/);
    // 「読み直す」のボタンは画面に1つだけ（管理画面の下）
    assert.doesNotMatch(ui, /テスト用アカウントから読み直す/);
    assert.equal((view.match(/テスト用アカウントから読み直す"/g) ?? []).length, 1);
    // 管理画面のすぐ下・2つの一覧の上
    assert.ok(report.indexOf("</section>") < report.indexOf("<AdsLiveRead />") && report.indexOf("<AdsLiveRead />") < report.indexOf("広告を出す言葉（止められる）"));
    assert.match(view, /（つなぐ手順は README）/);
    assert.match(view, /つながっているか分かりませんでした（ページを読み込み直してください）/);
    assert.match(ui, /type="password"/);
    const flow = readFileSync("src/lib/ads/live/panel.ts", "utf8");
    assert.match(flow, /sameEpoch\(\{ epoch: d\.epoch\(\) \}, epoch\)/, "「最初に戻す」が途中で押されたら印を付けない");
    assert.match(flow, /if \(r\.created\) d\.journal/);
    const shared = readFileSync("src/lib/ads/live/usePanel.ts", "utf8");
    assert.match(shared, /epoch: currentEpoch/);
    for (const f of ["src/app/ads/AdsLive.tsx", "src/app/ads/AdsLiveRead.tsx", "src/lib/ads/live/usePanel.ts"])
      assert.doesNotMatch(readFileSync(f, "utf8"), /localStorage|sessionStorage|writeBrowser/, "合言葉をブラウザに残さない");
    for (const f of ["src/app/ads/AdsLive.tsx", "src/app/ads/AdsLiveRead.tsx", "src/lib/ads/live/usePanel.ts", "src/lib/ads/live/notice.ts", "src/lib/ads/live/client.ts", "src/lib/ads/live/panel.ts", "src/lib/ads/live/wire.ts", "src/lib/ads/connectLoad.ts"]) {
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
    assert.equal(b.created, false, "何も作らなかった時は日誌を書かない");
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

  test("用意で答えが届かず、読み直しても足りない時は「作りました」と言わない（分からない）", async () => {
    const w = await prepared();
    w.google.criteria = w.google.criteria.slice(2);
    w.google.hooks.dropBeforeMutate = true;
    const b = await bodyOf(await handleLiveSetup(setupReq(), w.deps));
    assert.equal(b.ok, false);
    assert.equal(b.code, "unknown");
    assert.doesNotMatch(JSON.stringify(b), /作りました/);
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

  test("本当に送った後、どれが受けられなかったか読めない時は「できなかった」にせず、読み直して決める", async () => {
    const w = await prepared();
    const realFetch = w.google.fetch;
    w.deps.fetch = async (url, init) => {
      const res = await realFetch(url, init);
      const b = url.endsWith(":mutate") ? JSON.parse(String(init.body)) : null;
      // 本当に送った時だけ、場所の無い部分の失敗を返す（変わってはいる）
      if (b && !b.validateOnly) return new Response(JSON.stringify({ mutateOperationResponses: [], partialFailureError: { code: 3, details: [{ errors: [{ errorCode: { x: "Y" } }] }] } }));
      return res;
    };
    const r = await bodyOf(await handleLiveSend(sendReq(payloadOf([EXCLUDE, ADD])), w.deps));
    assert.deepEqual(r.lines.map((l: any) => l.outcome), ["done", "done"]);
  });

  test("持ち時間を過ぎたら、新しく呼ばない（送る前なら「できなかった」）", async () => {
    const w = await prepared();
    const realFetch = w.google.fetch;
    let searches = 0;
    w.deps.fetch = async (url, init) => {
      if (url.endsWith(":search") && ++searches === 5) clock += live.serverBudgetSeconds * 1000; // 読む途中で時間が過ぎた
      return realFetch(url, init);
    };
    const n = w.google.mutateCalls.length;
    const r = await bodyOf(await handleLiveSend(sendReq(payloadOf([EXCLUDE])), w.deps));
    assert.equal(w.google.mutateCalls.length, n, "送っていない");
    assert.equal(r.lines[0].outcome, "failed");
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
      for (const r of [await handleLiveSetup(setupReq(p), w.deps), (await w.store!.del(LIVE_KEY.wrong), await w.store!.del(LIVE_KEY.locked), await handleLiveSend(sendReq(payloadOf([STOP]), p), w.deps))]) {
        assert.equal(r.status, 401);
        const text = await r.text();
        assert.equal(JSON.parse(text).code, "wrong");
        clean(text);
      }
      await w.store!.del(LIVE_KEY.wrong);
      await w.store!.del(LIVE_KEY.locked);
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

  test("受けない10分は、上限に届いた時から数える（最初の間違いからではない）", async () => {
    const w = await prepared();
    const max = live.passcode.maxWrong;
    const win = live.passcode.wrongWindowSeconds * 1000;
    await handleLiveSetup(setupReq("wrong-first-xxxxxxxxxx"), w.deps);
    clock += win - 60_000; // 最初の間違いから9分
    for (let i = 1; i < max; i++) await handleLiveSetup(setupReq(`wrong-${i}-xxxxxxxxxxxx`), w.deps);
    clock += 2 * 60_000; // 最初の間違いからは11分・上限に届いてからは2分
    assert.equal((await bodyOf(await handleLiveSend(sendReq(payloadOf([STOP])), w.deps))).code, "locked");
    clock += win;
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

  // ── 直しT：送った後・用意した後に、送る前に読んだ古い一覧を残さない（画面の流れは live/panel.ts） ──
  const READ_DAY = LIVE_KEY.day(TODAY, "read");
  const readCount = async (w: Awaited<ReturnType<typeof prepared>>) => Number((await w.store!.get(READ_DAY)) ?? 0);

  /** 画面の流れを、作り物の Google の窓口につなぐ（合言葉は押した時に渡す） */
  function panelOf(
    w: ReturnType<typeof world>,
    o: { read?: () => Promise<LiveReadResponse>; send?: LivePanelDeps["send"]; try?: LivePanelDeps["try"]; epoch?: () => string | undefined } = {},
  ) {
    let s = state();
    const store = { read: () => s, update: (f: (x: AdsState) => AdsState) => ((s = f(s)), { ok: true as const }), words, settings: c, journal: "テスト用の広告アカウントに送った" };
    const views: LivePanelView[] = [];
    const journal: string[] = [];
    let reads = 0;
    const serverRead = async () => (await bodyOf(await handleLiveRead(readReq(), w.deps))) as LiveReadResponse;
    const panel = livePanel({
      setup: async (code) => (await bodyOf(await handleLiveSetup(setupReq(code), w.deps))) as any,
      try: o.try ?? (async (kind, no) => (await bodyOf(await handleLiveTry(tryReq({ kind, no }), w.deps))) as any),
      send: o.send ?? (async (code, payload) => (await bodyOf(await handleLiveSend(sendReq(payload, code), w.deps))) as any),
      read: () => {
        reads += 1;
        return (o.read ?? serverRead)();
      },
      epoch: o.epoch ?? (() => "e1"),
      payload: () => syncPayload(s, words, c, NOW).payload,
      mark: (result) => loadSyncResult(JSON.stringify(result), store) as any,
      journal: (t) => void journal.push(t),
      onChange: (v) => void views.push(v),
    });
    return { panel, views, journal, reads: () => reads, ads: () => s, drift: (epoch: string | undefined = "e1") => driftShown(s, panel.view(), epoch, c.adGroup) };
  }
  /** 送る前の一覧を読んでおく（「美容院 安い」はまだ出す設定） */
  async function readBefore(p: ReturnType<typeof panelOf>) {
    await p.panel.reread();
    const before = p.panel.view().read!.list;
    assert.equal(before.keywords.find((k) => k.text === "美容院 安い")!.status, "出す設定");
    return before;
  }
  /** 一度読んだ後、送るの返事が来るまで止めておける送る */
  function deferred<T>() {
    let resolve!: (x: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  test("直しT：送った後に、送る前の一覧で「印がありますが〜」が出ない・送った後に1回だけ読み直し、新しい一覧で「止めている」", async () => {
    const w = await prepared();
    const p = panelOf(w);
    const before = await readBefore(p);
    // 直しS の時のまま（送る前の一覧と比べる）なら、出てしまう1行
    const n0 = await readCount(w);
    await p.panel.send(PASS);
    const v = p.panel.view();
    assert.match(v.shown!.head, /本物に反映済みの印を 3件 付けました/);
    assert.ok(v.shown!.lines.some((l) => /「美容院 安い」：反映した/.test(l)));
    assert.match(driftOf(p.ads(), before, c.adGroup).join(), /止まっていません/, "古い一覧と比べると出る1行");
    assert.deepEqual(p.drift(), [], "送った後の一覧とだけ比べる");
    assert.equal(v.read!.list.keywords.find((k) => k.text === "美容院 安い")!.status, "止めている");
    assert.deepEqual(v.read!.list.negatives, [{ text: "美容院 安い 学生", match: "完全一致" }]);
    assert.equal(p.reads(), 2, "読み直しを押した1回＋送った後の1回だけ");
    assert.equal((await readCount(w)) - n0, 1, "1日の読み直しの数も1つだけ増える");
    // 送っている間は古い一覧を出していない
    const during = p.views.filter((x) => x.busy === "send");
    assert.ok(during.length > 0);
    assert.ok(during.every((x) => x.read === null || x.read.seq > x.wroteSeq), "送っている間に送る前の一覧を出さない");
  });

  test("直しT：自動の読み直しは押している間の印で止まらない・送っている間に「読み直す」を押しても2回目は呼ばない", async () => {
    const w = await prepared();
    const gate = deferred<void>();
    const p = panelOf(w, {
      send: async (code, payload) => {
        await gate.promise;
        return (await bodyOf(await handleLiveSend(sendReq(payload, code), w.deps))) as any;
      },
    });
    const sending = p.panel.send(PASS);
    assert.equal(p.panel.view().busy, "send");
    await p.panel.reread(); // 押している間は受けない
    assert.equal(p.reads(), 0);
    gate.resolve();
    await sending;
    assert.equal(p.reads(), 1, "送った後の読み直しは1回だけ");
    assert.equal(p.panel.view().busy, null);
    assert.ok(p.panel.view().read, "送った後に読んだ一覧がある");
  });

  test("直しT：送った後の新しい一覧で本当に合わない時は今どおり「印がありますが〜」が出る（比べる働きは残す）", async () => {
    const w = await prepared();
    const p = panelOf(w);
    await p.panel.send(PASS);
    assert.deepEqual(p.drift(), []);
    // Google の側で止めたのを戻すと、次の読み直しで印と違う1行
    w.google.criteria.find((k) => k.text === "美容院 安い")!.status = "ENABLED";
    await p.panel.reread();
    assert.match(p.drift().join(), /「美容院 安い」は印がありますが、読み直すと止まっていません/);
    // 送る前（最後の送るより前に頼んだ）一覧とは比べない
    const stale: LivePanelView = { ...p.panel.view(), wroteSeq: p.panel.view().read!.seq };
    assert.deepEqual(driftShown(p.ads(), stale, "e1", c.adGroup), []);
  });

  test("直しT：読み直しの1日の上限に届いている時は、古い一覧を消して「今日の読み直しは上限です」の1行（送った結果は残す）", async () => {
    const w = await prepared();
    const p = panelOf(w);
    await readBefore(p);
    for (let n = await readCount(w); n < live.daily.read; n++) await w.store!.incr(READ_DAY, 86400);
    await p.panel.send(PASS);
    const v = p.panel.view();
    assert.equal(v.read, null, "古い一覧は消す");
    assert.match(v.shown!.head, /本物に反映済みの印を 3件/, "送った結果は残す");
    assert.equal(v.readNote, "送った結果は「くわしく」の中に出ています。今日の読み直しは上限です。明日また読み直せます");
    assert.equal(READ_LIMIT_NOTE, "今日の読み直しは上限です。明日また読み直せます");
    assert.deepEqual(p.drift(), []);
  });

  test("直しT：送るはうまくいって読み直しだけ断られた時は「送った結果は〜に出ています。いまは読み直せませんでした（理由）」（送れなかったと読めない。直しU で場所に合う言い方）", async () => {
    const w = await prepared();
    let lose = false;
    const p = panelOf(w, { read: async () => (lose ? { ok: false, code: "lost", message: LOST_MESSAGE } : ((await bodyOf(await handleLiveRead(readReq(), w.deps))) as LiveReadResponse)) });
    await readBefore(p);
    lose = true;
    await p.panel.send(PASS);
    const v = p.panel.view();
    assert.equal(v.read, null);
    assert.match(v.shown!.head, /本物に反映済みの印を 3件/);
    assert.equal(v.readNote, "送った結果は「くわしく」の中に出ています。いまは読み直せませんでした（返事が届きませんでした）");
    assert.doesNotMatch(v.readNote!, /送れ(な|ませ|たか)/);
    assert.equal(readFailedAfter("send", { ok: false, code: "no-store", message: "置き場につながりません。" }), "送った結果は「くわしく」の中に出ています。いまは読み直せませんでした（置き場につながりません）");
  });

  test("直しT：「用意」の後も同じ（用意の前の「キャンペーンがまだありません」を残さない・用意した後に1回だけ読み直す）", async () => {
    const w = world();
    const p = panelOf(w);
    await p.panel.reread();
    assert.match(p.panel.view().readNote!, /キャンペーンがまだありません/);
    await p.panel.setup(PASS);
    const v = p.panel.view();
    assert.equal(v.shown!.head, "✓ 用意しました");
    assert.equal(v.readNote, null, "用意の前の1行は残さない");
    assert.equal(v.read!.list.campaign.found, true);
    assert.equal(v.read!.list.keywords.length, 8);
    assert.equal(p.reads(), 2);
    assert.deepEqual(p.journal, ["テスト用の広告アカウントに店の広告を用意した"]);
    // もう用意してある時も、読み直しは新しい物
    await p.panel.setup(PASS);
    assert.equal(p.panel.view().shown!.head, "もう用意してあります");
    assert.equal(p.reads(), 3);
    assert.equal(p.journal.length, 1, "何も作らなかった時は日誌を書かない");
  });

  test("直しT：送るが断られた・分からない・「最初に戻す」が押された時も古い一覧は消え、送った結果の知らせは残る", async () => {
    // 断られた（合言葉がちがう）：何も変わっていないので読み直さず、「読み直す」で見られるの1行
    {
      const w = await prepared();
      const p = panelOf(w);
      await readBefore(p);
      await p.panel.send("owner-passcode-wrong-0000");
      const v = p.panel.view();
      assert.equal(v.read, null);
      assert.equal(v.shown!.head, "オーナー用の合言葉がちがいます");
      assert.equal(v.readNote, READ_LATER_NOTE);
      assert.equal(p.reads(), 1, "断られた時は読み直さない");
      assert.deepEqual(p.drift(), []);
    }
    // 分からない（返事が届かなかった）：古い一覧を消し、知らせは残して1回だけ読み直す
    {
      const w = await prepared();
      const p = panelOf(w, { send: async () => ({ ok: false, code: "lost", message: LOST_MESSAGE }) });
      await readBefore(p);
      await p.panel.send(PASS);
      const v = p.panel.view();
      assert.equal(v.shown!.head, LOST_MESSAGE);
      assert.equal(p.reads(), 2);
      assert.ok(v.read && v.read.seq > v.wroteSeq, "送った後に読んだ一覧");
    }
    // 送っている間に「最初に戻す」：印は付けず、古い一覧は消え、戻した後の印で読み直す
    {
      const w = await prepared();
      let epoch = "e1";
      const p = panelOf(w, {
        epoch: () => epoch,
        send: async (code, payload) => {
          const r = (await bodyOf(await handleLiveSend(sendReq(payload, code), w.deps))) as any;
          epoch = "e2";
          return r;
        },
      });
      await readBefore(p);
      await p.panel.send(PASS);
      const v = p.panel.view();
      assert.equal(v.shown!.head, RESET_WHILE_SENDING);
      assert.ok(v.shown!.lines.some((l) => /反映した/.test(l)), "送った結果の行は残す");
      assert.ok(p.ads().proposals.every((x) => !x.realAt), "印は付けない");
      assert.equal(v.read!.epoch, "e2");
      assert.ok(visibleRead(v, "e2"));
      assert.equal(visibleRead(v, "e1"), null);
    }
  });

  test("直しT：読み直しの返事が遅れて届き、その間に「最初に戻す」かもっと新しい頼みがあった時は出さない", async () => {
    const w = await prepared();
    let epoch = "e1";
    let hold: ReturnType<typeof deferred<LiveReadResponse>> | null = null;
    const p = panelOf(w, {
      epoch: () => epoch,
      read: async () => {
        const r = (await bodyOf(await handleLiveRead(readReq(), w.deps))) as LiveReadResponse;
        if (!hold) return r;
        const h = hold;
        hold = null;
        return h.promise;
      },
    });
    await p.panel.reread();
    const first = p.panel.view().read!;
    // ① 返事を待っている間に「最初に戻す」
    hold = deferred<LiveReadResponse>();
    const h1 = hold;
    const late1 = p.panel.reread();
    epoch = "e2";
    h1.resolve({ ok: true, campaign: { found: true, status: "古い返事" }, keywords: [], negatives: [] });
    await late1;
    assert.notEqual(p.panel.view().read?.list.campaign.status, "古い返事");
    assert.equal(p.panel.view().read, first, "遅れた返事で書きかえない");
    assert.equal(visibleRead(p.panel.view(), "e2"), null, "戻す前の一覧も出さない");
    // ② 返事を待っている間に、もっと新しい頼み（画面が「最初に戻す」を見て forget する）
    hold = deferred<LiveReadResponse>();
    const h2 = hold;
    const late2 = p.panel.reread();
    p.panel.forget();
    h2.resolve({ ok: true, campaign: { found: true, status: "古い返事" }, keywords: [], negatives: [] });
    await late2;
    assert.equal(p.panel.view().read, null);
    // ③ 次の読み直しはふつうに出る
    await p.panel.reread();
    assert.equal(p.panel.view().read!.epoch, "e2");
    assert.equal(p.panel.view().read!.list.campaign.found, true);
  });

  test("直しT・直しU：画面は live/panel.ts の流れ1つを通す（送る前の一覧と比べない・自分で読み直しの番号を数えない）", () => {
    const shared = readFileSync("src/lib/ads/live/usePanel.ts", "utf8");
    assert.equal((shared.match(/livePanel\(/g) ?? []).length, 1, "流れを作るのは1か所");
    assert.match(shared, /sharedPanel\(\)\.forget\(\)/, "「最初に戻す」を見て流れている読み直しを捨てる");
    const files = ["src/app/ads/AdsLive.tsx", "src/app/ads/AdsLiveRead.tsx", "src/components/AdApprovalRows.tsx", "src/components/AdAddRow.tsx", "src/app/ads/AdsReport.tsx"];
    for (const f of files) {
      const ui = readFileSync(f, "utf8");
      assert.doesNotMatch(ui, /livePanel\(/, `${f} は流れを自分で作らない`);
      assert.doesNotMatch(ui, /driftOf\(/, "古い一覧と比べる形を画面に残さない");
      assert.doesNotMatch(ui, /setRead\(|setReadNote\(/);
      assert.doesNotMatch(ui, /liveTry\(|LIVE_PATHS/, `${f} は窓口を直に呼ばない`);
    }
    const view = readFileSync("src/app/ads/AdsLiveRead.tsx", "utf8");
    assert.match(view, /driftShown\(/);
    assert.match(view, /visibleRead\(/);
  });

  // ── 直しU：だれでも承認したら試す（同じ流れ1つ） ──

  test("直しU：試すは1回だけ呼び、返事の一覧（窓口の中で読み直した物）を出す。この道では「本物に反映済み」の印を付けない", async () => {
    const w = await prepared();
    let tries = 0;
    const p = panelOf(w, { try: async (kind, no) => (tries++, (await bodyOf(await handleLiveTry(tryReq({ kind, no }), w.deps))) as any) });
    const pending = syncPayload(p.ads(), words, c, NOW).payload.items.length;
    await readBefore(p);
    assert.equal(await p.panel.tryOne({ kind: "stop", no: 7, text: "髪型 流行り" }), true);
    const v = p.panel.view();
    assert.equal(tries, 1);
    assert.equal(p.reads(), 1, "試した後に別に読み直さない（窓口の返事の一覧を使う）");
    assert.equal(v.tried!.state, "done");
    assert.ok(v.read && v.read.seq > v.wroteSeq);
    assert.equal(v.read!.list.keywords.find((k) => k.text === "髪型 流行り")!.status, "止めている");
    assert.ok([...p.ads().proposals, ...(p.ads().adds ?? [])].every((x) => !x.realAt), "印は付けない");
    assert.equal(syncPayload(p.ads(), words, c, NOW).payload.items.length, pending, "送る案の数は今どおり");
    assert.deepEqual(p.drift(), [], "印が無いので「印がありますが〜」も出ない");
    assert.equal(v.busy, null);
  });

  test("直しU：返事が届かない・分からない時も、自動では呼び直さない（読み直しも自動ではしない）", async () => {
    for (const answer of [{ ok: false, code: "lost", message: LOST_MESSAGE }, { ok: true, line: { kind: "stop", no: 7, text: "髪型 流行り", outcome: "unknown", reason: "分かりません（読み直してください）" }, list: null }] as const) {
      const w = await prepared();
      let tries = 0;
      const p = panelOf(w, { try: async () => (tries++, answer as any) });
      await p.panel.tryOne({ kind: "stop", no: 7, text: "髪型 流行り" });
      assert.equal(tries, 1);
      assert.equal(p.reads(), 0);
      assert.equal(p.panel.view().tried!.state, "unknown");
      assert.equal(p.panel.view().readNote, READ_LATER_NOTE);
      const note = approvedNotice({ kind: "stop", no: 7, text: "髪型 流行り", todo: true, route: "started" }, p.panel.view().tried, "ads");
      assert.match(note, /送れたか分かりません/);
      assert.doesNotMatch(note, /できなかった|送れませんでした/);
    }
    const ui = readFileSync("src/lib/ads/live/usePanel.ts", "utf8") + readFileSync("src/components/AdApprovalRows.tsx", "utf8") + readFileSync("src/components/AdAddRow.tsx", "utf8");
    assert.equal((ui.match(/tryOne\(/g) ?? []).length, 1, "試すを呼ぶのは tryAfterApprove の1か所");
    assert.doesNotMatch(ui, /setInterval|setTimeout|retry/i, "呼び直さない");
  });

  test("直しU：試している間は「読み直す」も「用意」「送る」も、もう1つの試すも動かない・「最初に戻す」の後に遅れた返事を出さない・上限の1行", async () => {
    const w = await prepared();
    let epoch = "e1";
    const hold = deferred<any>();
    const p = panelOf(w, { epoch: () => epoch, try: () => hold.promise });
    const first = p.panel.tryOne({ kind: "stop", no: 7, text: "髪型 流行り" });
    assert.equal(p.panel.view().busy, "try");
    await p.panel.reread();
    await p.panel.setup(PASS);
    assert.equal(await p.panel.tryOne({ kind: "add", no: 11, text: "縮毛矯正 くせ毛 ひどい" }), false);
    assert.equal(p.reads(), 0);
    epoch = "e2";
    hold.resolve({ ok: true, line: { kind: "stop", no: 7, text: "髪型 流行り", outcome: "done" }, list: { ok: true, campaign: { found: true, status: "古い返事" }, keywords: [], negatives: [] } });
    await first;
    assert.equal(p.panel.view().tried, null, "戻した後は知らせを出さない");
    assert.equal(p.panel.view().read, null, "戻した後は一覧を出さない");
    // 上限：理由つきで「いまは送れませんでした」
    const p2 = panelOf(w, { try: async () => ({ ok: false, code: "limit", message: `今日の試しは、同じ送り元から${live.try.perSourceDay}回までです。明日また試せます` }) });
    await p2.panel.tryOne({ kind: "stop", no: 7, text: "髪型 流行り" });
    const note = approvedNotice({ kind: "stop", no: 7, text: "髪型 流行り", todo: true, route: "started" }, p2.panel.view().tried, "ads");
    assert.equal(note, `7番「髪型 流行り」：広告の管理画面には反映しました。テスト用の広告アカウントへは、いまは送れませんでした（今日の試しは、同じ送り元から${live.try.perSourceDay}回までです。明日また試せます）。ToDo に「効いたか見る」を足しました。`);
  });

  test("直しU：オーナーの印は、試しで元に戻した後なら「比べない側」の1行になる", async () => {
    const w = await prepared();
    const p = panelOf(w);
    await p.panel.send(PASS);
    assert.ok(p.ads().proposals.every((x) => x.realAt));
    assert.deepEqual(p.drift(), []);
    clock += 60_000;
    await p.panel.tryOne({ kind: "stop", no: 7, text: "髪型 流行り" });
    // テストの時計（clock）とブラウザの印の時刻をそろえる：印は試すより前
    const v = p.panel.view();
    assert.ok(v.read!.list.resetAt);
    const marked = p.ads().proposals.map((x) => ({ ...x, realAt: "2026-11-07T00:00:00.000Z" }));
    assert.deepEqual(driftShown({ ...p.ads(), proposals: marked, adds: p.ads().adds?.map((x) => ({ ...x, realAt: "2026-11-07T00:00:00.000Z" })) }, v, "e1", c.adGroup), [RESET_BY_TRY_NOTE]);
  });

  test("直しU：承認の知らせ（止める・外す・足す・ホーム）にサービスの名前が無い・お金は動かない・ホームは「一覧は広告のタブで」", () => {
    const a = (kind: "stop" | "exclude" | "add", no: number, text: string) => ({ kind, no, text, todo: kind !== "add", route: "started" as const });
    const tried = (x: ReturnType<typeof a>, state: "done" | "already") => ({ kind: x.kind, no: x.no, text: x.text, state });
    const stop = a("stop", 7, "髪型 流行り");
    assert.equal(
      approvedNotice(stop, tried(stop, "done"), "ads"),
      "✓ 7番「髪型 流行り」を止めました。テスト用の広告アカウントを元の形に戻してから送り、読み直して止まったのを確かめました（広告は出ず、お金は動きません）。ToDo に「効いたか見る」を足しました。",
    );
    const all = [stop, a("exclude", 10, "美容院 安い 学生"), a("add", 11, "縮毛矯正 くせ毛 ひどい")].flatMap((x) =>
      (["ads", "home"] as const).flatMap((where) => [
        approvedNotice(x, tried(x, "done"), where),
        approvedNotice(x, tried(x, "already"), where),
        approvedNotice(x, { ...tried(x, "done"), state: "refused", reason: "広告の側で受けられませんでした" }, where),
        approvedNotice(x, null, where),
        approvedNotice({ ...x, route: "off" }, null, where),
        approvedNotice({ ...x, route: "unknown" }, null, where),
        approvedNotice({ ...x, route: "not-run" }, null, where),
      ]),
    );
    for (const n of all) {
      assert.doesNotMatch(n, /Google|グーグル|100%|必ず|すぐ反映|本物の広告/, n);
    }
    assert.match(approvedNotice(stop, tried(stop, "done"), "home"), /一覧は広告のタブで見られます/);
    assert.doesNotMatch(approvedNotice(stop, tried(stop, "done"), "ads"), /一覧は広告のタブ/);
    assert.match(approvedNotice({ ...stop, route: "off" }, null, "home"), /つないでいないので、送っていません/);
    assert.match(approvedNotice({ ...stop, route: "unknown" }, null, "ads"), /ページを読み込み直してください/);
    assert.match(approvedNotice(a("add", 11, "縮毛矯正 くせ毛 ひどい"), tried(a("add", 11, "縮毛矯正 くせ毛 ひどい"), "done"), "ads"), /足されたのを確かめました（広告は出ず、お金は動きません）/);
  });

  test("直しU：承認BOXの広告の「承認」は試している間は押せない・試すのは広告のタブとホームの承認だけ（LINE のボタン・戻す案からは呼ばない）", () => {
    const rows = readFileSync("src/components/AdApprovalRows.tsx", "utf8");
    const add = readFileSync("src/components/AdAddRow.tsx", "utf8");
    assert.match(rows, /onClick=\{\(e\) => approve\(e, p\)\} disabled=\{busy \|\| liveBusy\}/);
    assert.match(rows, /if \(live\.view\.busy\) return;/);
    assert.match(add, /onClick=\{approve\} disabled=\{liveBusy\}/);
    assert.match(add, /if \(liveBusy\) return;/);
    assert.match(rows, /startTry\(\{ kind: x\.action, no: x\.no, text: x\.text, todo: true \}/);
    assert.match(add, /startTry\(\{ kind: "add", no: p\.no, text: p\.text, todo: false \}/);
    // 作品の中の承認（approveAd・approveAdd）は窓口より先に・窓口に依らずに効く
    assert.ok(rows.indexOf("approveAd(a, b, x.id") < rows.indexOf("startTry({ kind: x.action"));
    assert.ok(add.indexOf("approveAdd(a, p.id") < add.indexOf('startTry({ kind: "add"'));
    // ホームの承認BOX（standalone でない時）も知らせの1行を出す
    assert.match(rows, /<AdRevertRow onDone=\{setDone\} \/>\n        \{done && \(/);
    for (const f of ["src/components/AdRevertRow.tsx", "src/lib/line/apply.ts", "src/components/LineBridge.tsx", "src/lib/ads/verdict.ts"]) {
      const s = readFileSync(f, "utf8");
      assert.doesNotMatch(s, /startTry|tryAfterApprove|liveTry|tryOne|\/api\/ads\/live\/try/, f);
    }
    const route = readFileSync("src/app/api/ads/live/try/route.ts", "utf8");
    assert.match(route, /export async function POST/);
    assert.match(route, /handleLiveTry/);
  });

  test("直しU：画面の言葉に「本物の広告にはつながっていません」「（今はつないでいません）」が残っていない", () => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "__tests__" ? [] : walk(`${d}/${e.name}`)) : /\.(tsx?|json)$/.test(e.name) ? [`${d}/${e.name}`] : []));
    for (const f of [...walk("src"), ...walk("config")]) {
      const s = readFileSync(f, "utf8");
      assert.doesNotMatch(s, /本物の広告にはつながっていません|（今はつないでいません）/, f);
    }
  });

  test("分からない物は印を付けない・結果の1行の言い方", () => {
    assert.equal(outcomeText({ outcome: "done", text: "a" }), "「a」：反映した");
    assert.equal(outcomeText({ outcome: "already", reason: "もう止まっていた", text: "a" }), "「a」：もう止まっていた");
    assert.equal(outcomeText({ outcome: "failed", reason: "言葉が見つかりません", text: "a" }), "「a」：できなかった（言葉が見つかりません）");
    assert.equal(outcomeText({ outcome: "unknown", text: "a" }), "「a」：分からない（読み直してください）");
  });
});

describe("直しU：だれでも承認したら試す（元の形に戻す → 1件 → 読み直す）", () => {
  const DAY = "2026-11-07";
  const IP = "203.0.113.7";
  const T = live.try;
  type Mem = ReturnType<typeof memoryStore>;
  const SETUP = getAds().keywords.map((k) => k.text);

  /** 前の人が試した後の形（止めた・外した・足した・ほかの言葉・同じ言葉の2つ目・キャンペーンが出す設定） */
  function messy(g: FakeGoogle) {
    const grp = g.groups[0];
    const camp = g.campaigns[0];
    g.criteria.find((k) => k.text === "美容院 安い")!.status = "PAUSED";
    g.criteria.push({ groupId: grp.id, id: 5001, text: "縮毛矯正 くせ毛 ひどい", match: "PHRASE", status: "ENABLED" });
    g.criteria.push({ groupId: grp.id, id: 5002, text: "勝手な言葉", match: "BROAD", status: "ENABLED" });
    g.criteria.push({ groupId: grp.id, id: 5003, text: "髪型 流行り", match: "EXACT", status: "ENABLED" });
    g.negatives.push({ campaignId: camp.id, id: 5004, text: "美容院 安い 学生", match: "EXACT", status: "ENABLED" });
    camp.status = "ENABLED";
  }

  /** 元の形にその1件を足した形か（作品の広告グループ・キャンペーンのキーワードの除外（完全一致）・キャンペーンの状態） */
  function atBasePlus(g: FakeGoogle, item: { kind: "stop" | "exclude" | "add"; text: string } | null) {
    const grp = g.groups[0];
    const kws = g.criteria.filter((k) => k.groupId === grp.id);
    const want = [...SETUP, ...(item?.kind === "add" ? [item.text] : [])];
    assert.deepEqual(kws.map((k) => k.text).sort(), [...want].sort(), "用意の言葉（と足した1件）のほかは無い・2つ目も無い");
    for (const k of kws) {
      assert.equal(k.match, "PHRASE", k.text);
      assert.equal(k.status, item?.kind === "stop" && item.text === k.text ? "PAUSED" : "ENABLED", k.text);
    }
    assert.deepEqual(
      g.negatives.filter((n) => n.match === "EXACT").map((n) => n.text),
      item?.kind === "exclude" ? [item.text] : [],
    );
    assert.equal(g.campaigns[0].status, "PAUSED");
  }

  /** 送る操作の中で、同じ物を2回さわっていない */
  function touchedOnce(ops: Record<string, unknown>[]) {
    const refs = ops.map((op) => {
      const inner = Object.values(op)[0] as Record<string, any>;
      return String(inner.remove ?? inner.update?.resourceName ?? `create:${JSON.stringify(inner.create?.keyword)}`);
    });
    assert.equal(new Set(refs).size, refs.length, `重ならない：${refs.join(" / ")}`);
    return refs;
  }

  const tryBody = async (w: { deps: LiveDeps }, body: unknown, h: Record<string, string> = {}) => {
    const r = await handleLiveTry(tryReq(body, h), w.deps);
    const text = await r.clone().text();
    clean(text);
    return { status: r.status, b: (await r.json()) as Record<string, any>, text };
  };

  test("承認した1件ごとに、元の形に戻してから送り、同じ流れで読み直す（前の人の止めた・外した・足した物は消える）", async () => {
    const w = await prepared();
    messy(w.google);
    const before = w.google.mutateCalls.length;
    const s0 = w.google.searchCount;
    // 7番を止める
    const r1 = await tryBody(w, { kind: "stop", no: 7 });
    assert.equal(r1.status, 200, r1.text);
    assert.equal(r1.b.line.outcome, "done");
    assert.deepEqual(Object.keys(r1.b).sort(), ["line", "list", "ok"], "返事は結果の行と一覧だけ");
    assert.deepEqual(Object.keys(r1.b.line).sort(), ["kind", "no", "outcome", "text"]);
    atBasePlus(w.google, { kind: "stop", text: "髪型 流行り" });
    // 先に validateOnly、通ったら1回の mutate（全部できるか、何もできないか）
    const m = w.google.mutateCalls.slice(before);
    assert.deepEqual(m.map((x) => [x.validateOnly, x.partialFailure]), [[true, false], [false, false]]);
    assert.deepEqual(m[0].ops, m[1].ops);
    // 送った後に読み直した（この窓口の中で。「読み直す」の数には足さない）
    assert.ok(w.google.searchCount > s0 + 6);
    assert.equal(await w.store!.get(LIVE_KEY.day(DAY, "read")), null);
    const k7 = r1.b.list.keywords.find((k: any) => k.text === "髪型 流行り");
    assert.equal(k7.status, "止めている");
    assert.equal(r1.b.list.negatives.length, 0);
    assert.ok(r1.b.list.resetAt);
    // 次の人：10番を外す → 7番は出す設定に戻り、外すの1件だけ
    const r2 = await tryBody(w, { kind: "exclude", no: 10 });
    assert.equal(r2.b.line.outcome, "done");
    atBasePlus(w.google, { kind: "exclude", text: "美容院 安い 学生" });
    // 次の人：11番を足す → 外したのは消え、足すの1件だけ
    const r3 = await tryBody(w, { kind: "add", no: 11 });
    assert.equal(r3.b.line.outcome, "done");
    atBasePlus(w.google, { kind: "add", text: "縮毛矯正 くせ毛 ひどい" });
    // もうその形の時は書かない（「もうその形でした」）
    const n = w.google.mutateCalls.length;
    const r4 = await tryBody(w, { kind: "add", no: 11 });
    assert.equal(r4.b.line.outcome, "already");
    assert.equal(w.google.mutateCalls.length, n);
  });

  test("元に戻す操作と1件の操作は同じ物に重ならない（止める・外す・足すの3つそれぞれ）", async () => {
    // 止める：前の人が7番を止めていたら、7番には何もしない（戻してから止める、にしない）。ほかの止めたのは出す設定に
    {
      const w = await prepared();
      messy(w.google);
      w.google.criteria.find((k) => k.text === "髪型 流行り" && k.match === "PHRASE")!.status = "PAUSED";
      const k7 = w.google.criteria.find((k) => k.text === "髪型 流行り" && k.match === "PHRASE")!;
      await tryBody(w, { kind: "stop", no: 7 });
      const ops = writes(w.google)[writes(w.google).length - 1].ops;
      const refs = touchedOnce(ops);
      assert.ok(!refs.some((r) => r.endsWith(`~${k7.id}`)), "7番はさわらない");
      const k3 = w.google.criteria.find((k) => k.text === "美容院 安い")!;
      assert.equal(ops.filter((o) => JSON.stringify(o).includes(`~${k3.id}"`)).length, 1);
      atBasePlus(w.google, { kind: "stop", text: "髪型 流行り" });
    }
    // 止める：7番が出す設定なら、7番は止める1回だけ
    {
      const w = await prepared();
      messy(w.google);
      const k7 = w.google.criteria.find((k) => k.text === "髪型 流行り" && k.match === "PHRASE")!;
      await tryBody(w, { kind: "stop", no: 7 });
      const ops = writes(w.google)[writes(w.google).length - 1].ops;
      touchedOnce(ops);
      const mine = ops.filter((o) => JSON.stringify(o).includes(`~${k7.id}"`));
      assert.deepEqual(mine, [{ adGroupCriterionOperation: { update: { resourceName: `customers/${CUSTOMER}/adGroupCriteria/${k7.groupId}~${k7.id}`, status: "PAUSED" }, updateMask: "status" } }]);
    }
    // 外す：同じ除外がもうあれば、それは残して重ねない（作らない・消さない）
    {
      const w = await prepared();
      messy(w.google);
      await tryBody(w, { kind: "exclude", no: 10 });
      const ops = writes(w.google)[writes(w.google).length - 1].ops;
      touchedOnce(ops);
      assert.ok(!ops.some((o) => "campaignCriterionOperation" in o), "もうある除外はさわらない");
      atBasePlus(w.google, { kind: "exclude", text: "美容院 安い 学生" });
    }
    // 足す：同じ言葉（フレーズ一致）がもうあれば、作らず（出す設定のまま）・完全一致の2つ目は消す
    {
      const w = await prepared();
      messy(w.google);
      await tryBody(w, { kind: "add", no: 11 });
      const ops = writes(w.google)[writes(w.google).length - 1].ops;
      touchedOnce(ops);
      assert.ok(!ops.some((o) => JSON.stringify(o).includes('"create"')), "作らない");
      atBasePlus(w.google, { kind: "add", text: "縮毛矯正 くせ毛 ひどい" });
      // 足すが無い時は作る1回
      const w2 = await prepared();
      await tryBody(w2, { kind: "add", no: 14 });
      const ops2 = writes(w2.google)[writes(w2.google).length - 1].ops;
      assert.deepEqual(ops2, [{ adGroupCriterionOperation: { create: { adGroup: `customers/${CUSTOMER}/adGroups/${w2.google.groups[0].id}`, status: "ENABLED", keyword: { text: "ヘッドスパ 眠れる", matchType: "PHRASE" } } } }]);
    }
  });

  test("validateOnly で断られたら何も書かない（Google の生の文・番号は返事に出ない）", async () => {
    const w = await prepared();
    messy(w.google);
    w.google.hooks.rejectText = "縮毛矯正 くせ毛 ひどい";
    w.google.criteria = w.google.criteria.filter((k) => k.id !== 5001);
    const snap = JSON.stringify(w.google.criteria);
    const r = await tryBody(w, { kind: "add", no: 11 });
    assert.equal(r.status, 502);
    assert.equal(r.b.code, "rejected");
    assert.equal(writes(w.google).length, 1, "用意の1回のほかに書いていない");
    assert.equal(JSON.stringify(w.google.criteria), snap);
    assert.doesNotMatch(r.text, /invalid argument|secret detail|POLICY|9000000/i);
  });

  test("送る1件はサーバーで確かめ直す：2件以上・表に無い番号・用意の言葉のほかを止める・町の名前を外す・足す案を通らない・大きすぎる・形の違う物は書かずに断る", async () => {
    const w = await prepared();
    const n = w.google.mutateCalls.length;
    const bad: [unknown, number][] = [
      [{ items: [{ kind: "stop", no: 7 }, { kind: "stop", no: 3 }] }, 400],
      [{ kind: "stop", no: [7, 3] }, 400],
      [{ kind: ["stop", "add"], no: 7 }, 400],
      [{ kind: "stop", no: 99 }, 400],
      [{ kind: "stop", no: 9 }, 400],
      [{ kind: "exclude", no: 3 }, 400],
      [{ kind: "exclude", no: 9 }, 400],
      [{ kind: "add", no: 10 }, 400],
      [{ kind: "add", no: 15 }, 400],
      [{ kind: "add", no: 9 }, 400],
      [{ kind: "add", no: 2 }, 400],
      [{ kind: "remove", no: 7 }, 400],
      [{ kind: "stop", no: "7" }, 400],
      [{ kind: "stop", no: 7.5 }, 400],
      [{ kind: "stop" }, 400],
      [[{ kind: "stop", no: 7 }], 400],
      [{ kind: "stop", no: 7, pad: "x".repeat(T.maxRequestChars) }, 413],
    ];
    for (const [body, status] of bad) {
      const r = await tryBody(w, body);
      assert.equal(r.status, status, JSON.stringify(body).slice(0, 80));
    }
    // 形の読めない JSON
    const raw = req("/api/ads/live/try", { body: {} });
    const broken = await handleLiveTry(new Request(raw.url, { method: "POST", headers: raw.headers, body: "{kind:" }), w.deps);
    assert.equal(broken.status, 400);
    assert.equal(w.google.mutateCalls.length, n, "何も書いていない");
    // 用意の言葉（setupKeywords）にない言葉は止めない
    const w2 = await prepared();
    w2.deps.setupKeywords = SETUP.filter((t) => t !== "髪型 流行り");
    const r2 = await tryBody(w2, { kind: "stop", no: 7 });
    assert.equal(r2.status, 400);
    assert.match(r2.b.message, /用意した言葉のほかは止めません/);
    // 町の名前・足す案の確かめの理由
    assert.match((await tryBody(w, { kind: "exclude", no: 9 })).b.message, /町の名前/);
    assert.match((await tryBody(w, { kind: "add", no: 10 })).b.message, /足す案の確かめ/);
    // 足してよい番号は、最初の表で add.ts の確かめを通る物だけ（11番・14番）
    assert.deepEqual([...w.deps.trial.addable].sort((a, b) => a - b), [11, 14]);
  });

  test("言葉（text）を付けて送っても使わない：書かれるのは表の番号の言葉だけ", async () => {
    const w = await prepared();
    const r = await tryBody(w, { kind: "add", no: 11, text: "好きな文字 ここに書く", payload: undefined });
    assert.equal(r.b.line.outcome, "done");
    assert.equal(r.b.line.text, "縮毛矯正 くせ毛 ひどい");
    assert.ok(!w.google.criteria.some((k) => k.text.includes("好きな文字")));
    assert.ok(!JSON.stringify(w.google.mutateCalls).includes("好きな文字"));
    const r2 = await tryBody(w, { kind: "exclude", no: 10, text: "勝手な除外" });
    assert.equal(r2.b.line.text, "美容院 安い 学生");
    assert.ok(!w.google.negatives.some((x) => x.text.includes("勝手")));
  });

  test("元に戻すは、地域・言語などのほかの条件・完全一致でない除外・ほかの広告グループ・予算・名前に触らない", async () => {
    const w = await prepared();
    messy(w.google);
    const camp = w.google.campaigns[0];
    w.google.others.push({ campaignId: camp.id, id: 6001, type: "LOCATION", negative: true, status: "ENABLED" });
    w.google.others.push({ campaignId: camp.id, id: 6002, type: "LANGUAGE", negative: false, status: "ENABLED" });
    w.google.negatives.push({ campaignId: camp.id, id: 6003, text: "求人", match: "PHRASE", status: "ENABLED" });
    w.google.groups.push({ id: 6004, campaignId: camp.id, name: "ほかのグループ", status: "ENABLED" });
    w.google.criteria.push({ groupId: 6004, id: 6005, text: "ほかの言葉", match: "PHRASE", status: "ENABLED" });
    const budgets = JSON.stringify(w.google.budgets);
    const name = camp.name;
    const groupName = w.google.groups[0].name;
    const r = await tryBody(w, { kind: "stop", no: 7 });
    assert.equal(r.b.line.outcome, "done");
    assert.equal(w.google.others.length, 2);
    assert.ok(w.google.negatives.some((n) => n.id === 6003), "完全一致でない除外は残す");
    assert.ok(w.google.criteria.some((k) => k.id === 6005), "ほかの広告グループの言葉は残す");
    assert.equal(JSON.stringify(w.google.budgets), budgets);
    assert.equal(w.google.campaigns[0].name, name);
    assert.equal(w.google.groups[0].name, groupName);
    const ops = writes(w.google)[writes(w.google).length - 1].ops;
    const kinds = new Set(ops.map((o) => `${Object.keys(o)[0]}:${Object.keys(Object.values(o)[0] as object).filter((k) => k !== "updateMask")[0]}`));
    for (const k of kinds) assert.ok(["campaignOperation:update", "adGroupCriterionOperation:update", "adGroupCriterionOperation:remove", "campaignCriterionOperation:remove"].includes(k), k);
    const cu = ops.find((o) => "campaignOperation" in o) as any;
    assert.deepEqual(Object.keys(cu.campaignOperation.update).sort(), ["resourceName", "status"], "キャンペーンは状態だけ");
    // planTry はほかのアカウントの物を操作に入れない（読む時に mine() で落とす）
    const plan = planTry({ campaign: { rn: "customers/1111111111/campaigns/1", status: "ENABLED" }, campaigns: 1, keywords: [], negatives: [], groups: [{ rn: "customers/1111111111/adGroups/2", name: c.adGroup, status: "ENABLED" }] } as any, w.deps, { kind: "stop", no: 7, text: "髪型 流行り" });
    assert.equal(plan.ready, false);
  });

  test("テスト用でないアカウント・用意がまだ（キャンペーンが無い・2つ・用意の言葉が欠けている）は書かずに断る", async () => {
    {
      const w = await prepared();
      const n = w.google.mutateCalls.length;
      w.google.customers.find((x) => x.id === CUSTOMER)!.testAccount = false;
      const r = await tryBody(w, { kind: "stop", no: 7 });
      assert.equal(r.status, 403);
      assert.equal(r.b.message, "テスト用アカウントではないので送りませんでした");
      assert.equal(w.google.mutateCalls.length, n);
    }
    {
      const w = world();
      const r = await tryBody(w, { kind: "stop", no: 7 });
      assert.equal(r.status, 409);
      assert.equal(r.b.message, "まだ用意されていません（オーナーが用意します）");
      assert.equal(w.google.mutateCalls.length, 0);
    }
    {
      const w = await prepared();
      const n = w.google.mutateCalls.length;
      w.google.campaigns.push({ ...w.google.campaigns[0], id: 7001 });
      assert.equal((await tryBody(w, { kind: "stop", no: 7 })).b.code, "not-ready");
      assert.equal(w.google.mutateCalls.length, n);
    }
    {
      const w = await prepared();
      const n = w.google.mutateCalls.length;
      w.google.criteria = w.google.criteria.filter((k) => k.text !== "パーマ 大人");
      assert.equal((await tryBody(w, { kind: "stop", no: 7 })).b.code, "not-ready");
      assert.equal(w.google.mutateCalls.length, n);
    }
  });

  test("守り：ほかのサイト・Origin なし・GET は断る。プレビュー・環境変数が足りない時は「つないでいません」（何も書かない）", async () => {
    const w = await prepared();
    const n = w.google.mutateCalls.length;
    for (const origin of ["https://evil.example", null]) {
      const r = await handleLiveTry(req("/api/ads/live/try", { origin, body: { kind: "stop", no: 7 } }), w.deps);
      assert.equal(r.status, 403, String(origin));
    }
    assert.equal((await handleLiveTry(req("/api/ads/live/try", { body: { kind: "stop", no: 7 }, fetchSite: "cross-site" }), w.deps)).status, 403);
    assert.equal((await handleLiveTry(req("/api/ads/live/try", { method: "GET" }), w.deps)).status, 405);
    for (const env of [{ VERCEL_ENV: "preview" }, { [LIVE_ENV.customerId]: undefined }]) {
      const v = world({ env, google: w.google });
      const r = await handleLiveTry(tryReq({ kind: "stop", no: 7 }), v.deps);
      assert.equal((await bodyOf(r)).code, "not-connected");
    }
    assert.equal(w.google.mutateCalls.length, n);
    // 合言葉の間違いの数には何も足さない（合言葉の欄を付けても読まない）
    await tryBody(w, { kind: "stop", no: 7, passcode: "wrong-wrong-wrong-wrong" });
    assert.equal(await w.store!.get(LIVE_KEY.wrong), null);
  });

  test("同時に1回：オーナーの用意・送ると同じ印。動いている時は書かずに 409「ほかの人が試しています〜」", async () => {
    const w = await prepared();
    await w.store!.set(LIVE_KEY.lock, "owner-is-sending", { ex: live.lockSeconds });
    const n = w.google.mutateCalls.length;
    const r = await tryBody(w, { kind: "stop", no: 7 });
    assert.equal(r.status, 409);
    assert.equal(r.b.message, "ほかの人が試しています。少し待ってから、もう一度承認してください");
    assert.equal(w.google.mutateCalls.length, n);
    assert.equal(await w.store!.get(LIVE_KEY.lock), "owner-is-sending", "ほかの印は消さない");
    await w.store!.del(LIVE_KEY.lock);
    // 2つ同時：片方だけが書く
    const [a, b] = await Promise.all([tryBody(w, { kind: "stop", no: 7 }), tryBody(w, { kind: "stop", no: 3 })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(await w.store!.get(LIVE_KEY.lock), null, "自分の印は消す");
    // 印の期限は窓口の持ち時間より長い
    assert.ok(live.lockSeconds > live.serverBudgetSeconds);
  });

  test("上限：1日（サイト全体）・1分（サイト全体）・同じ送り元から1日。こえたら書かない。オーナーの数・合言葉の間違いの数は変わらない", async () => {
    // 同じ送り元
    {
      const w = await prepared();
      for (let i = 0; i < T.perSourceDay; i++) {
        clock += 61_000; // 1分の上限に当てない
        assert.equal((await tryBody(w, { kind: "stop", no: 7 })).status, 200, `${i}`);
      }
      const n = w.google.mutateCalls.length;
      clock += 61_000;
      const r = await tryBody(w, { kind: "stop", no: 3 });
      assert.equal(r.status, 429);
      assert.match(r.b.message, new RegExp(`同じ送り元から${T.perSourceDay}回まで`));
      assert.equal(w.google.mutateCalls.length, n);
      // ほかの送り元は試せる
      clock += 61_000;
      assert.equal((await tryBody(w, { kind: "stop", no: 3 }, { "x-real-ip": "198.51.100.9" })).status, 200);
      // オーナーの数は減らない・合言葉の間違いの数も変わらない
      for (const k of ["setup", "send", "read", "stop"] as const) assert.equal(await w.store!.get(LIVE_KEY.day(DAY, k)), k === "setup" ? "1" : null, k);
      assert.equal(await w.store!.get(LIVE_KEY.wrong), null);
      assert.equal((await handleLiveRead(readReq(), w.deps)).status, 200);
      assert.equal((await handleLiveSend(sendReq(payloadOf([STOP])), w.deps)).status, 200);
    }
    // 1分
    {
      const w = await prepared();
      for (let i = 0; i < T.minute; i++) assert.equal((await tryBody(w, { kind: "stop", no: 7 }, { "x-real-ip": `198.51.100.${i}` })).status, 200);
      const r = await tryBody(w, { kind: "stop", no: 7 }, { "x-real-ip": "198.51.100.99" });
      assert.equal(r.status, 429);
      assert.match(r.b.message, /1分ほど待って/);
    }
    // 1日（サイト全体）
    {
      const w = await prepared();
      await w.store!.set(LIVE_KEY.tryDay(DAY), String(T.day), { ex: 86_400 });
      const n = w.google.mutateCalls.length;
      const r = await tryBody(w, { kind: "stop", no: 7 });
      assert.equal(r.status, 429);
      assert.match(r.b.message, new RegExp(`サイト全体で${T.day}回まで`));
      assert.equal(w.google.mutateCalls.length, n);
      // オーナーの送るは動く（別の数）
      assert.equal((await handleLiveSend(sendReq(payloadOf([STOP])), w.deps)).status, 200);
    }
  });

  test("送り元：Vercel が付ける IP（x-real-ip、無ければ x-vercel-forwarded-for）だけ。見出しを偽っても数は変わらない・生の IP は KV にもログにも出ない・塩は日ごと", async () => {
    const w = await prepared();
    const mem = w.store as Mem;
    const srcKeys = () => mem.keys().filter((k) => k.startsWith("ads:live:try:src:"));
    for (const h of [{}, { "x-forwarded-for": "10.0.0.1" }, { "x-forwarded-for": "10.0.0.2, 10.0.0.3" }, { forwarded: "for=10.0.0.4" }, { "x-client-ip": "10.0.0.5" }, { "cf-connecting-ip": "10.0.0.6" }] as Record<string, string>[]) {
      clock += 61_000;
      await tryBody(w, { kind: "stop", no: 7 }, h);
    }
    assert.equal(srcKeys().length, 1, "偽った見出しでは別の数にならない");
    assert.equal(await mem.get(srcKeys()[0]), "6");
    // x-real-ip が無い時は x-vercel-forwarded-for の最初
    const r = (h: Record<string, string>) => new Request(SITE, { headers: h });
    assert.equal(sourceIp(r({ "x-vercel-forwarded-for": "192.0.2.5, 10.0.0.1" })), "192.0.2.5");
    assert.equal(sourceIp(r({ "x-real-ip": "192.0.2.6", "x-vercel-forwarded-for": "192.0.2.5" })), "192.0.2.6");
    assert.equal(sourceIp(r({ "x-forwarded-for": "192.0.2.7" })), "unknown", "x-forwarded-for は見ない");
    // 生の IP は KV のキー・値・ログ・返事に無い
    for (const k of mem.keys()) {
      assert.ok(!k.includes(IP), k);
      assert.ok(!String(await mem.get(k)).includes(IP), k);
    }
    assert.ok(!logged.join("\n").includes(IP));
    const resp = await tryBody(w, { kind: "stop", no: 7 });
    assert.ok(!resp.text.includes(IP));
    const hash = srcKeys()[0].split(":").pop()!;
    assert.ok(!resp.text.includes(hash), "ハッシュも返さない");
    // 塩は日ごと（KV に置き2日で消える）・数の鍵も2日で消える
    const salt1 = await mem.get(LIVE_KEY.trySalt(DAY));
    assert.match(String(salt1), /^[0-9a-f]{32}$/);
    assert.equal(hash, sourceHash(salt1!, IP));
    clock += 86_400_000;
    await tryBody(w, { kind: "stop", no: 7 });
    const salt2 = await mem.get(LIVE_KEY.trySalt("2026-11-08"));
    assert.ok(salt2 && salt2 !== salt1, "日が変わると塩も変わる");
    assert.notEqual(sourceHash(salt2!, IP), hash);
    clock += 2 * 86_400_000 + 1000;
    assert.equal(await mem.get(LIVE_KEY.trySalt(DAY)), null, "前の日の塩は消える");
    assert.equal(mem.keys().filter((k) => k.includes(`:${DAY}`)).length, 0, "前の日の数の鍵も消える");
  });

  test("上限は同時に1回の印を取る前に確かめる：こえた呼び出しは印を取らない・続いてもオーナーの送るは 409 にならない・409 でも数は戻さない", async () => {
    const w = await prepared();
    const base = w.store!;
    const lockSets: string[] = [];
    w.deps.store = { ...base, set: async (k, v, o) => (k === LIVE_KEY.lock && lockSets.push(v), base.set(k, v, o)) };
    await base.set(LIVE_KEY.tryDay(DAY), String(T.day), { ex: 86_400 });
    const n = w.google.mutateCalls.length;
    const r = await tryBody(w, { kind: "stop", no: 7 });
    assert.equal(r.status, 429);
    assert.deepEqual(lockSets, [], "上限をこえた呼び出しは印の set を呼ばない");
    // 上限をこえた呼び出しが続いても（オーナーの送ると同時に来ても）、オーナーの送るは 409 にならない
    const results = await Promise.all([
      ...Array.from({ length: 12 }, (_, i) => handleLiveTry(tryReq({ kind: "stop", no: 7 }, { "x-real-ip": `198.51.100.${i}` }), w.deps).then((x) => x.status)),
      handleLiveSend(sendReq(payloadOf([STOP])), w.deps).then((x) => x.status),
      ...Array.from({ length: 12 }, (_, i) => handleLiveTry(tryReq({ kind: "stop", no: 3 }, { "x-real-ip": `198.51.100.${50 + i}` }), w.deps).then((x) => x.status)),
    ]);
    const send = results[12];
    assert.equal(send, 200, "オーナーの送るは動く");
    assert.ok(results.filter((_, i) => i !== 12).every((x) => x === 429));
    assert.equal(lockSets.length, 1, "印を取ったのはオーナーの送るの1回だけ");
    assert.equal(w.google.mutateCalls.filter((m) => m.ops.some((o) => JSON.stringify(o).includes("remove"))).length, 0, "試しは書いていない");
    assert.ok(w.google.mutateCalls.length > n);
    // 印が取れずに 409 になった時も、数は戻さない（呼んだ回数として数える）
    const w2 = await prepared();
    await w2.store!.set(LIVE_KEY.lock, "owner-is-sending", { ex: live.lockSeconds });
    assert.equal((await tryBody(w2, { kind: "stop", no: 7 })).status, 409);
    const mem = w2.store as Mem;
    const src = mem.keys().filter((k) => k.startsWith("ads:live:try:src:"));
    assert.equal(src.length, 1);
    assert.equal(await mem.get(src[0]), "1");
    assert.equal(await mem.get(LIVE_KEY.tryDay(DAY)), "1");
  });

  test("同じ送り元：IPv6 は前の半分（/64）でまとめ、IPv4 は1つの番地で数える", async () => {
    assert.equal(sourceBucket("2001:db8:1:2::1"), sourceBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd"));
    assert.equal(sourceBucket("2001:0DB8:0001:0002::ffff"), "2001:db8:1:2::/64");
    assert.equal(sourceBucket("[2001:db8:1:2::9]"), "2001:db8:1:2::/64");
    assert.notEqual(sourceBucket("2001:db8:1:2::1"), sourceBucket("2001:db8:1:3::1"));
    assert.equal(sourceBucket("::ffff:198.51.100.4"), "198.51.100.4", "IPv4 を写した IPv6 は IPv4 として");
    assert.equal(sourceBucket("203.0.113.7"), "203.0.113.7");
    assert.notEqual(sourceBucket("203.0.113.7"), sourceBucket("203.0.113.8"));
    // 窓口で：同じ /64 の違う IPv6 は同じ送り元の数になり、上限で止まる
    const w = await prepared();
    const mem = w.store as Mem;
    for (let i = 0; i < T.perSourceDay; i++) {
      clock += 61_000;
      assert.equal((await tryBody(w, { kind: "stop", no: 7 }, { "x-real-ip": `2001:db8:1:2:${(i + 1).toString(16)}::${i + 7}` })).status, 200, `${i}`);
    }
    assert.equal(mem.keys().filter((k) => k.startsWith("ads:live:try:src:")).length, 1);
    clock += 61_000;
    const over = await tryBody(w, { kind: "stop", no: 7 }, { "x-real-ip": "2001:db8:1:2:ffff:ffff:ffff:fffe" });
    assert.equal(over.status, 429);
    assert.match(over.b.message, /同じ送り元/);
    // 違う /64 は別の送り元
    clock += 61_000;
    assert.equal((await tryBody(w, { kind: "stop", no: 7 }, { "x-real-ip": "2001:db8:1:3::1" })).status, 200);
    for (const k of mem.keys()) assert.ok(!k.includes("2001:db8"), k);
  });

  test("KV が使えない時は書かない（置き場が無い・塩を置けない・戻した時刻を置けない）", async () => {
    {
      const w = await prepared();
      const n = w.google.mutateCalls.length;
      w.deps.store = null;
      const r = await tryBody(w, { kind: "stop", no: 7 });
      assert.equal(r.status, 503);
      assert.equal(w.google.mutateCalls.length, n);
    }
    for (const failOn of [LIVE_KEY.lock, "ads:live:try:salt:", LIVE_KEY.resetAt]) {
      const w = await prepared();
      const n = w.google.mutateCalls.length;
      const base = w.store!;
      w.deps.store = {
        ...base,
        get: base.get,
        set: async (k, v, o) => {
          if (k.startsWith(failOn)) throw new Error("kv down");
          return base.set(k, v, o);
        },
      };
      const r = await tryBody(w, { kind: "stop", no: 7 });
      assert.equal(r.status, 503, failOn);
      assert.equal(r.b.code, "no-store");
      assert.equal(w.google.mutateCalls.length, n, `${failOn}：何も書かない`);
    }
  });

  test("「最後に元の形に戻した時刻」は mutate の前に置く・読み直すの返事にも入る", async () => {
    const w = await prepared();
    const order: string[] = [];
    const base = w.store!;
    w.deps.store = { ...base, set: async (k, v, o) => (k === LIVE_KEY.resetAt && order.push("resetAt"), base.set(k, v, o)) };
    const f = w.deps.fetch;
    w.deps.fetch = async (u, init) => (String(u).endsWith(":mutate") && order.push("mutate"), f(u, init));
    messy(w.google);
    const r = await tryBody(w, { kind: "stop", no: 7 });
    assert.equal(r.b.line.outcome, "done");
    assert.deepEqual(order, ["resetAt", "mutate", "mutate"]);
    const at = await base.get(LIVE_KEY.resetAt);
    assert.equal(at, new Date(clock).toISOString());
    assert.equal(r.b.list.resetAt, at);
    const read = await bodyOf(await handleLiveRead(readReq(), w.deps));
    assert.equal(read.resetAt, at);
    // validateOnly で断られて何も書かなくても、時刻は置いてある（オーナーの印の比べが「比べない側」に倒れるだけ）
    clock += 61_000;
    w.google.hooks.rejectText = "ヘッドスパ 眠れる";
    const r2 = await tryBody(w, { kind: "add", no: 14 });
    assert.equal(r2.status, 502);
    assert.equal(await base.get(LIVE_KEY.resetAt), new Date(clock).toISOString());
  });

  test("結果が分からない時：送った後に返事が消えたら「分からない」（「できなかった」と言わない）・読み直しで変わっていれば「反映した」", async () => {
    const w = await prepared();
    w.google.hooks.dropAfterMutate = true;
    w.google.hooks.dropSearchFrom = w.google.searchCount + 100; // 読み直しは通る
    const r = await tryBody(w, { kind: "stop", no: 7 });
    assert.equal(r.b.line.outcome, "done", "読み直すと変わっていた");
    const w2 = await prepared();
    messy(w2.google);
    w2.google.hooks.dropBeforeMutate = true;
    w2.google.hooks.dropSearchFrom = undefined;
    const r2 = await tryBody(w2, { kind: "stop", no: 7 });
    assert.equal(r2.b.line.outcome, "unknown");
    assert.notEqual(r2.b.line.outcome, "failed");
    // 読み直しもできない時は一覧なしの「分からない」
    const w3 = await prepared();
    w3.google.hooks.dropAfterMutate = true;
    // 確かめ1・今の形4・validateOnly と本当の前の確かめ2 の後、読み直しの所から切れる
    w3.google.hooks.dropSearchFrom = w3.google.searchCount + 8;
    const r3 = await tryBody(w3, { kind: "stop", no: 7 });
    assert.equal(r3.b.line.outcome, "unknown");
    assert.equal(r3.b.list, null);
  });

  test("「印がありますが〜」は、最後に元の形に戻した時刻より前の印とは比べず1行。後の印で一覧と合わない時は今どおり出る", () => {
    const s: AdsState = {
      ...EMPTY_ADS,
      proposals: [
        { id: "ad-2", action: "stop", no: 3, text: "美容院 安い", reason: "r", total: { clicks: 0, cost: 0, bookings: 0 }, checks: [], createdAt: APPROVED, state: "approved", decidedAt: APPROVED, fixed: false, mode: "ai", realAt: "2026-11-07T01:00:00.000Z" },
      ],
      applied: [{ no: 3, action: "stop", at: APPROVED, proposalId: "ad-2" }],
    };
    const list = (resetAt?: string): Extract<LiveReadResponse, { ok: true }> => ({
      ok: true,
      campaign: { found: true, status: "止めている（広告は出ません）" },
      keywords: [{ text: "美容院 安い", match: "フレーズ一致", status: "出す設定", group: c.adGroup }],
      negatives: [],
      ...(resetAt ? { resetAt } : {}),
    });
    assert.deepEqual(driftOf(s, list("2026-11-07T02:00:00.000Z"), c.adGroup), ["オーナーが送った後に、ほかの人の試しで元の形に戻りました"]);
    assert.match(driftOf(s, list("2026-11-07T00:00:00.000Z"), c.adGroup).join(), /印がありますが、読み直すと止まっていません/);
    assert.match(driftOf(s, list(), c.adGroup).join(), /止まっていません/);
  });
});

describe("直しW：日ごとの塩は、置けた時は自分の値をそのまま使う（置いた直後の GET が写しから null でも落ちない）", () => {
  const DAY = "2026-11-07";
  const SALT = LIVE_KEY.trySalt(DAY);

  /** 書くのは元の所・読むのは写しから、の作り物：置いた直後の GET は1回だけ null（まだ写っていない）。gets で GET の回数を数える */
  function lagging(base: KvStore, opts: { saltGet?: "lag" | "null" } = {}) {
    const fresh = new Set<string>();
    const gets: string[] = [];
    const store: KvStore = {
      ...base,
      set: async (k, v, o) => {
        const ok = await base.set(k, v, o);
        if (ok) fresh.add(k);
        return ok;
      },
      get: async (k) => {
        gets.push(k);
        if (k === SALT && opts.saltGet === "null") return null;
        if (fresh.delete(k)) return null;
        return base.get(k);
      },
    };
    return { store, gets };
  }

  test("その日の最初の1回（塩を作る時）：置いた直後の GET が null を返しても、503 にならずに通る（塩は自分の値・GET はしない）", async () => {
    const w = await prepared();
    const lag = lagging(w.store!);
    w.deps.store = lag.store;
    const r = await handleLiveTry(tryReq({ kind: "stop", no: 7 }), w.deps);
    const b = await bodyOf(r);
    assert.equal(r.status, 200, JSON.stringify(b));
    assert.equal(b.line.outcome, "done");
    assert.ok(!lag.gets.includes(SALT), "置けた時は塩を読み直さない");
    // 置いた塩で数えている（送り元の数の鍵は、置いた塩と合わせたハッシュ）
    const salt = (await w.store!.get(SALT))!;
    assert.match(salt, /^[0-9a-f]{32}$/);
    const hash = sourceHash(salt, sourceBucket("203.0.113.7"));
    assert.equal(await w.store!.get(LIVE_KEY.trySource(DAY, hash)), "1");
  });

  test("SET NX が置けなかった時（もう塩がある）は GET の値を使う", async () => {
    const w = await prepared();
    await w.store!.set(SALT, "f".repeat(32), { ex: 3600 });
    const lag = lagging(w.store!);
    w.deps.store = lag.store;
    const r = await handleLiveTry(tryReq({ kind: "stop", no: 7 }), w.deps);
    assert.equal(r.status, 200);
    assert.ok(lag.gets.includes(SALT), "置けなかった時だけ読む");
    assert.equal(await w.store!.get(SALT), "f".repeat(32), "前の塩はそのまま");
    const hash = sourceHash("f".repeat(32), sourceBucket("203.0.113.7"));
    assert.equal(await w.store!.get(LIVE_KEY.trySource(DAY, hash)), "1", "前の塩で数えた");
  });

  test("置けなかった上に GET も null なら、今どおり 503 no-store（何も書かない）", async () => {
    const w = await prepared();
    await w.store!.set(SALT, "f".repeat(32), { ex: 3600 });
    const n = w.google.mutateCalls.length;
    w.deps.store = lagging(w.store!, { saltGet: "null" }).store;
    const r = await handleLiveTry(tryReq({ kind: "stop", no: 7 }), w.deps);
    assert.equal(r.status, 503);
    assert.match(r.headers.get("cache-control") ?? "", /no-store/);
    assert.equal((await bodyOf(r)).code, "no-store");
    assert.equal(w.google.mutateCalls.length, n);
  });
});

describe("直しW：書くのは元の所・読むのは写しから、の作り物の Upstash で、try が最後まで通る（塩・数・印・resetAt・送る・読み直し）", () => {
  const DAY = "2026-11-07";
  const IP = "203.0.113.7";
  const CONF = { url: "https://kv.example.test", token: "kv-token" };

  /** 本番と同じく、窓口の1回の呼び出しごとに置き場を作る（sync token は呼び出しをまたがない）。呼び出しの間には写しが追いつく */
  async function setupWith(up: ReturnType<typeof fakeUpstash>) {
    const w = await prepared({ store: upstashStore(CONF, up.fetch) });
    up.catchUp();
    return w;
  }
  async function tryWith(w: { deps: LiveDeps }, up: ReturnType<typeof fakeUpstash>, body: unknown) {
    w.deps.store = upstashStore(CONF, up.fetch);
    const from = up.calls.length;
    const r = await handleLiveTry(tryReq(body), w.deps);
    const b = (await r.json()) as Record<string, any>;
    const calls = up.calls.slice(from);
    up.catchUp();
    return { status: r.status, headers: r.headers, b, calls };
  }

  test("塩 → 3つの数（INCR と EXPIRE）→ 印 → resetAt → 送る → 読み直し → 自分の印を消す、まで通る", async () => {
    const up = fakeUpstash({ now });
    const w = await setupWith(up);
    assert.equal(up.value(LIVE_KEY.lock), null, "用意の後に印は残らない（自分の印か確かめる GET は sync token で元の所から読む）");
    const before = w.google.mutateCalls.length;
    const r = await tryWith(w, up, { kind: "stop", no: 7 });
    assert.equal(r.status, 200, JSON.stringify(r.b));
    assert.equal(r.b.line.outcome, "done");
    // 塩：置けた時は自分の値（読み直さない）
    const salt = up.value(LIVE_KEY.trySalt(DAY));
    assert.match(salt ?? "", /^[0-9a-f]{32}$/);
    assert.ok(!r.calls.some((c) => c.cmds.some((x) => x[0] === "GET" && x[1] === LIVE_KEY.trySalt(DAY))), "塩は読み直さない");
    // 3つの数：1つずつ足し、期限が付いた
    const keys = [LIVE_KEY.trySource(DAY, sourceHash(salt!, sourceBucket(IP))), LIVE_KEY.tryMinute(Math.floor(clock / 60_000)), LIVE_KEY.tryDay(DAY)];
    for (const k of keys) {
      assert.equal(up.value(k), "1", k);
      assert.ok(Number.isFinite(up.until(k)), `${k} に期限`);
    }
    // 印：取って、終わったら自分の印か確かめてから消した（確かめの GET は省いていない）
    assert.ok(r.calls.some((c) => c.cmds.some((x) => x[0] === "SET" && x[1] === LIVE_KEY.lock && x.includes("NX"))));
    assert.ok(r.calls.some((c) => c.cmds.some((x) => x[0] === "GET" && x[1] === LIVE_KEY.lock)), "自分の印かを確かめる GET");
    assert.equal(up.value(LIVE_KEY.lock), null, "自分の印を消した");
    // resetAt：mutate の前に置き、返事にも入る
    assert.equal(up.value(LIVE_KEY.resetAt), new Date(clock).toISOString());
    assert.equal(r.b.list.resetAt, up.value(LIVE_KEY.resetAt));
    // 送る：validateOnly → 本当の1回。読み直しの一覧がある
    assert.deepEqual(w.google.mutateCalls.slice(before).map((m) => [m.validateOnly, m.partialFailure]), [[true, false], [false, false]]);
    assert.equal(r.b.list.keywords.find((k: any) => k.text === "髪型 流行り").status, "止めている");
    // sync token：この呼び出しの最初には付けず、2回目からは前の返事の値。窓口はみな /pipeline
    assert.equal(r.calls[0].syncToken, null, "最初の呼び出しには付けない（前の呼び出しの置き場の token は引き継がない）");
    assert.ok(r.calls.slice(1).every((c) => c.syncToken), "2回目からは付ける");
    assert.ok(r.calls.every((c) => c.url === `${CONF.url}/pipeline`));
    // 次の人も 409 にならずに試せる（印が残っていない）
    clock += 61_000;
    const r2 = await tryWith(w, up, { kind: "exclude", no: 10 });
    assert.equal(r2.status, 200, JSON.stringify(r2.b));
    assert.equal(r2.b.line.outcome, "done");
    assert.equal(up.value(keys[0]), "2", "同じ日・同じ送り元は同じ塩で数える");
  });

  test("（比べ）sync token を見ない置き場だと、自分の印か確かめる GET が写しから読み、印を消さずに残す（確かめは省かないので、ほかの印は消さない）", async () => {
    const up = fakeUpstash({ now, honorSyncToken: false });
    const w = await prepared({ store: upstashStore(CONF, up.fetch) });
    // 用意の印が写しに見えず、消さずに残っている（期限で消える）
    assert.notEqual(up.value(LIVE_KEY.lock), null);
    up.reset();
    w.deps.store = upstashStore(CONF, up.fetch);
    const r = await handleLiveTry(tryReq({ kind: "stop", no: 7 }), w.deps);
    assert.equal(r.status, 200, "塩は自分の値を使うので、ここでも 503 にはならない");
    assert.notEqual(up.value(LIVE_KEY.lock), null, "印を確かめられない時は消さない");
  });

  test("ほかの所が落ちた時も 503 no-store で、何も書かない（3つの数の INCR／EXPIRE・塩・印・resetAt）・印は残さない", async () => {
    const cases: [string, (c: string[]) => boolean][] = [
      ["塩の SET", (c) => c[0] === "SET" && c[1].startsWith("ads:live:try:salt:")],
      ["送り元の INCR", (c) => c[0] === "INCR" && c[1].startsWith("ads:live:try:src:")],
      ["送り元の EXPIRE", (c) => c[0] === "EXPIRE" && c[1].startsWith("ads:live:try:src:")],
      ["1分の INCR", (c) => c[0] === "INCR" && c[1].startsWith("ads:live:try:min:")],
      ["1分の EXPIRE", (c) => c[0] === "EXPIRE" && c[1].startsWith("ads:live:try:min:")],
      ["1日の INCR", (c) => c[0] === "INCR" && c[1].startsWith("ads:live:try:day:")],
      ["1日の EXPIRE", (c) => c[0] === "EXPIRE" && c[1].startsWith("ads:live:try:day:")],
      ["印の SET", (c) => c[0] === "SET" && c[1] === LIVE_KEY.lock],
      ["resetAt の SET", (c) => c[0] === "SET" && c[1] === LIVE_KEY.resetAt],
    ];
    for (const [name, failOn] of cases) {
      let failing = false;
      const up = fakeUpstash({ now, failOn: (c) => failing && failOn(c) });
      const w = await setupWith(up);
      const n = writes(w.google).length;
      failing = true;
      const r = await tryWith(w, up, { kind: "stop", no: 7 });
      assert.equal(r.status, 503, name);
      assert.match(r.headers.get("cache-control") ?? "", /no-store/, name);
      assert.equal(r.b.code, "no-store", name);
      assert.equal(writes(w.google).length, n, `${name}：本当の書き込みは無い`);
      assert.equal(up.value(LIVE_KEY.lock), null, `${name}：印は残さない`);
    }
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
  test("直しU：だれでも試せる道（元に戻してから1件・テスト用アカウントの中だけ・店の広告に届かない理由・オーナーの送るとの違い・窓口の守りの表）", () => {
    const readme = readFileSync("README.md", "utf8");
    const sec = readme.slice(readme.indexOf("#### だれでも試せる道（直しU。合言葉なし）"), readme.indexOf("- **何を**（オーナーの操作）"));
    for (const w of ["元の形に戻してから", "承認した1件だけ", "テスト用アカウントの中だけ・店の広告には届かない理由", "オーナーの「送る」との違い", "種類（止める・外す・足す）と番号", "付けない（次の人が元に戻すため）", "人を確かめる物ではありません", "x-real-ip", "生の IP は Redis にもログにも残しません"])
      assert.ok(sec.includes(w), w);
    // 直しW：直しU の後の本番で 503 だったこと・直した所・Merge の後の本番の結果（承認BOXからの1件は 200・日付が変わった後の最初の1回はまだ）
    assert.doesNotMatch(sec, /LINE・試験10問・広告の[^。]*にも効きます/, "全部に効くとは書かない");
    for (const w of ["503 no-store", "置けた時は作った値をそのまま使い", "`upstash-sync-token`", "同じ置き場の中で、書いた直後に読む時だけ", "別々に作った置き場の間では引き継ぎません", "省いていません", "INCR と EXPIRE", "直しW を Merge した後の本番（2026-11-08 01:26・日本時間）", "`/api/ads/live/try` は 200", "元の8語にその1語を足した形・除外0件", "本番では次の日にならないと見られないので、**まだ確かめていません**"])
      assert.ok(sec.includes(w), w);
    assert.doesNotMatch(sec, /ここに書きます/, "確かめた後は「これから書く」と書かない");
    assert.doesNotMatch(sec, /100%|必ず|すぐ反映/);
    const guard = readme.slice(readme.indexOf("### だれでも呼べる窓口の守り（今の作り）"), readme.indexOf("### 動かし方の手順"));
    assert.match(guard, /だれでも試す（`\/api\/ads\/live\/try`。直しU）/);
    for (const row of [/Origin なし／ほかのサイト.*\| 403/, /\| GET \| 405 \|/, /2件.*形の違う物 \| 400（何も書かない） \|/]) assert.match(guard, row);
    assert.match(guard, /人を確かめる物ではありません（直に呼ばれても、下の上限で止めます）/);
    // 今の事実：合言葉なしで書けるのは、作品のキャンペーンの中に元に戻してから表の1件だけ
    assert.match(readme, /合言葉なしで書けるのは、テスト用アカウントの作品のキャンペーンの中に、元に戻してから表の1件だけ/);
    assert.doesNotMatch(readme, /送れるのはオーナーだけで、お客様/);
    const spec = readFileSync("docs/SPEC.md", "utf8");
    assert.match(spec, /合言葉なしで書けるのは、テスト用アカウントの作品のキャンペーンの中に、元に戻してから表の1件だけ/);
  });

  test("テスト用アカウントの節：何を・どの守りで・確かめていないこと・本番の確かめの結果・言いすぎない", () => {
    const readme = readFileSync("README.md", "utf8");
    const sec = readme.slice(readme.indexOf("### Google 広告のテスト用アカウントに本当に送る"), readme.indexOf("### 道1"));
    for (const w of ["止める", "外す", "足す", "読み直す", "validateOnly", "テスト用アカウントかを新しく確かめ", "確かめていないこと", "Explorer", "広告文の無い、止めたキャンペーン"]) assert.ok(sec.includes(w), w);
    // 直しT：本番の確かめの結果（番号・メールは書かない）
    assert.doesNotMatch(sec, /本番で確かめる前です/);
    assert.match(sec, /本番の確かめの結果\*\*（2026-11-07/);
    for (const w of ["予算・止めたキャンペーン・広告グループ・言葉8つ", "広告文は作っていません", "止める1件・足す1件・外す1件の3つとも「反映した」", "「一時停止」", "フレーズ一致で増え", "完全一致の除外にキャンペーンの単位で", "validateOnly と仮の番号", "本番で通りました"])
      assert.ok(sec.includes(w), w);
    assert.doesNotMatch(sec, /\d{3}-?\d{3}-?\d{4}|@[a-z]/i, "番号・メールを書かない");
    // 本番で呼んだ広告の窓口の行（だれでも呼べる窓口の表）
    const proof = readme.slice(readme.indexOf("### 動かして確かめる（知らない人の状態）"), readme.indexOf("### 動かし方の手順"));
    assert.match(proof, /\| `\/api\/ads\/live\/send` \| POST・Origin は本番（合言葉なし） \| 401「オーナー用の合言葉がちがいます」 \|/);
    assert.match(proof, /\| `\/api\/ads\/live\/send` \| POST・Origin なし \| 403 \|/);
    assert.match(proof, /cross-site.*\| 403 \|/);
    assert.match(proof, /\| `\/api\/ads\/live\/send` \| GET \| 405 \|/);
    assert.match(proof, /「書けるか」は、環境変数とオーナー用の合言葉の設定があるかから決めた札で、Google に書けたことの確かめではありません/);
    assert.match(proof, /合言葉なしで送った時も、間違いの数に1つ足す作り/);
    assert.doesNotMatch(proof, /100%|必ず|すぐ反映|数を使わない/);
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
