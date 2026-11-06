// ホームの「AI の仕事」のテスト。Claude は呼ばず、窓口の中身（予約・広告・メモ）を決まった返事で動かす。
// 置き場所はメモリ。1行ずつ動く・まとめて動かすと上から順に動く・2回は動かない・最初に戻すで戻る・上限・AI につながらない時。

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import aiJson from "../../../../config/ai.json";
import { EMPTY_ACCOUNTING, parseAccounting, type AccountingState } from "../../accounting/state";
import { EMPTY_ADS, parseAds, pendingAd, type AdsState } from "../../ads/state";
import { runReview } from "../../ads/review";
import { scriptAdsModel } from "../../ads/script";
import { parseAdsRequest, type AdsResponse } from "../../ads/wire";
import { runReserve } from "../../ai/agent";
import { contextFor, parseReserveRequest } from "../../ai/request";
import { scriptModel } from "../../ai/script";
import type { ReserveEvent } from "../../ai/wire";
import { getBookData } from "../../book/data";
import { emptyBook, parseBook, pendingApprovals, type BookState } from "../../book/state";
import { BOOK_KEY, JOBS_KEY, JOBS_SWITCH_KEY, readBrowser, writeBrowser } from "../../browser";
import { shopToday } from "../../calendar";
import { getAccounting } from "../../data/seed";
import type { JournalEntry } from "../../journal";
import { resetAll } from "../../reset";
import { getRules } from "../../rules/store";
import { getAdSettings, getAdsAiSettings, getAiSettings, getJobsSettings, getMenus, getShop, getTodoAiSettings } from "../../settings";
import { runTodo } from "../../todo/run";
import { parseTodoRequest, type TodoResponse } from "../../todo/wire";
import { scriptTodoWriter } from "../../todo/writer";
import { ALREADY_THIS_WEEK, AI_CALLS, cardSorted, runJob, runJobs, type JobAsk, type JobEnv, type JobStore } from "../run";
import { EMPTY_JOBS, JOB_IDS, parseJobs, type JobId, type JobsState } from "../state";

const data = getBookData();
const shop = getShop();
const menus = getMenus();
// 水曜の朝（開店前）に開いた
const NOW = new Date("2026-11-04T08:30:00+09:00");
const TODAY = shopToday(shop, NOW).today.date;

/** 窓口の中身を、決まった返事でそのまま動かす（サーバーの route.ts と同じ順に確かめる） */
function scriptAsk(calls: string[] = [], down = false): JobAsk {
  const ai = getAiSettings();
  return {
    async reserve(body) {
      calls.push("reserve");
      if (down) return [{ t: "error", code: "no-ai", message: "今は AI につながりません" }];
      const p = parseReserveRequest(JSON.parse(JSON.stringify(body)), menus, ai);
      assert.ok(p.ok, p.ok ? "" : p.reason);
      if (!p.ok) return [];
      assert.equal(p.value.mode, "script", "テストでは決まった返事");
      let n = 0;
      const ctx = contextFor(p.value, shop, menus, NOW, () => `h-job-${++n}`);
      const events: ReserveEvent[] = [];
      await runReserve({ ctx, history: p.value.messages, model: scriptModel(ctx), limits: ai, emit: (e) => events.push(e) });
      return events;
    },
    async ads(body): Promise<AdsResponse> {
      calls.push("ads");
      if (down) return { ok: false, code: "no-ai", message: "今は AI につながりません" };
      const a = getAdsAiSettings();
      const p = parseAdsRequest(JSON.parse(JSON.stringify(body)), menus.map((m) => m.id), a.maxFixChars);
      if (!p.ok) return { ok: false, code: "bad-request", message: p.reason };
      const r = await runReview({
        table: p.value.table,
        rules: p.value.rules,
        settings: getAdSettings(),
        model: scriptAdsModel(p.value.table),
        maxTokens: a.maxReplyTokens,
        maxTries: a.maxTries,
      });
      return r.ok ? r : { ...r, code: "gate" };
    },
    async todo(body): Promise<TodoResponse> {
      calls.push("todo");
      if (down) return { ok: false, code: "no-ai", message: "今は AI につながりません" };
      const t = getTodoAiSettings();
      const p = parseTodoRequest(JSON.parse(JSON.stringify(body)), t.maxMemoChars, menus.map((m) => m.id));
      if (!p.ok) return { ok: false, code: "bad-request", message: p.reason };
      const out = await runTodo({ memo: p.value.memo, mode: p.value.mode, writer: scriptTodoWriter(), rules: p.value.rules, maxTokens: t.maxReplyTokens, maxTitleChars: t.maxTitleChars });
      return { ok: true, ...out };
    },
  };
}

