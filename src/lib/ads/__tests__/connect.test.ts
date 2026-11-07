// 本物の検索広告へ渡す形（docs/SPEC.md §1.7.6）と、本物の広告の中で動かす見本のスクリプト（§1.7.7）。
// 本物の広告は呼ばない。見本のスクリプトは、作り物の広告の部品と外の窓口の部品を差し込んで動かす。

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, test } from "node:test";
import { emptyBook } from "../../book/state";
import { getAds } from "../../data/seed";
import { getAdSettings, getMenus, getShop } from "../../settings";
import { readSyncResult, realMarkedNos, RESULT_FORMAT, sampleResult, SYNC_FORMAT, syncItems, syncPayload, withSynced } from "../connect";
import { featuredWordIn, featuredWords } from "../featured";
import { approveRevert } from "../verdict";
import { approveAd, approveAdd, EMPTY_ADS, parseAds, tableOf, withAddSkipped, withReview, type AdsState } from "../state";
import { buildTable, ZERO } from "../report";

const settings = getAdSettings();
const shop = getShop();
const report = getAds();
const words = featuredWords(settings, getMenus());
const table = buildTable(report, settings);
const c = settings.connect;
const NOW = "2026-11-07T01:00:00.000Z";
const LATER = "2026-11-07T02:00:00.000Z";
const TODAY = "2026-11-07";

/** 止める（2番）・外す（10番）・足す（11番・14番）が承認待ちの状態を作り、決める */
function world(): { s: AdsState; ids: { stop: string; exclude: string; add11: string; add14: string } } {
  let s = withReview(
    EMPTY_ADS,
    {
      proposal: { id: "ad-1", action: "exclude", no: 10, text: "美容院 安い 学生", reason: "予約につながっていません。", checks: [] },
      adds: [
        { id: "ad-1-add1", no: 11, reason: "売りの言葉です。", checks: [] },
        { id: "ad-1-add2", no: 14, reason: "売りの言葉です。", checks: [] },
      ],
    },
    table,
    { nowIso: NOW, mode: "script" },
    settings,
  );
  s = approveAd(s, emptyBook(TODAY), "ad-1", { nowIso: NOW, today: TODAY, shop, settings }).ads;
  s = approveAdd(s, "ad-1-add1", { nowIso: NOW, table: tableOf(report, settings, s), words, settings }).ads;
  // 止める案（別の週の見直し。承認済み）
  s = {
    ...s,
    proposals: [
      ...s.proposals,
      { id: "ad-2", action: "stop", no: 3, text: "美容院 安い", reason: "予約につながっていません。", total: { clicks: 0, cost: 0, bookings: 0 }, checks: [], createdAt: LATER, state: "approved", decidedAt: LATER, fixed: false, mode: "ai" },
    ],
    applied: [...s.applied, { no: 3, action: "stop", at: LATER, proposalId: "ad-2" }],
  };
  return { s, ids: { stop: "ad-2", exclude: "ad-1", add11: "ad-1-add1", add14: "ad-1-add2" } };
}

