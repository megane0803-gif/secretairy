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
import { readSyncResult, realMarkedNos, RESULT_FORMAT, SYNC_FORMAT, syncItems, syncPayload, withSynced } from "../connect";
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
    // テスト用アカウントの設定（live）は、通行証を作る行き先（…/token）と合言葉の上限の数を持つので別に見る（鍵・番号・メールは無い）
    const { live, ...rest } = JSON.parse(readFileSync("config/ads.json", "utf8")) as Record<string, unknown>;
    assert.doesNotMatch(JSON.stringify(rest), /\d{3}-\d{3}-\d{4}|token|secret|passcode/i, "設定にも本物の番号・鍵を入れない");
    assert.doesNotMatch(JSON.stringify(live), /\d{3}-?\d{3}-?\d{4}|PRIVATE KEY|@|secret|client_email|customer/i, "テスト用アカウントの設定にも鍵・番号・メールを入れない");
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

  test("画面は「くわしく」の中に小さく置く（本物の広告の名前は画面に出さない）", () => {
    const page = readFileSync("src/app/ads/page.tsx", "utf8");
    const fold = page.slice(page.indexOf("<Fold"), page.indexOf("</Fold>"));
    assert.match(fold, /<AdsConnect \/>/);
    const ui = readFileSync("src/app/ads/AdsConnect.tsx", "utf8");
    assert.match(ui, /本物の広告に渡す形を見る（写す・結果を貼る。この欄からは送りません）/);
    assert.doesNotMatch(ui, /今はつないでいません/, "つないでいないと読める言い方をしない（直しU）");
    // 何も送っていないのに「本物に反映済み」の印が付く道（見本の結果のボタン）は置かない。貼る欄と読み込みだけ
    assert.doesNotMatch(ui, /見本の結果|sampleResult|DEMO_TAG_NOTE/);
    assert.doesNotMatch(readFileSync("src/lib/ads/connect.ts", "utf8"), /sampleResult/);
    assert.match(ui, /読み込む/);
    assert.match(ui, /<textarea/);
    for (const f of ["src/app/ads/AdsConnect.tsx", "src/app/ads/AdsLive.tsx", "src/app/ads/page.tsx", "src/app/ads/AdsReport.tsx", "src/components/AdAddRow.tsx"])
      assert.doesNotMatch(readFileSync(f, "utf8"), /Google|グーグル/, f);
    // 設定で名前を書くのは、テスト用アカウントにつながっている時の札（live.label）だけ
    const { live, ...rest } = JSON.parse(readFileSync("config/ads.json", "utf8")) as { live: Record<string, unknown> };
    assert.doesNotMatch(JSON.stringify(rest), /Google|グーグル/);
    const { label, ...liveRest } = live;
    assert.match(String(label), /^Google 広告（テスト用アカウント）$/);
    assert.doesNotMatch(JSON.stringify(liveRest).replace(/https:\/\/[a-z0-9.]+\.googleapis\.com[^"]*/g, ""), /Google|グーグル/);
  });
});

// ── 見本のスクリプト（connect/google-ads/secretairy-sync.js）を、作り物の広告の部品で動かす ──
// 作り物の部品は公式の資料の形に合わせる：条件は GAQL の文字（withCondition）・get() は hasNext／next／totalNumEntities・
// pause() と createNegativeKeyword() は何も返さない・build() は KeywordOperation（isSuccessful／getResult／getErrors を呼んだ時に実行）・
// プレビューでは何も作らず・変えない。

const SCRIPT_PATH = "connect/google-ads/secretairy-sync.js";
const SCRIPT = readFileSync(SCRIPT_PATH, "utf8");

type Status = "ENABLED" | "PAUSED" | "REMOVED";
type Match = "BROAD" | "PHRASE" | "EXACT";
type FakeKw = { text: string; match: Match; status: Status };
type FakeGroup = { name: string; status: Status; keywords: FakeKw[]; failBuild?: boolean };
type FakeCampaign = { name: string; status: Status; keywords: FakeKw[]; negatives: { text: string; match: Match }[]; groups: FakeGroup[]; ignorePause?: boolean; ignoreNegative?: boolean };

/** GAQL の条件の文字を読む（テストの部品。「列 = '文字'」「列 = 列挙」「列 IN (A, B)」だけ） */
function parseCond(c: string): { col: string; values: string[] } {
  const m = c.match(/^([a-z_.]+) (=|IN) (.+)$/);
  if (!m) throw new Error(`読めない条件：${c}`);
  const [, col, op, rest] = m;
  if (op === "IN") {
    const inner = rest.match(/^\(([A-Z_, ]+)\)$/);
    if (!inner) throw new Error(`読めない IN：${c}`);
    return { col, values: inner[1].split(",").map((x) => x.trim()) };
  }
  if (/^[A-Z_]+$/.test(rest)) return { col, values: [rest] };
  const str = rest.match(/^'((?:[^'\\]|\\.)*)'$/);
  if (!str) throw new Error(`読めない文字：${c}`);
  return { col, values: [str[1].replace(/\\(.)/g, "$1")] };
}