type World = { book: BookState; ads: AdsState; acct: AccountingState; jobs: JobsState; journal: JournalEntry[] };

function memoryStore(w: World): JobStore {
  return {
    book: () => w.book,
    setBook: (f) => void (w.book = f(w.book)),
    ads: () => w.ads,
    setAds: (f) => void (w.ads = f(w.ads)),
    accounting: () => w.acct,
    jobs: () => w.jobs,
    setJobs: (f) => void (w.jobs = f(w.jobs)),
  };
}

function setup(over: { down?: boolean; ads?: AdsState } = {}) {
  const w: World = { book: emptyBook(TODAY), ads: over.ads ?? EMPTY_ADS, acct: EMPTY_ACCOUNTING, jobs: EMPTY_JOBS, journal: [] };
  const calls: string[] = [];
  let n = 0;
  const env: JobEnv = {
    data,
    rules: getRules(),
    mode: "script",
    store: memoryStore(w),
    ask: scriptAsk(calls, over.down),
    journal: (...lines) => lines.forEach((l) => w.journal.push({ id: `j${w.journal.length}`, at: NOW.toISOString(), ...l })),
    now: () => NOW,
    adSettings: getAdSettings(),
    newId: () => `ad-test-${++n}`,
  };
  return { w, env, calls };
}

const budget = () => ({ left: getJobsSettings().maxAiCallsPerPress });

describe("AI の仕事：1行ずつ動く", () => {
  test("予約の相談：決まった返事で返事をして仮押さえ → 承認の箱へ（確定はしない）", async () => {
    const { w, env, calls } = setup();
    const r = await runJob("reserve", env, budget());
    assert.deepEqual(r, { kind: "done", result: "承認待ち1件", tab: "reservations" });
    assert.deepEqual(calls, ["reserve", "reserve"], "相談と「1つ目で」の2回");
    const rows = pendingApprovals(w.book, NOW.toISOString());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reservation.customerId, "c05");
    assert.equal(rows[0].reservation.status, "hold", "仮押さえまで");
    assert.ok(w.book.chat.every((c) => c.status === "hold"), "確定の予約は作らない");
    assert.ok(w.jobs.done.reserve);
    assert.ok(w.journal.some((j) => j.who === "AI" && j.text.startsWith("仮押さえした：大橋様")));
    assert.ok(w.journal.some((j) => j.text === "AI の仕事：予約の相談 → 済み（承認待ち1件）"));
  });

  test("新しい明細：AI なしで自動のルールで仕分け、迷う物は経理タブへ", async () => {
    const { w, env, calls } = setup();
    const r = await runJob("card", env, budget());
    const c = cardSorted(getAccounting(), EMPTY_ACCOUNTING);
    assert.equal(c.auto + c.manual, getAccounting().trial.items.length);
    assert.deepEqual(r, { kind: "done", result: `自動 ${c.auto}件・迷う物 ${c.manual}件`, tab: "accounting" });
    assert.deepEqual(calls, [], "AI は呼ばない");
    assert.equal(w.jobs.done.card?.tab, "accounting");
  });

  test("広告の見直し：門を通った案を承認の箱へ。今週の案がもうある時は動かさない", async () => {
    const { w, env, calls } = setup();
    const r = await runJob("ads", env, budget());
    assert.deepEqual(r, { kind: "done", result: "承認待ち1件", tab: "ads" });
    assert.equal(calls.length, 1);
    const p = pendingAd(w.ads);
    assert.ok(p, "承認の箱に1行");
    assert.notEqual(p!.no, 9, "決まった返事の1回目（町の名前の9番）は門で弾かれ、作り直した案");

    // 今週の案がもうある（別のブラウザの状態のつもり）
    const again = setup({ ads: w.ads });
    const r2 = await runJob("ads", again.env, budget());
    assert.deepEqual(r2, { kind: "skip", note: ALREADY_THIS_WEEK });
    assert.deepEqual(again.calls, [], "AI は呼ばない");
    assert.equal(again.w.jobs.done.ads, undefined, "済みにしない");
  });

  test("広告の見直し：AI のチームの会議は開かない（会議の窓口は呼ばず、会議の印も声も日誌に出さない）", async () => {
    const { w, env, calls } = setup();
    await runJob("ads", env, budget());
    assert.deepEqual(calls, ["ads"]);
    assert.equal(pendingAd(w.ads)?.team, undefined);
    for (const j of w.journal) assert.doesNotMatch(j.text, /会議|リサーチャー|分身|野党|補佐/, j.text);
  });

  test("メモ：今の ToDo の足し方（メモ:番号）で ToDo へ", async () => {
    const { w, env, calls } = setup();
    const r = await runJob("memo", env, budget());
    assert.deepEqual(r, { kind: "done", result: "ToDo に1件", tab: "todo" });
    assert.deepEqual(calls, ["todo"]);
    const t = w.book.todos.find((x) => x.source === "memo");
    assert.ok(t);
    assert.equal(t!.key, "メモ:1");
    assert.match(t!.memo ?? "", /タオル/);
  });
});