describe("渡す中身", () => {
  test("承認済みで未反映の物だけ（承認待ちの足す案は入れない）・種類と合い方（足す＝フレーズ一致・外す＝完全一致）", () => {
    const { s } = world();
    const { payload } = syncPayload(s, words, c, NOW);
    assert.equal(payload.format, SYNC_FORMAT);
    assert.equal(payload.version, 1);
    assert.equal(payload.createdAt, NOW);
    assert.equal(payload.campaign, c.campaign);
    assert.equal(payload.adGroup, c.adGroup);
    assert.deepEqual(
      payload.items.map((i) => [i.id, i.kind, i.text, i.match ?? null]),
      [
        ["ad-1", "exclude", "美容院 安い 学生", "exact"],
        ["ad-1-add1", "add", "縮毛矯正 くせ毛 ひどい", "phrase"],
        ["ad-2", "stop", "美容院 安い", null],
      ],
    );
    assert.ok(payload.items.every((i) => i.approvedAt));
  });

  test("見送った・反映済み・戻した案は入れない", () => {
    const { s: s0 } = world();
    let s = withAddSkipped(s0, "ad-1-add2", NOW);
    s = withSynced(s, [{ id: "ad-1", kind: "exclude" }], LATER);
    // 止めた言葉を戻した（効いたかの判定の戻す案を承認した）つもり
    s = { ...s, judgements: [{ id: "j1", proposalId: "ad-2", no: 3, text: "美容院 安い", action: "stop", approvedAt: LATER, due: TODAY, judgedAt: NOW, demo: false, mode: "ai", weeks: 3, before: ZERO, after: ZERO, word: ZERO, verdict: "revert", why: "予約が減りました。", revert: { state: "pending" } }] };
    s = approveRevert(s, "j1", NOW, settings.channel).ads;
    assert.deepEqual(syncItems(s, words).items.map((i) => i.id), ["ad-1-add1"]);
  });

  test("足す案は書き出す時にも売りの言葉をもう一度確かめる", () => {
    const { s } = world();
    const r = syncItems(s, ["パーマ"]);
    assert.ok(!r.items.some((i) => i.kind === "add"));
    assert.match(r.notes.join(), /売りの言葉が入っていない/);
  });

  test("鍵・合言葉・本物の広告の番号は入らない（決まった欄だけ）", () => {
    const { s } = world();
    const { payload } = syncPayload(s, words, c, NOW);
    assert.deepEqual(Object.keys(payload).sort(), ["adGroup", "campaign", "createdAt", "format", "items", "version"]);
    for (const i of payload.items) for (const k of Object.keys(i)) assert.ok(["id", "kind", "text", "match", "approvedAt"].includes(k), k);
    const json = JSON.stringify(payload);
    // 「secretairy-ads-sync」の形の名前のほかに、鍵・合言葉・本物の広告の番号（123-456-7890 の形）が無い
    assert.doesNotMatch(json.replaceAll(SYNC_FORMAT, ""), /token|secret|pass|apikey|api_key|customerId|\d{3}-\d{3}-\d{4}/i);
    const cfg = readFileSync("config/ads.json", "utf8");
    assert.doesNotMatch(cfg, /\d{3}-\d{3}-\d{4}|token|secret|passcode/i, "設定にも本物の番号・鍵を入れない");
  });

  test("数の上限（maxItems）をこえた分は次に回す", () => {
    const { s } = world();
    const r = syncPayload(s, words, { ...c, maxItems: 1 }, NOW);
    assert.equal(r.payload.items.length, 1);
    assert.match(r.notes.join(), /残り2件/);
  });
});