const decorate = (k: { text: string; match: Match }) => (k.match === "EXACT" ? `[${k.text}]` : k.match === "PHRASE" ? `"${k.text}"` : k.text);

function fakeAds(campaigns: FakeCampaign[], o: { preview?: boolean; customerId?: string } = {}) {
  const preview = !!o.preview;
  const calls: string[] = [];
  const conditions: string[] = [];
  /** 選び方：withCondition を重ね、get() で選ぶ */
  function selector<T>(name: string, all: () => T[], cols: Record<string, (x: T) => string>) {
    const conds: string[] = [];
    const sel = {
      withCondition(c: string) {
        conds.push(c);
        conditions.push(`${name}: ${c}`);
        return sel;
      },
      get() {
        calls.push(`get:${name}`);
        const parsed = conds.map(parseCond);
        for (const p of parsed) if (!cols[p.col]) throw new Error(`${name} に無い列：${p.col}`);
        const xs = all().filter((x) => parsed.every((p) => p.values.includes(cols[p.col](x))));
        let i = 0;
        return { hasNext: () => i < xs.length, next: () => xs[i++], totalNumEntities: () => xs.length };
      },
    };
    return sel;
  }
  const kwObj = (k: FakeKw, c: FakeCampaign) => ({
    getText: () => decorate(k),
    getMatchType: () => k.match,
    isPaused: () => k.status === "PAUSED",
    isEnabled: () => k.status === "ENABLED",
    pause: () => {
      calls.push(`pause:${k.text}`);
      if (!preview && !c.ignorePause) k.status = "PAUSED";
      return undefined;
    },
  });
  const kwCols = {
    "ad_group_criterion.keyword.text": (x: { k: FakeKw }) => x.k.text,
    "ad_group_criterion.keyword.match_type": (x: { k: FakeKw }) => x.k.match,
    "ad_group_criterion.status": (x: { k: FakeKw }) => x.k.status,
  };
  const ads = {
    calls,
    conditions,
    currentAccount: () => ({ getCustomerId: () => o.customerId ?? "123-456-7890" }),
    getExecutionInfo: () => ({ isPreview: () => preview }),
    campaigns: () =>
      selector(
        "campaigns",
        () =>
          campaigns.map((c) => ({
            c,
            getName: () => c.name,
            keywords: () =>
              selector("keywords", () => [...c.keywords, ...c.groups.flatMap((g) => g.keywords)].map((k) => ({ k, ...kwObj(k, c) })), kwCols),
            // キャンペーンの除外だけ。除外の選び方に ad_group_criterion.status の列は無い
            negativeKeywords: () =>
              selector("negativeKeywords", () => c.negatives.map((n) => ({ n, getText: () => decorate(n), getMatchType: () => n.match })), {
                "ad_group_criterion.keyword.text": (x: { n: { text: string } }) => x.n.text,
                "ad_group_criterion.keyword.match_type": (x: { n: { match: Match } }) => x.n.match,
              }),
            createNegativeKeyword: (t: string) => {
              calls.push(`negative:${t}`);
              const m = t.match(/^\[(.*)\]$/);
              if (!preview && !c.ignoreNegative && m) c.negatives.push({ text: m[1], match: "EXACT" });
              return undefined;
            },
            adGroups: () =>
              selector(
                "adGroups",
                () =>
                  c.groups.map((g) => ({
                    g,
                    getName: () => g.name,
                    keywords: () => selector("groupKeywords", () => g.keywords.map((k) => ({ k, ...kwObj(k, c) })), kwCols),
                    newKeywordBuilder: () => {
                      let text = "";
                      const b = {
                        withText: (t: string) => ((text = t), b),
                        build: () => {
                          calls.push(`build:${text}`);
                          // KeywordOperation：isSuccessful・getResult・getErrors のどれかを呼んだ時に実行される
                          let done: boolean | null = null;
                          const run = () => {
                            if (done !== null) return done;
                            calls.push(`run:${text}`);
                            done = !g.failBuild;
                            const m = text.match(/^"(.*)"$/);
                            if (done && !preview && m) g.keywords.push({ text: m[1], match: "PHRASE", status: "ENABLED" });
                            return done;
                          };
                          return { isSuccessful: () => run(), getResult: () => (run() ? {} : null), getErrors: () => (run() ? [] : ["だめ"]) };
                        },
                      };
                      return b;
                    },
                  })),
                { "ad_group.name": (x: { g: FakeGroup }) => x.g.name, "ad_group.status": (x: { g: FakeGroup }) => x.g.status },
              ),
          })),
        { "campaign.name": (x: { c: FakeCampaign }) => x.c.name, "campaign.status": (x: { c: FakeCampaign }) => x.c.status },
      ),
  };
  return ads;
}