describe("AI の仕事：まとめて動かす・2回は動かない", () => {
  test("上から1つずつ順に動く（予約 → 明細 → 広告 → メモ → 予約サイト）", async () => {
    const { w, env, calls } = setup();
    const seen: string[] = [];
    const out = await runJobs(JOB_IDS, env, budget(), (id, phase) => seen.push(`${id}:${phase === "running" ? "running" : phase.kind}`));
    assert.deepEqual(seen, ["reserve:running", "reserve:done", "card:running", "card:done", "ads:running", "ads:done", "memo:running", "memo:done", "site:running", "site:done"]);
    assert.deepEqual(calls, ["reserve", "reserve", "ads", "todo"]);
    assert.deepEqual(Object.keys(out), [...JOB_IDS]);
    assert.deepEqual(Object.keys(w.jobs.done).sort(), [...JOB_IDS].sort());
    // 日誌にも1行ずつ流れる（上から順）
    const results = w.journal.filter((j) => j.text.startsWith("AI の仕事：")).map((j) => j.text.replace(/ → .*/, ""));
    assert.deepEqual(results, ["AI の仕事：予約の相談", "AI の仕事：新しい明細", "AI の仕事：広告の見直し", "AI の仕事：メモ", "AI の仕事：予約サイトから予約が入る"]);
  });

  test("済んだ行は2回は動かない（1行でも、まとめてでも）", async () => {
    const { w, env, calls } = setup();
    await runJobs(JOB_IDS, env, budget());
    const before = { approvals: w.book.approvals.length, todos: w.book.todos.length, ads: w.ads.proposals.length };
    calls.length = 0;
    for (const id of JOB_IDS) assert.deepEqual(await runJob(id, env, budget()), { kind: "skip", note: "もう済んでいます" });
    const again = await runJobs(JOB_IDS, env, budget());
    assert.deepEqual(again, {});
    assert.deepEqual(calls, [], "AI は呼ばない");
    assert.deepEqual({ approvals: w.book.approvals.length, todos: w.book.todos.length, ads: w.ads.proposals.length }, before);
  });

  test("1回押した時に AI を呼ぶ回数は config の上限まで。足りない行は動かさず、済みにしない", async () => {
    const limit = (aiJson as { jobs: { maxAiCallsPerPress: number } }).jobs.maxAiCallsPerPress;
    assert.equal(getJobsSettings().maxAiCallsPerPress, limit);
    assert.ok(Object.values(AI_CALLS).reduce((a, b) => a + b, 0) <= limit, "まとめて動かす1回で4行とも動ける");
    const { w, env, calls } = setup();
    const out = await runJobs(JOB_IDS, env, { left: AI_CALLS.reserve });
    assert.equal(out.reserve?.kind, "done");
    assert.equal(out.card?.kind, "done", "AI を使わない行は動く");
    assert.equal(out.ads?.kind, "limit");
    assert.equal(out.memo?.kind, "limit");
    assert.deepEqual(calls, ["reserve", "reserve"]);
    assert.equal(out.site?.kind, "done", "AI を使わない行は動く");
    assert.deepEqual(Object.keys(w.jobs.done).sort(), ["card", "reserve", "site"]);
  });

  test("AI につながらない時：済みにせず、その後の AI の行は呼ばない。決まった返事で同じ流れが動く", async () => {
    const { w, env, calls } = setup({ down: true });
    env.mode = "ai";
    const out = await runJobs(JOB_IDS, env, budget());
    assert.equal(out.reserve?.kind, "no-ai");
    assert.equal(out.card?.kind, "done");
    assert.equal(out.ads?.kind, "no-ai");
    assert.equal(out.memo?.kind, "no-ai");
    assert.equal(out.site?.kind, "done", "AI を使わない行は動く");
    assert.deepEqual(calls, ["reserve"], "つながらないと分かった後は呼ばない");
    assert.deepEqual(Object.keys(w.jobs.done), ["card", "site"]);
    // 決まった返事（AI なし）に切りかえて、残りを動かす
    const ok = setup();
    ok.w.jobs = w.jobs;
    const rest = await runJobs(JOB_IDS, ok.env, budget());
    assert.deepEqual(Object.keys(rest), ["reserve", "ads", "memo"]);
    assert.ok(Object.values(rest).every((r) => r?.kind === "done"));
  });
});

