// 直しA 4：AI の窓口が混んでいる時（HTTP 429。Vercel の Firewall で1分10回まで）と、返事に理由の文が無い時。
// fetch はテストの中だけの物に置きかえる（窓口も Claude も呼ばない）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { askAdsReview } from "../../ads/client";
import { EMPTY_ADS } from "../../ads/state";
import { EMPTY_ACCOUNTING } from "../../accounting/state";
import { getBookData } from "../../book/data";
import { emptyBook } from "../../book/state";
import { shopToday } from "../../calendar";
import { browserJobAsk } from "../../jobs/ask";
import { runJob, runJobs, type JobEnv } from "../../jobs/run";
import { EMPTY_JOBS } from "../../jobs/state";
import { askKarte } from "../../karte/client";
import { askPostDraft } from "../../posts/client";
import { askRuleWords } from "../../rules/client";
import { getRules } from "../../rules/store";
import { getAdSettings, getShop } from "../../settings";
import { askTodoTitle } from "../../todo/client";
import { AI_BUSY_MESSAGE, AI_FAILED_MESSAGE, failText, isBusyStatus, reasonOf } from "../busy";
import { NO_AI_MESSAGE } from "../wire";

// ── テストの中だけの fetch ─────────────────────────────────
type Reply = { status: number; body: string };
let reply: Reply = { status: 200, body: "{}" };
const called: string[] = [];
const g = globalThis as { fetch: typeof fetch };
let realFetch: typeof fetch;
before(() => {
  realFetch = g.fetch;
  g.fetch = (async (input: RequestInfo | URL) => {
    called.push(String(input));
    return new Response(reply.body, { status: reply.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});
after(() => {
  g.fetch = realFetch;
});

// Vercel の Firewall が返す形のつもり（ok も message も無い JSON）
const FIREWALL_429: Reply = { status: 429, body: JSON.stringify({ error: { code: "rate_limited", message: "Too Many Requests" } }) };
const NO_MESSAGE: Reply = { status: 400, body: JSON.stringify({ ok: false, code: "bad-request" }) };
const SHAPELESS: Reply = { status: 403, body: JSON.stringify({ error: "forbidden" }) };

const clients = {
  "カルテ（/api/ai/karte）": () => askKarte({ mode: "script", memo: "根元が伸びていた", rules: [] }),
  "発信（/api/ai/posts）": () => askPostDraft({ mode: "script", kind: "line", materials: {}, memos: [], rules: [] } as unknown as Parameters<typeof askPostDraft>[0]),
  "広告・広告の「直す」の一言（/api/ai/ads）": () => askAdsReview({ mode: "script", table: { keywords: [], searchTerms: [] }, rules: [] } as unknown as Parameters<typeof askAdsReview>[0]),
  "ルールを言葉で足す（/api/ai/rules）": () => askRuleWords({ mode: "ai", text: "カラーの後は15分あける" }),
  "メモを投げる・AI の仕事のメモ（/api/ai/todo）": () => askTodoTitle({ mode: "script", memo: "カラー剤が少ない", rules: [] }),
};

describe("直しA 4：AI の窓口が混んでいる（429）時・理由の文が無い時", () => {
  test("混んでいる時の1文と、理由が無い時の1文（「undefined」を出さない）", () => {
    assert.equal(AI_BUSY_MESSAGE, "いま AI の窓口が混んでいます。1分ほど待ってから、もう一度押してください。");
    assert.ok(isBusyStatus(429) && !isBusyStatus(400) && !isBusyStatus(500));
    assert.equal(reasonOf({ message: "送る物が大きすぎます" }), "送る物が大きすぎます");
    for (const x of [{}, { message: undefined }, { message: "" }, { message: "undefined" }, { message: 3 }, null, "x"]) assert.equal(reasonOf(x), null);
    assert.equal(failText(undefined), AI_FAILED_MESSAGE);
    assert.equal(failText("undefined"), AI_FAILED_MESSAGE);
    assert.equal(failText("形がおかしいです。", "もう一度。"), "うまくいきませんでした。形がおかしいです。もう一度。");
    for (const s of [failText(undefined), failText(""), AI_BUSY_MESSAGE]) assert.doesNotMatch(s, /undefined|null/);
  });

  for (const [name, ask] of Object.entries(clients)) {
    test(`${name}：429 は busy（「今は AI につながりません」とは分ける）`, async () => {
      reply = FIREWALL_429;
      const r = await ask();
      assert.equal(r.ok, false);
      assert.ok(!r.ok && "code" in r && r.code === "busy");
      assert.ok(!r.ok && "message" in r && r.message === AI_BUSY_MESSAGE);
    });
    test(`${name}：message の無い返事・形の違う返事は、理由なし（画面は決まった1文）`, async () => {
      for (const rep of [NO_MESSAGE, SHAPELESS]) {
        reply = rep;
        const r = await ask();
        assert.equal(r.ok, false);
        assert.ok(!r.ok && "message" in r && r.message === "", JSON.stringify(r));
        assert.ok(!r.ok && "message" in r && failText(r.message) === AI_FAILED_MESSAGE);
      }
    });
  }

  test("サーバーがつながらないと返した時・JSON でない時は、今まで通り「今は AI につながりません」", async () => {
    reply = { status: 503, body: JSON.stringify({ ok: false, code: "no-ai", message: NO_AI_MESSAGE }) };
    const a = await askKarte({ mode: "ai", memo: "x", rules: [] });
    assert.ok(!a.ok && a.code === "no-ai");
    reply = { status: 502, body: "<html>Bad Gateway</html>" };
    const b = await askKarte({ mode: "ai", memo: "x", rules: [] });
    assert.ok(!b.ok && b.code === "no-ai");
  });

  test("予約チャットの窓口（AI の仕事から）：429 は busy、message の無い 400 は「つながらない」にして undefined を出さない", async () => {
    reply = FIREWALL_429;
    const ev = await browserJobAsk.reserve({} as never);
    assert.deepEqual(ev, [{ t: "error", code: "busy", message: AI_BUSY_MESSAGE }]);
    reply = NO_MESSAGE;
    const ev2 = await browserJobAsk.reserve({} as never);
    assert.equal(ev2.length, 1);
    assert.ok(ev2[0].t === "error" && !String(ev2[0].message).includes("undefined"));
  });

  test("AI の仕事：混んでいたら busy で済みにせず、その後の AI の行も呼ばない（AI を使わない行は動かす）", async () => {
    reply = FIREWALL_429;
    called.length = 0;
    const data = getBookData();
    const now = new Date("2026-11-04T08:30:00+09:00");
    const w = { book: emptyBook(shopToday(getShop(), now).today.date), ads: EMPTY_ADS, jobs: EMPTY_JOBS, journal: [] as string[] };
    const env: JobEnv = {
      data,
      rules: getRules(),
      mode: "script",
      store: {
        book: () => w.book,
        setBook: (f) => void (w.book = f(w.book)),
        ads: () => w.ads,
        setAds: (f) => void (w.ads = f(w.ads)),
        accounting: () => EMPTY_ACCOUNTING,
        jobs: () => w.jobs,
        setJobs: (f) => void (w.jobs = f(w.jobs)),
      },
      ask: browserJobAsk,
      journal: (...l) => l.forEach((x) => w.journal.push(x.text)),
      now: () => now,
      adSettings: getAdSettings(),
    };
    assert.deepEqual(await runJob("memo", env, { left: 10 }), { kind: "busy" });
    assert.ok(!w.jobs.done.memo, "済みにしない");
    assert.ok(w.journal.some((t) => t.includes("AI の窓口が混んでいた")));
    called.length = 0;
    const out = await runJobs(["reserve", "card", "ads", "memo"], env, { left: 10 });
    assert.equal(out.reserve?.kind, "busy");
    assert.equal(out.ads?.kind, "busy");
    assert.equal(out.memo?.kind, "busy");
    assert.equal(out.card?.kind, "done", "AI を使わない行は動かす");
    assert.equal(called.length, 1, "混んでいると分かった後は呼ばない");
  });

  test("AI の窓口を呼ぶ画面は、どれも混んでいる時の1文を出し、理由の文をそのまま埋めない", () => {
    const files = [
      "src/app/karte/KarteMemo.tsx",
      "src/app/posts/PostsForm.tsx",
      "src/app/ads/AdsReview.tsx",
      "src/components/AdApprovalRows.tsx",
      "src/app/rules/RuleWords.tsx",
      "src/components/MemoThrow.tsx",
      "src/app/reservations/ReserveChat.tsx",
      "src/app/home/AiJobs.tsx",
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      assert.match(src, /AI_BUSY_MESSAGE/, `${f} は混んでいる時の1文を出す`);
      assert.doesNotMatch(src, /うまくいきませんでした。\$\{[a-z.]*message\}/, `${f} は理由の文をそのまま埋めない（failText を通す）`);
    }
  });
});