/** 作り物の UrlFetchApp：GET で渡す中身を返し、POST を覚える */
function fakeHttp(payload: unknown, code = 200) {
  const posts: { url: string; body: unknown; headers: unknown; method: string }[] = [];
  const gets: { url: string; headers: unknown; method: string; mute: boolean }[] = [];
  return {
    posts,
    gets,
    fetch: (url: string, p: { method?: string; payload?: string; headers?: unknown; muteHttpExceptions?: boolean }) => {
      const headers = JSON.parse(JSON.stringify(p.headers ?? null));
      if (p.method === "POST") {
        posts.push({ url, body: JSON.parse(p.payload ?? "null"), headers, method: p.method });
        return { getResponseCode: () => 200, getContentText: () => "" };
      }
      gets.push({ url, headers, method: String(p.method), mute: p.muteHttpExceptions === true });
      return { getResponseCode: () => code, getContentText: () => (typeof payload === "string" ? payload : JSON.stringify(payload)) };
    },
  };
}

type SyncOut = { ok: boolean; note: string; preview: boolean; write: boolean; sent: boolean; result?: { results: { id: string; kind: string; text: string; status: string; reason?: string }[] } };
type Sync = (deps: unknown) => SyncOut;

/** スクリプトを、貼った時と同じく1つのファイルとして読み込む（import も export も無い形） */
function loadScript(globals: Record<string, unknown> = {}) {
  const ctx = vm.createContext({ ...globals });
  vm.runInContext(SCRIPT, ctx, { filename: SCRIPT_PATH });
  const s = ctx as unknown as { runSync: Sync; featuredWordIn: (t: string, w: string[]) => string | null; main: () => void; CONFIG: Record<string, unknown> };
  // スクリプトの中の配列は別の世界の物なので、JSON で写してから比べる
  const run: Sync = (deps) => JSON.parse(JSON.stringify(s.runSync(deps)));
  return { runSync: run, featuredWordIn: s.featuredWordIn, main: () => s.main(), CONFIG: s.CONFIG };
}

/** 書き込む設定・番号・窓口・合言葉を入れた設定（テストだけ） */
const CFG = {
  write: true,
  customerId: "123-456-7890",
  endpoint: "https://example.invalid/api/ads/sync",
  passcode: "test-only",
  campaign: c.campaign,
  adGroup: c.adGroup,
  featuredWords: words,
  towns: settings.towns,
  maxOps: 10,
  maxTextChars: 40,
};

function shopAccount(): FakeCampaign[] {
  return [
    {
      name: c.campaign,
      status: "ENABLED",
      keywords: [
        { text: "美容院 安い", match: "BROAD", status: "ENABLED" },
        { text: "美容室 omochi", match: "EXACT", status: "ENABLED" },
        { text: "古い言葉", match: "BROAD", status: "REMOVED" },
      ],
      negatives: [],
      groups: [{ name: c.adGroup, status: "ENABLED", keywords: [{ text: "縮毛矯正 くせ毛", match: "PHRASE", status: "ENABLED" }] }],
    },
    { name: "ほかのキャンペーン", status: "ENABLED", keywords: [{ text: "美容院 安い", match: "BROAD", status: "ENABLED" }], negatives: [], groups: [{ name: c.adGroup, status: "ENABLED", keywords: [] }] },
  ];
}