describe("結果の読み込み", () => {
  const resultOf = (rows: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ format: RESULT_FORMAT, version: 1, campaign: c.campaign, results: rows, ...extra });

  test("反映した物だけ印・できなかった物は理由を知らせて印なし", () => {
    const { s } = world();
    const r = readSyncResult(
      resultOf([
        { id: "ad-1", kind: "exclude", text: "美容院 安い 学生", status: "done" },
        { id: "ad-1-add1", kind: "add", text: "縮毛矯正 くせ毛 ひどい", status: "failed", reason: "広告グループが2つあります" },
      ]),
      s,
      words,
      c,
    );
    assert.ok(r.ok);
    assert.deepEqual(r.marks, [{ id: "ad-1", kind: "exclude" }]);
    assert.match(r.notes.join(), /反映できませんでした（広告グループが2つあります）/);
    const next = withSynced(s, r.marks, LATER);
    assert.equal(next.proposals.find((p) => p.id === "ad-1")?.realAt, LATER);
    assert.equal(next.adds?.find((p) => p.id === "ad-1-add1")?.realAt, undefined);
    assert.deepEqual([...realMarkedNos(next)], [10]);
    // 印も読み直して落ちない
    assert.deepEqual(parseAds(JSON.stringify(next)), next);
  });

  test("番号違い（承認待ち）・種類違い・言葉違い・知らない番号は印なしで知らせ", () => {
    const { s } = world();
    const r = readSyncResult(
      resultOf([
        { id: "ad-1-add2", kind: "add", text: "ヘッドスパ 眠れる", status: "done" },
        { id: "ad-1", kind: "stop", text: "美容院 安い 学生", status: "done" },
        { id: "ad-2", kind: "stop", text: "美容院", status: "done" },
        { id: "ad-999", kind: "stop", text: "美容院 安い", status: "done" },
      ]),
      s,
      words,
      c,
    );
    assert.ok(r.ok);
    assert.deepEqual(r.marks, []);
    assert.equal(r.notes.length, 4);
    assert.match(r.notes[0], /番号が合いません/);
    assert.match(r.notes[1], /種類や言葉が渡した中身と違う/);
    assert.match(r.notes[2], /種類や言葉が渡した中身と違う/);
    assert.match(r.notes[3], /知らない番号/);
  });

  test("形の違う文字・大きすぎる文字は何も変えずに1行", () => {
    const { s } = world();
    for (const raw of [
      "",
      "これは JSON ではない",
      JSON.stringify({ format: "other", version: 1, results: [] }),
      JSON.stringify({ format: RESULT_FORMAT, version: 2, results: [] }),
      resultOf([{ id: "ad-1", kind: "remove", text: "x", status: "done" }]),
      resultOf([{ id: "ad-1", kind: "exclude", text: "美容院 安い 学生", status: "ok" }]),
      resultOf([{ id: 1, kind: "exclude", text: "x", status: "done" }]),
      resultOf([], { campaign: "ほかのキャンペーン" }),
      "x".repeat(c.maxPasteChars + 1),
      resultOf(Array.from({ length: c.maxItems + 1 }, (_, i) => ({ id: `x${i}`, kind: "stop", text: "a", status: "done" }))),
    ]) {
      const r = readSyncResult(raw, s, words, c);
      assert.equal(r.ok, false, raw.slice(0, 40));
      assert.ok(!r.ok && r.note.length > 0 && !r.note.includes("\n"));
    }
  });

  test("同じ結果を2回読み込んでも、印は1回だけ", () => {
    const { s } = world();
    const raw = resultOf([{ id: "ad-1", kind: "exclude", text: "美容院 安い 学生", status: "done" }]);
    const r1 = readSyncResult(raw, s, words, c);
    assert.ok(r1.ok);
    const s1 = withSynced(s, r1.marks, NOW);
    const r2 = readSyncResult(raw, s1, words, c);
    assert.ok(r2.ok);
    assert.deepEqual(r2.marks, []);
    assert.match(r2.notes.join(), /もう反映済み/);
    const s2 = withSynced(s1, [{ id: "ad-1", kind: "exclude" }], LATER);
    assert.equal(s2.proposals.find((p) => p.id === "ad-1")?.realAt, NOW, "前の印のまま");
    // 反映済みになった案は、次の渡す中身に入らない
    assert.ok(!syncItems(s1, words).items.some((i) => i.id === "ad-1"));
  });

  test("見本の結果（デモ）は渡す中身の全部を「反映した」にする", () => {
    const { s } = world();
    const { payload } = syncPayload(s, words, c, NOW);
    const r = readSyncResult(JSON.stringify(sampleResult(payload)), s, words, c);
    assert.ok(r.ok);
    assert.deepEqual(r.marks.map((m) => m.id), payload.items.map((i) => i.id));
  });

  test("画面は「くわしく」の中に小さく置く（本物の広告の名前は画面に出さない）", () => {
    const page = readFileSync("src/app/ads/page.tsx", "utf8");
    const fold = page.slice(page.indexOf("<Fold"), page.indexOf("</Fold>"));
    assert.match(fold, /<AdsConnect \/>/);
    const ui = readFileSync("src/app/ads/AdsConnect.tsx", "utf8");
    assert.match(ui, /本物の広告に渡す形を見る（今はつないでいません）/);
    for (const f of ["src/app/ads/AdsConnect.tsx", "src/app/ads/page.tsx", "src/app/ads/AdsReport.tsx", "src/components/AdAddRow.tsx", "config/ads.json"])
      assert.doesNotMatch(readFileSync(f, "utf8"), /Google|グーグル/, f);
  });
});

// ── 見本のスクリプト（connect/google-ads/secretairy-sync.js）を、作り物の広告の部品で動かす ──

const SCRIPT_PATH = "connect/google-ads/secretairy-sync.js";
const SCRIPT = readFileSync(SCRIPT_PATH, "utf8");