describe("AI の仕事：最初に戻す", () => {
  const store = new Map<string, string>();
  const g = globalThis as { window?: unknown };
  let had: unknown;
  before(() => {
    had = g.window;
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
  after(() => {
    g.window = had;
  });

  test("ブラウザの中で動かした後、「最初に戻す」で4行とも「これから」に戻り、また動かせる", async () => {
    const { browserJobStore } = await import("../browserStore");
    const { env } = setup();
    env.store = browserJobStore();
    writeBrowser(BOOK_KEY, JSON.stringify(emptyBook(TODAY)));
    await runJobs(JOB_IDS, env, budget());
    assert.deepEqual(Object.keys(parseJobs(readBrowser(JOBS_KEY)).done).sort(), [...JOB_IDS].sort());
    assert.equal(pendingApprovals(parseBook(readBrowser(BOOK_KEY))!, NOW.toISOString()).length, 1);

    writeBrowser(JOBS_SWITCH_KEY, "off");
    resetAll(TODAY);
    assert.equal(readBrowser(JOBS_KEY), null, "済みの印が消える");
    assert.equal(readBrowser(JOBS_SWITCH_KEY), "off", "表示スイッチは残す");
    assert.deepEqual(parseJobs(readBrowser(JOBS_KEY)), EMPTY_JOBS);
    assert.equal(pendingApprovals(parseBook(readBrowser(BOOK_KEY))!, NOW.toISOString()).length, 0, "仮押さえも消える");
    assert.equal(parseAds(readBrowser("ads")).proposals.length, 0);
    assert.deepEqual(parseAccounting(null), EMPTY_ACCOUNTING);

    const again = await runJobs(JOB_IDS, env, budget());
    assert.ok(JOB_IDS.every((id: JobId) => again[id]?.kind === "done"), "もう一度動かせる");
  });

  test("形のおかしい印は読まない", () => {
    assert.deepEqual(parseJobs("{"), EMPTY_JOBS);
    assert.deepEqual(parseJobs(JSON.stringify({ v: 1, done: { reserve: { at: "x", result: "r", tab: "rules" }, nope: {} } })), EMPTY_JOBS);
  });
});