function payloadOf(): ReturnType<typeof syncPayload>["payload"] {
  return syncPayload(world().s, words, c, NOW).payload;
}

const writes = (calls: string[]) => calls.filter((x) => /^(pause|negative|build|run):/.test(x));

describe("見本のスクリプト（作り物の広告で）", () => {
  test("ファイルの頭に「本物のアカウントでは動かしていません」・書き込まない設定・空の番号と窓口と合言葉・import も export も無い", () => {
    assert.match(SCRIPT.slice(0, 400), /本物の Google 広告のアカウントでは動かしていません/);
    const s = loadScript();
    assert.equal(s.CONFIG.write, false, "最初は書き込まない");
    assert.equal(s.CONFIG.customerId, "");
    assert.equal(s.CONFIG.endpoint, "");
    assert.equal(s.CONFIG.passcode, "");
    assert.equal(s.CONFIG.campaign, c.campaign, "作品の設定と同じ作り物の名前");
    assert.equal(s.CONFIG.adGroup, c.adGroup);
    assert.deepEqual([...(s.CONFIG.featuredWords as string[])], words);
    assert.deepEqual([...(s.CONFIG.towns as string[])], settings.towns, "町の名前は作品の設定と同じ");
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
    assert.deepEqual(writes(ads.calls), ["negative:[美容院 安い 学生]", 'build:"縮毛矯正 くせ毛 ひどい"', "pause:美容院 安い", 'run:"縮毛矯正 くせ毛 ひどい"']);
    assert.deepEqual(out.result!.results.map((r) => [r.id, r.status]), [["ad-1", "done"], ["ad-1-add1", "done"], ["ad-2", "done"]], "形の違う案（種類 remove）は行わず、結果にも入れない");
    assert.equal(acct[0].keywords[0].status, "PAUSED");
    assert.equal(acct[1].keywords[0].status, "ENABLED", "ほかのキャンペーンは触らない");
    assert.deepEqual(acct[0].negatives, [{ text: "美容院 安い 学生", match: "EXACT" }]);
    assert.ok(acct[0].groups[0].keywords.some((k) => k.text === "縮毛矯正 くせ毛 ひどい" && k.match === "PHRASE"));
    // 合言葉つきで読み（大文字の GET・muteHttpExceptions）、同じ窓口に POST で送り返す
    assert.deepEqual(http.gets[0], { url: CFG.endpoint, headers: { Authorization: "Bearer test-only" }, method: "GET", mute: true });
    assert.equal(http.posts.length, 1);
    assert.equal(http.posts[0].method, "POST");
    // 送り返した結果は、作品の「結果の読み込み」でそのまま読める
    const r = readSyncResult(JSON.stringify(http.posts[0].body), world().s, words, c);
    assert.ok(r.ok);
    assert.deepEqual(r.marks.map((m) => m.id), ["ad-1", "ad-1-add1", "ad-2"]);
  });

  test("探す条件は GAQL の形（列の名前・列挙は大文字・文字は ' で囲む）", () => {
    const ads = fakeAds(shopAccount());
    loadScript().runSync({ ads, http: fakeHttp(payloadOf()), config: CFG });
    const conds = new Set(ads.conditions);
    for (const want of [
      `campaigns: campaign.name = '${c.campaign}'`,
      "campaigns: campaign.status IN (ENABLED, PAUSED)",
      "keywords: ad_group_criterion.keyword.text = '美容院 安い'",
      "keywords: ad_group_criterion.status IN (ENABLED, PAUSED)",
      "negativeKeywords: ad_group_criterion.keyword.text = '美容院 安い 学生'",
      "negativeKeywords: ad_group_criterion.keyword.match_type = EXACT",
      `adGroups: ad_group.name = '${c.adGroup}'`,
      "adGroups: ad_group.status IN (ENABLED, PAUSED)",
      "groupKeywords: ad_group_criterion.keyword.text = '縮毛矯正 くせ毛 ひどい'",
      "groupKeywords: ad_group_criterion.keyword.match_type = PHRASE",
    ])
      assert.ok(conds.has(want), want);
    assert.ok(![...conds].some((x) => /Name = "|CampaignName|Status =/.test(x)), "古い AWQL の形は使わない");
    assert.ok(![...conds].some((x) => x.startsWith("negativeKeywords: ad_group_criterion.status")), "除外の選び方に status の列は無い");
  });

  test("文字の中の ' と \\ は \\ で逃がす（名前で別の物を選ばない）", () => {
    const acct = shopAccount();
    acct[0].name = "もちの木 'テスト' \\検索";
    const ads = fakeAds(acct);
    const p = { ...payloadOf(), campaign: acct[0].name };
    const out = loadScript().runSync({ ads, http: fakeHttp(p), config: { ...CFG, campaign: acct[0].name } });
    assert.equal(out.ok, true);
    assert.ok(ads.conditions.includes("campaigns: campaign.name = 'もちの木 \\'テスト\\' \\\\検索'"), ads.conditions[0]);
  });

  test("書き込まない設定（最初の形）の間は何も変えず、行うはずだった物を「試し」として出すだけ・送り返さない", () => {
    const acct = shopAccount();
    const before = JSON.stringify(acct);
    const ads = fakeAds(acct);
    const http = fakeHttp(payloadOf());
    const out = loadScript().runSync({ ads, http, config: { ...CFG, write: false } });
    assert.deepEqual(writes(ads.calls), [], "止める・外す・足すを呼ばない");
    assert.equal(JSON.stringify(acct), before);
    assert.equal(out.write, false);
    assert.equal(out.sent, false);
    assert.equal(http.posts.length, 0);
    assert.deepEqual(out.result!.results.map((r) => [r.id, r.status, r.reason]), [
      ["ad-1", "failed", "試し（書き込まない設定なので、行っていません）"],
      ["ad-1-add1", "failed", "試し（書き込まない設定なので、行っていません）"],
      ["ad-2", "failed", "試し（書き込まない設定なので、行っていません）"],
    ]);
  });

  test("窓口と合言葉を入れただけでは書き込まない（main・最初の設定のまま）", () => {
    const ads = fakeAds(shopAccount());
    const http = fakeHttp(payloadOf());
    const logs: string[] = [];
    const s = loadScript({ AdsApp: ads, UrlFetchApp: http, Logger: { log: (x: string) => logs.push(x) } });
    s.main();
    assert.equal(http.gets.length, 0);
    assert.match(logs.join(), /アカウントの番号の置き場が空なので、何もしませんでした/);
    Object.assign(s.CONFIG, { customerId: "123-456-7890", endpoint: CFG.endpoint, passcode: CFG.passcode });
    s.main();
    assert.equal(http.gets.length, 1);
    assert.deepEqual(writes(ads.calls), []);
    assert.equal(http.posts.length, 0);
    // 書き込む設定にした時だけ、main から同じ流れで変える
    s.CONFIG.write = true;
    s.main();
    assert.equal(http.posts.length, 1);
    assert.ok(writes(ads.calls).length > 0);
    // 説明の書きこみ（// の行と /* */）を除いたコードで見る
    const body = SCRIPT.slice(SCRIPT.indexOf("function featuredWordIn"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(body, /\bAdsApp\b|\bUrlFetchApp\b|\bLogger\b/, "入口の main のほかでは広告の部品を直に読まない");
  });

  test("アカウントの番号：置き場が空・違う番号なら何も読まず何もしない（ハイフンの有無は同じに見る）", () => {
    for (const [what, cfgId, acctId, ran] of [
      ["空", "", "123-456-7890", false],
      ["違う", "111-222-3333", "123-456-7890", false],
      ["ハイフンなし", "1234567890", "123-456-7890", true],
    ] as const) {
      const ads = fakeAds(shopAccount(), { customerId: acctId });
      const http = fakeHttp(payloadOf());
      const out = loadScript().runSync({ ads, http, config: { ...CFG, customerId: cfgId } });
      assert.equal(http.gets.length > 0, ran, what);
      if (!ran) {
        assert.equal(out.ok, false, what);
        assert.deepEqual(ads.calls, [], what);
      }
    }
  });

  test("町の名前の入った言葉は外さない（「できなかった」）", () => {
    const ads = fakeAds(shopAccount());
    const out = loadScript().runSync({
      ads,
      http: fakeHttp({ ...payloadOf(), items: [{ id: "t", kind: "exclude", text: "もちの木町 美容室", match: "exact", approvedAt: NOW }] }),
      config: CFG,
    });
    assert.deepEqual(writes(ads.calls), []);
    assert.deepEqual(out.result!.results.map((r) => [r.status, r.reason]), [["failed", "町の名前の入った言葉は外さない"]]);
  });

  test("承認した日時の無い案は行わない", () => {
    const ads = fakeAds(shopAccount());
    const p = payloadOf();
    const out = loadScript().runSync({ ads, http: fakeHttp({ ...p, items: p.items.map((i) => ({ ...i, approvedAt: undefined })) }), config: CFG });
    assert.deepEqual(writes(ads.calls), []);
    assert.ok(out.result!.results.every((r) => r.status === "failed" && r.reason === "承認済みの案ではありません"));
  });

  test("キャンペーンの名前が違う（渡した中身・設定・アカウントのどれか）・止めたキャンペーン以外の消した物しか無い・2つあると何もしない", () => {
    const p = payloadOf();
    const removed = shopAccount();
    removed[0].status = "REMOVED";
    for (const [what, payload, cfg, acct] of [
      ["渡した中身が違う", { ...p, campaign: "ほか" }, CFG, shopAccount()],
      ["設定が違う", p, { ...CFG, campaign: "ほか" }, shopAccount()],
      ["アカウントに無い", p, CFG, shopAccount().slice(1)],
      ["消したキャンペーンだけ", p, CFG, removed],
      ["同じ名前が2つ", p, CFG, [...shopAccount(), { ...shopAccount()[0] }]],
    ] as const) {
      const ads = fakeAds(acct as FakeCampaign[]);
      const http = fakeHttp(payload);
      const out = loadScript().runSync({ ads, http, config: cfg });
      assert.equal(out.ok, false, what);
      assert.deepEqual(writes(ads.calls), [], what);
      assert.equal(http.posts.length, 0, what);
    }
  });

  test("言葉や広告グループが見つからない・2つ以上の時は何もせず「できなかった」", () => {
    const p = payloadOf();
    const acct = shopAccount();
    acct[0].keywords = [
      { text: "美容院 安い", match: "BROAD", status: "ENABLED" },
      { text: "美容院 安い", match: "PHRASE", status: "PAUSED" },
    ];
    acct[0].groups.push({ name: c.adGroup, status: "PAUSED", keywords: [] });
    const ads = fakeAds(acct);
    const out = loadScript().runSync({ ads, http: fakeHttp(p), config: CFG });
    const byId = new Map(out.result!.results.map((r) => [r.id, r]));
    assert.equal(byId.get("ad-2")?.status, "failed");
    assert.match(byId.get("ad-2")?.reason ?? "", /2つ以上/);
    assert.match(byId.get("ad-1-add1")?.reason ?? "", /広告グループが2つ以上/);
    assert.ok(!writes(ads.calls).some((x) => x.startsWith("pause") || x.startsWith("build")));

    const none = shopAccount();
    none[0].keywords = [{ text: "美容院 安い", match: "BROAD", status: "REMOVED" }];
    none[0].groups = [{ name: c.adGroup, status: "REMOVED", keywords: [] }];
    const out2 = loadScript().runSync({ ads: fakeAds(none), http: fakeHttp(p), config: CFG });
    const by2 = new Map(out2.result!.results.map((r) => [r.id, r]));
    assert.match(by2.get("ad-2")?.reason ?? "", /見つかりません/, "消した言葉は探さない");
    assert.match(by2.get("ad-1-add1")?.reason ?? "", /広告グループが見つかりません/);
  });

  test("売りの言葉の無い足すは行わない（渡す中身に混ざっていても）", () => {
    const ads = fakeAds(shopAccount());
    const out = loadScript().runSync({ ads, http: fakeHttp({ ...payloadOf(), items: [{ id: "z", kind: "add", text: "美容院 安い 学生", match: "phrase", approvedAt: NOW }] }), config: CFG });
    assert.deepEqual(writes(ads.calls), []);
    assert.equal(out.result!.results[0].status, "failed");
    assert.match(out.result!.results[0].reason ?? "", /売りの言葉/);
  });

  test("createNegativeKeyword の後に読み直して確かめる（何も返さないので）", () => {
    const ads = fakeAds(shopAccount());
    loadScript().runSync({ ads, http: fakeHttp({ ...payloadOf(), items: [payloadOf().items[0]] }), config: CFG });
    assert.deepEqual(ads.calls, ["get:campaigns", "get:negativeKeywords", "negative:[美容院 安い 学生]", "get:negativeKeywords"]);
  });

  test("足すは全部 build してから、後でまとめて確かめる", () => {
    const ads = fakeAds(shopAccount());
    loadScript().runSync({ ads, http: fakeHttp(payloadOf()), config: CFG });
    const w = writes(ads.calls);
    assert.ok(w.indexOf('build:"縮毛矯正 くせ毛 ひどい"') < w.indexOf("pause:美容院 安い"), "build は1回目の回りで");
    assert.ok(w.indexOf('run:"縮毛矯正 くせ毛 ひどい"') > w.indexOf("pause:美容院 安い"), "実行（isSuccessful）は後の確かめの回りで");
  });

  test("もうある物は何もしない（2回動いても重ならない）", () => {
    const acct = shopAccount();
    const ads = fakeAds(acct);
    const p = payloadOf();
    const s = loadScript();
    s.runSync({ ads, http: fakeHttp(p), config: CFG });
    const before = JSON.stringify(acct);
    ads.calls.length = 0;
    const out = s.runSync({ ads, http: fakeHttp(p), config: CFG });
    assert.equal(JSON.stringify(acct), before);
    assert.deepEqual(writes(ads.calls), ["pause:美容院 安い"], "外す・足すは呼ばない（止めるはもう一度止めても同じ）");
    assert.ok(out.result!.results.every((r) => r.status === "done"));
  });

  test("プレビューの時は読み直さず「試し」・送り返さない", () => {
    const acct = shopAccount();
    const ads = fakeAds(acct, { preview: true });
    const http = fakeHttp(payloadOf());
    const out = loadScript().runSync({ ads, http, config: CFG });
    assert.equal(out.preview, true);
    assert.equal(out.sent, false);
    assert.equal(http.posts.length, 0);
    assert.ok(writes(ads.calls).length > 0, "プレビューでは変える操作を試す（何も変わらない）");
    assert.equal(acct[0].keywords[0].status, "ENABLED");
    // 変える操作の後に読み直さない（最後の get は変える操作の前）
    const lastGet = ads.calls.map((x, i) => (x.startsWith("get:") ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const firstWrite = ads.calls.findIndex((x) => /^(pause|negative|build):/.test(x));
    assert.ok(lastGet < firstWrite || ads.calls.slice(firstWrite).every((x) => !x.startsWith("get:negativeKeywords")), ads.calls.join(" "));
    assert.ok(!ads.calls.slice(ads.calls.indexOf("pause:美容院 安い")).some((x) => x.startsWith("get:")), "止めた後に読み直さない");
    assert.ok(out.result!.results.every((r) => r.status === "failed" && /試し（プレビュー）/.test(r.reason ?? "")));
  });

  test("1回に行う数の上限をこえない", () => {
    const ads = fakeAds(shopAccount());
    const out = loadScript().runSync({ ads, http: fakeHttp(payloadOf()), config: { ...CFG, maxOps: 1 } });
    assert.deepEqual(writes(ads.calls), ["negative:[美容院 安い 学生]"]);
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
    const reasons = out.result!.results.map((r) => r.reason).join();
    assert.match(reasons, /読み直しても止まっていませんでした/);
    assert.match(reasons, /読み直しても外せていませんでした/);
    assert.match(reasons, /足せませんでした/);
  });

  test("渡す中身が読めない・形が違う時は何もしない", () => {
    for (const [payload, code] of [["{", 200], [{ format: "x" }, 200], [payloadOf(), 500]] as const) {
      const ads = fakeAds(shopAccount());
      const http = fakeHttp(payload, code);
      const out = loadScript().runSync({ ads, http, config: CFG });
      assert.equal(out.ok, false);
      assert.deepEqual(writes(ads.calls), []);
      assert.equal(http.posts.length, 0);
    }
  });

  test("README：本物の検索広告につなぐ道（言いすぎない・道2は今の形）", () => {
    const readme = readFileSync("README.md", "utf8");
    const sec = readme.slice(readme.indexOf("## 本物の検索広告につなぐ道"), readme.indexOf("## 録音からメモを作る"));
    assert.match(sec, /本物の（テスト用でない）広告のアカウントにはつないでいません/);
    assert.match(sec, /本物の広告に渡す形を見る（写す・結果を貼る。この欄からは送りません）/);
    assert.match(sec, /本物のアカウントでは動かしていません/);
    assert.match(sec, /道1/);
    assert.match(sec, /道2/);
    assert.match(sec, /Explorer/);
    assert.doesNotMatch(sec, /開発者の鍵を申し込/);
    assert.doesNotMatch(sec, /100%|必ず|すぐ反映/);
  });
});