type FakeKw = { text: string; paused: boolean };
type FakeGroup = { name: string; keywords: FakeKw[]; failBuild?: boolean };
type FakeCampaign = { name: string; keywords: FakeKw[]; negatives: string[]; groups: FakeGroup[]; ignorePause?: boolean; ignoreNegative?: boolean };

const iter = <T,>(xs: T[]) => {
  let i = 0;
  return { hasNext: () => i < xs.length, next: () => xs[i++], totalNumEntities: () => xs.length };
};

/** 作り物の AdsApp（公式の資料の名前：campaigns・keywords・pause・isPaused・getText・negativeKeywords・createNegativeKeyword・adGroups・newKeywordBuilder・withText・build・isSuccessful・getExecutionInfo().isPreview） */
function fakeAds(campaigns: FakeCampaign[], preview = false) {
  const calls: string[] = [];
  const kw = (k: FakeKw, c?: FakeCampaign) => ({
    getText: () => k.text,
    isPaused: () => k.paused,
    pause: () => {
      calls.push(`pause:${k.text}`);
      if (!preview && !c?.ignorePause) k.paused = true;
    },
  });
  const ads = {
    calls,
    getExecutionInfo: () => ({ isPreview: () => preview }),
    campaigns: () => ({
      get: () =>
        iter(
          campaigns.map((c) => ({
            getName: () => c.name,
            keywords: () => ({ get: () => iter([...c.keywords, ...c.groups.flatMap((g) => g.keywords)].map((k) => kw(k, c))) }),
            negativeKeywords: () => ({ get: () => iter(c.negatives.map((n) => ({ getText: () => n }))) }),
            createNegativeKeyword: (t: string) => {
              calls.push(`negative:${t}`);
              if (!preview && !c.ignoreNegative) c.negatives.push(t);
            },
            adGroups: () => ({
              get: () =>
                iter(
                  c.groups.map((g) => ({
                    getName: () => g.name,
                    keywords: () => ({ get: () => iter(g.keywords.map((k) => kw(k, c))) }),
                    newKeywordBuilder: () => {
                      let text = "";
                      const b = {
                        withText: (t: string) => ((text = t), b),
                        build: () => {
                          calls.push(`add:${text}`);
                          if (g.failBuild) return { isSuccessful: () => false, getErrors: () => ["だめ"] };
                          if (!preview) g.keywords.push({ text, paused: false });
                          return { isSuccessful: () => true, getErrors: () => [] };
                        },
                      };
                      return b;
                    },
                  })),
                ),
            }),
          })),
        ),
    }),
  };
  return ads;
}

/** 作り物の UrlFetchApp：GET で渡す中身を返し、POST を覚える */
function fakeHttp(payload: unknown, code = 200) {
  const posts: { url: string; body: unknown; headers: unknown }[] = [];
  const gets: { url: string; headers: unknown }[] = [];
  return {
    posts,
    gets,
    fetch: (url: string, p: { method?: string; payload?: string; headers?: unknown }) => {
      if (p.method === "post") {
        posts.push({ url, body: JSON.parse(p.payload ?? "null"), headers: JSON.parse(JSON.stringify(p.headers ?? null)) });
        return { getResponseCode: () => 200, getContentText: () => "" };
      }
      gets.push({ url, headers: JSON.parse(JSON.stringify(p.headers ?? null)) });
      return { getResponseCode: () => code, getContentText: () => (typeof payload === "string" ? payload : JSON.stringify(payload)) };
    },
  };
}

type Sync = (deps: unknown) => { ok: boolean; note: string; preview: boolean; sent: boolean; result?: { results: { id: string; kind: string; text: string; status: string; reason?: string }[] } };

/** スクリプトを、貼った時と同じく1つのファイルとして読み込む（import も export も無い形） */
function loadScript(globals: Record<string, unknown> = {}) {
  const ctx = vm.createContext({ ...globals });
  vm.runInContext(SCRIPT, ctx, { filename: SCRIPT_PATH });
  const s = ctx as unknown as { runSync: Sync; featuredWordIn: (t: string, w: string[]) => string | null; main: () => void; CONFIG: Record<string, unknown> };
  // スクリプトの中の配列は別の世界の物なので、JSON で写してから比べる
  const run: Sync = (deps) => JSON.parse(JSON.stringify(s.runSync(deps)));
  return { runSync: run, featuredWordIn: s.featuredWordIn, main: () => s.main(), CONFIG: s.CONFIG };
}

const CFG = { endpoint: "https://example.invalid/api/ads/sync", passcode: "test-only", campaign: c.campaign, adGroup: c.adGroup, featuredWords: words, maxOps: 10, maxTextChars: 40 };

function shopAccount(): FakeCampaign[] {
  return [
    {
      name: c.campaign,
      keywords: [{ text: "美容院 安い", paused: false }, { text: "[美容室 omochi]", paused: false }],
      negatives: [],
      groups: [{ name: c.adGroup, keywords: [{ text: '"縮毛矯正 くせ毛"', paused: false }] }],
    },
    { name: "ほかのキャンペーン", keywords: [{ text: "美容院 安い", paused: false }], negatives: [], groups: [{ name: c.adGroup, keywords: [] }] },
  ];
}

function payloadOf(): ReturnType<typeof syncPayload>["payload"] {
  return syncPayload(world().s, words, c, NOW).payload;
}

describe("見本のスクリプト（作り物の広告で）", () => {
  test("ファイルの頭に「本物のアカウントでは動かしていません」・空の窓口と合言葉・import も export も無い", () => {
    assert.match(SCRIPT.slice(0, 400), /本物の Google 広告のアカウントでは動かしていません/);
    const s = loadScript();
    assert.equal(s.CONFIG.endpoint, "");
    assert.equal(s.CONFIG.passcode, "");
    assert.equal(s.CONFIG.campaign, c.campaign, "作品の設定と同じ作り物の名前");
    assert.equal(s.CONFIG.adGroup, c.adGroup);
    assert.deepEqual([...(s.CONFIG.featuredWords as string[])], words);
    assert.doesNotMatch(SCRIPT, /^\s*(import|export)\s/m);
  });

  test("売りの言葉の確かめは featured.ts の本体と1字も違わない（同じ答え）", () => {
    const block = (src: string) => src.slice(src.indexOf("// <same>"), src.indexOf("// </same>"));
    const ts = readFileSync("src/lib/ads/featured.ts", "utf8");
    assert.ok(block(ts).length > 50);
    assert.equal(block(SCRIPT), block(ts));
    const s = loadScript();
    for (const t of ["縮毛矯正 くせ毛 ひどい", "ヘッド スパ", "美容院 安い 学生", ""]) assert.equal(s.featuredWordIn(t, words), featuredWordIn(t, words), t);
  });

  test("アプリの動きとビルドには入れない（画面・サーバーのコードから読まない）", () => {
    const tsconfig = readFileSync("tsconfig.json", "utf8");
    assert.match(tsconfig, /"allowJs": false/);
    const files = readdirSync("src", { recursive: true }).map(String).filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("__tests__"));
    for (const f of files) assert.doesNotMatch(readFileSync(join("src", f), "utf8"), /(from|import|require\()\s*["'][^"']*connect\/google-ads/, f);
  });

  test("承認済みの3種類だけ行う：止める（pause）・外す（完全一致の除外）・足す（フレーズ一致）。読み直して確かめ、結果を送り返す", () => {
    const acct = shopAccount();
    const ads = fakeAds(acct);
    const p = payloadOf();
    const http = fakeHttp({ ...p, items: [...p.items, { id: "x", kind: "remove", text: "美容院 安い", approvedAt: NOW }] });
    const out = loadScript().runSync({ ads, http, config: CFG, now: () => NOW });
    assert.equal(out.ok, true);
    assert.equal(out.sent, true);
    assert.deepEqual(ads.calls, ["negative:[美容院 安い 学生]", 'add:"縮毛矯正 くせ毛 ひどい"', "pause:美容院 安い"]);
    assert.deepEqual(out.result!.results.map((r) => [r.id, r.status]), [["ad-1", "done"], ["ad-1-add1", "done"], ["ad-2", "done"]], "形の違う案（種類 remove）は行わず、結果にも入れない");
    assert.equal(acct[0].keywords[0].paused, true);
    assert.equal(acct[1].keywords[0].paused, false, "ほかのキャンペーンは触らない");
    assert.deepEqual(acct[0].negatives, ["[美容院 安い 学生]"]);
    assert.ok(acct[0].groups[0].keywords.some((k) => k.text === '"縮毛矯正 くせ毛 ひどい"'));
    // 合言葉つきで読み、同じ窓口に送り返す
    assert.deepEqual(http.gets[0].headers, { Authorization: "Bearer test-only" });
    assert.equal(http.posts.length, 1);
    // 送り返した結果は、作品の「結果の読み込み」でそのまま読める
    const r = readSyncResult(JSON.stringify(http.posts[0].body), world().s, words, c);
    assert.ok(r.ok);
    assert.deepEqual(r.marks.map((m) => m.id), ["ad-1", "ad-1-add1", "ad-2"]);
  });

  test("承認した日時の無い案は行わない", () => {
    const ads = fakeAds(shopAccount());
    const p = payloadOf();
    const out = loadScript().runSync({ ads, http: fakeHttp({ ...p, items: p.items.map((i) => ({ ...i, approvedAt: undefined })) }), config: CFG });
    assert.deepEqual(ads.calls, []);
    assert.ok(out.result!.results.every((r) => r.status === "failed" && r.reason === "承認済みの案ではありません"));
  });

  test("キャンペーンの名前が違う（渡した中身・設定・アカウントのどれか）と何もしない", () => {
    const p = payloadOf();
    for (const [what, payload, cfg, acct] of [
      ["渡した中身が違う", { ...p, campaign: "ほか" }, CFG, shopAccount()],
      ["設定が違う", p, { ...CFG, campaign: "ほか" }, shopAccount()],
      ["アカウントに無い", p, CFG, shopAccount().slice(1)],
      ["同じ名前が2つ", p, CFG, [...shopAccount(), { ...shopAccount()[0] }]],
    ] as const) {
      const ads = fakeAds(acct as FakeCampaign[]);
      const http = fakeHttp(payload);
      const out = loadScript().runSync({ ads, http, config: cfg });
      assert.equal(out.ok, false, what);
      assert.deepEqual(ads.calls, [], what);
      assert.equal(http.posts.length, 0, what);
    }
  });

  test("言葉や広告グループが見つからない・2つ以上の時は何もせず「できなかった」", () => {
    const p = payloadOf();
    const acct = shopAccount();
    acct[0].keywords = [{ text: "美容院 安い", paused: false }, { text: '"美容院 安い"', paused: false }];
    acct[0].groups.push({ name: c.adGroup, keywords: [] });
    const ads = fakeAds(acct);
    const out = loadScript().runSync({ ads, http: fakeHttp(p), config: CFG });
    const byId = new Map(out.result!.results.map((r) => [r.id, r]));
    assert.equal(byId.get("ad-2")?.status, "failed");
    assert.match(byId.get("ad-2")?.reason ?? "", /2つ以上/);
    assert.match(byId.get("ad-1-add1")?.reason ?? "", /広告グループが2つ以上/);
    assert.ok(!ads.calls.some((x) => x.startsWith("pause") || x.startsWith("add")));

    const none = shopAccount();
    none[0].keywords = [];
    none[0].groups = [];
    const ads2 = fakeAds(none);
    const out2 = loadScript().runSync({ ads: ads2, http: fakeHttp(p), config: CFG });
    const by2 = new Map(out2.result!.results.map((r) => [r.id, r]));
    assert.match(by2.get("ad-2")?.reason ?? "", /見つかりません/);
    assert.match(by2.get("ad-1-add1")?.reason ?? "", /広告グループが見つかりません/);
  });

  test("売りの言葉の無い足すは行わない（渡す中身に混ざっていても）", () => {
    const p = payloadOf();
    const ads = fakeAds(shopAccount());
    const out = loadScript().runSync({ ads, http: fakeHttp({ ...p, items: [{ id: "z", kind: "add", text: "美容院 安い 学生", match: "phrase", approvedAt: NOW }] }), config: CFG });
    assert.deepEqual(ads.calls, []);
    assert.equal(out.result!.results[0].status, "failed");
    assert.match(out.result!.results[0].reason ?? "", /売りの言葉/);
  });

  test("プレビューの時は送り返さない（「反映した」とも言わない）", () => {
    const ads = fakeAds(shopAccount(), true);
    const http = fakeHttp(payloadOf());
    const out = loadScript().runSync({ ads, http, config: CFG });
    assert.equal(out.preview, true);
    assert.equal(out.sent, false);
    assert.equal(http.posts.length, 0);
    assert.ok(ads.calls.length > 0, "プレビューでは変える操作を試す");
    assert.ok(out.result!.results.every((r) => r.status === "failed"));
  });

  test("1回に行う数の上限をこえない", () => {
    const p = payloadOf();
    const ads = fakeAds(shopAccount());
    const out = loadScript().runSync({ ads, http: fakeHttp(p), config: { ...CFG, maxOps: 1 } });
    assert.equal(ads.calls.length, 1);
    assert.deepEqual(out.result!.results.map((r) => r.status), ["done", "failed", "failed"]);
    assert.match(out.result!.results[2].reason ?? "", /上限/);
  });

  test("読み直しで変わっていなければ「できなかった」", () => {
    const acct = shopAccount();
    acct[0].ignorePause = true;
    acct[0].ignoreNegative = true;
    acct[0].groups[0].failBuild = true;
    const out = loadScript().runSync({ ads: fakeAds(acct), http: fakeHttp(payloadOf()), config: CFG });
    assert.deepEqual(out.result!.results.map((r) => r.status), ["failed", "failed", "failed"]);
    assert.match(out.result!.results.map((r) => r.reason).join(), /読み直しても止まっていませんでした/);
    assert.match(out.result!.results.map((r) => r.reason).join(), /読み直しても外せていませんでした/);
  });

  test("窓口の場所と合言葉が空なら、何も読まず何もしない（main は広告の部品をここだけで読む）", () => {
    const ads = fakeAds(shopAccount());
    const http = fakeHttp(payloadOf());
    const logs: string[] = [];
    const s = loadScript({ AdsApp: ads, UrlFetchApp: http, Logger: { log: (x: string) => logs.push(x) } });
    s.main();
    assert.equal(http.gets.length, 0);
    assert.deepEqual(ads.calls, []);
    assert.match(logs.join(), /空なので、何もしませんでした/);
    // 置き場を埋めれば main から同じ流れ
    Object.assign(s.CONFIG, { endpoint: CFG.endpoint, passcode: CFG.passcode });
    s.main();
    assert.equal(http.posts.length, 1);
    assert.equal((SCRIPT.match(/\bAdsApp\b|\bUrlFetchApp\b|\bLogger\./g) ?? []).filter((x) => x).length > 0, true);
    const body = SCRIPT.slice(SCRIPT.indexOf("function featuredWordIn"));
    assert.doesNotMatch(body, /\bAdsApp\b|\bUrlFetchApp\b|\bLogger\b/, "入口の main のほかでは広告の部品を直に読まない");
  });

  test("渡す中身が読めない・形が違う時は何もしない", () => {
    for (const [payload, code] of [["{", 200], [{ format: "x" }, 200], [payloadOf(), 500]] as const) {
      const ads = fakeAds(shopAccount());
      const http = fakeHttp(payload, code);
      const out = loadScript().runSync({ ads, http, config: CFG });
      assert.equal(out.ok, false);
      assert.deepEqual(ads.calls, []);
      assert.equal(http.posts.length, 0);
    }
  });

  test("README：本物の検索広告につなぐ道（言いすぎない）", () => {
    const readme = readFileSync("README.md", "utf8");
    const sec = readme.slice(readme.indexOf("## 本物の検索広告につなぐ道"), readme.indexOf("## 録音からメモを作る"));
    assert.match(sec, /今はつないでいません/);
    assert.match(sec, /本物のアカウントでは動かしていません/);
    assert.match(sec, /道1/);
    assert.match(sec, /道2/);
    assert.doesNotMatch(sec, /100%|必ず|すぐ反映/);
  });
});
