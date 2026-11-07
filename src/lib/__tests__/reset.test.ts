// ホームの「最初に戻す」1回で、予約・カルテ・広告・経理（自動のルールも）・LINE の預かりが全部最初に戻る。
// ブラウザの置き場所（localStorage）は、テストの中だけの物に置きかえる。

import { HOLIDAYS_KEY } from "../holidays";
import { SITE_STOPS_KEY } from "../book/siteStops";
import { CAPACITY_KEY } from "../capacity";
import { MENUS_KEY } from "../menuEdits";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { register, parseAccounting, EMPTY_ACCOUNTING, withChoice, withAutoNext, sortCurrent, effectiveRules } from "../accounting/state";
import { manualItems } from "../accounting/sort";
import { EMPTY_ADS, parseAds, type AdsState } from "../ads/state";
import { emptyBook, parseBook, withHold, type BookState } from "../book/state";
import { FREEE_KEY, ACCOUNTING_KEY, DAILY_KEY, ADS_KEY, BOOK_KEY, BROWSER_PREFIX, JOBS_KEY, JOURNAL_KEY, LINE_KEY, POSTS_KEY, RULES_KEY, readBrowser, writeBrowser } from "../browser";
import { getAccounting, getCustomers } from "../data/seed";
import { deskKey, getDesk, setDesk } from "../karte/deskStore";
import { clearInbox, handleWebhook, pollScreen, startLink, type BridgeDeps } from "../line/bridge";
import { newLineState, parseLine, withLinked, withHandled } from "../line/state";
import { memoryStore } from "../line/store";
import { getPostsDesk, setPostsDesk } from "../posts/deskStore";
import { EMPTY_POSTS, parsePosts, withSavedPost } from "../posts/state";
import { getLineSettings, getShop } from "../settings";
import { resetAll, resetAllWrites } from "../reset";

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

describe("最初に戻す", () => {
  test("予約・カルテ・広告・経理（足した自動のルールも）が最初に戻る。日誌とルールのタブの変更は残す", () => {
    const seed = getAccounting();
    // 予約・カルテ：前の起点・ToDo・保存したカルテ・翌日へ
    const book: BookState = {
      ...emptyBook("2026-10-01"),
      todos: [{ id: "td-ad-1", title: "3週間後に効いたか見る（3番）", createdAt: "2026-10-01T00:00:00.000Z", done: false }],
      dayOffset: 3,
    };
    writeBrowser(BOOK_KEY, JSON.stringify(book));
    // 広告：止めた言葉
    const ads: AdsState = { v: 1, proposals: [], applied: [{ no: 3, action: "stop", at: "2026-10-01T00:00:00.000Z", proposalId: "p1" }] };
    writeBrowser(ADS_KEY, JSON.stringify(ads));
    // 経理：登録して自動のルールを足した
    let acct = manualItems(sortCurrent(seed)).reduce((s, i) => withChoice(seed, s, i.no, "shop"), EMPTY_ACCOUNTING);
    acct = withAutoNext(seed, acct, "m-f", true);
    const r = register(seed, acct, { nowIso: "2026-11-11T00:00:00.000Z", service: "会計" });
    assert.ok(r.ok);
    if (!r.ok) return;
    writeBrowser(ACCOUNTING_KEY, JSON.stringify(r.state));
    assert.equal(effectiveRules(seed.rules, parseAccounting(readBrowser(ACCOUNTING_KEY))).length, 5);
    writeBrowser(JOURNAL_KEY, "[]");
    writeBrowser(RULES_KEY, "{}");

    resetAll("2026-11-04");

    const reset = parseBook(readBrowser(BOOK_KEY));
    assert.ok(reset?.epoch, "戻すたびに印が変わる（戻す前の予約チャットの返事を入れない）");
    assert.deepEqual(reset, emptyBook("2026-11-04", reset?.epoch));
    assert.equal(readBrowser(ADS_KEY), null);
    assert.deepEqual(parseAds(readBrowser(ADS_KEY)), EMPTY_ADS);
    assert.equal(readBrowser(ACCOUNTING_KEY), null);
    const back = parseAccounting(readBrowser(ACCOUNTING_KEY));
    assert.deepEqual(back, EMPTY_ACCOUNTING);
    assert.deepEqual(effectiveRules(seed.rules, back), seed.rules, "自動のルールは前の月までの4件に戻る");
    assert.ok(store.has(BROWSER_PREFIX + JOURNAL_KEY), "日誌は残す");
    assert.ok(store.has(BROWSER_PREFIX + RULES_KEY), "ルールのタブの変更は残す");
  });

  test("書く物：予約は今日を起点に作り直し、広告と経理と発信の下書き・「AI の仕事」の済みの印・同じ時間に受ける人数・休みの日・予約サイトで止めた時間は消す", () => {
    const w = resetAllWrites("2026-11-04");
    // 経理の freee（テスト事業所）の画面の記録（FREEE_KEY）も戻す。freee の中の記録は残る（§1.8.1）
    assert.deepEqual(
      w.map((x) => x.key).sort(),
      [ACCOUNTING_KEY, DAILY_KEY, ADS_KEY, BOOK_KEY, JOBS_KEY, POSTS_KEY, CAPACITY_KEY, FREEE_KEY, HOLIDAYS_KEY, SITE_STOPS_KEY, MENUS_KEY].sort(),
    );
    assert.equal(w.find((x) => x.key === HOLIDAYS_KEY)!.value, null, "休みの日は最初の状態（無し）に戻る");
    assert.equal(w.find((x) => x.key === SITE_STOPS_KEY)!.value, null, "予約サイトで止めた時間は最初の状態（無し）に戻る");
    assert.equal(w.find((x) => x.key === MENUS_KEY)!.value, null, "直したメニュー（時間・値段・最終受付）は設定の値に戻る");
    assert.equal(w.find((x) => x.key === FREEE_KEY)!.value, null);
    assert.equal(w.find((x) => x.key === CAPACITY_KEY)!.value, null, "同じ時間に受ける人数は設定の数に戻る");
    assert.equal(w.find((x) => x.key === POSTS_KEY)!.value, null);
    assert.equal(w.find((x) => x.key === JOBS_KEY)!.value, null);
    assert.equal(w.find((x) => x.key === ADS_KEY)!.value, null);
    assert.equal(w.find((x) => x.key === ACCOUNTING_KEY)!.value, null);
  });

  test("1回で全部：予約・カルテ（保存した物・メモ・案）・広告・経理・LINE の預かり。LINE のつなぎは残す", () => {
    const seed = getAccounting();
    const c = getCustomers()[0];
    // 予約：仮押さえ（承認の箱）と保存したカルテ・翌日へ
    const book: BookState = {
      ...withHold(emptyBook("2026-10-01"), {
        id: "h-1",
        customerId: c.id,
        menuId: "cut",
        date: "2026-11-05",
        start: "15:00",
        heldAt: "2026-11-04T01:00:00.000Z",
        expiresAt: "2026-11-05T01:00:00.000Z",
        reason: "お客様が選んだ候補",
      }),
      dayOffset: 2,
    };
    assert.equal(book.chat.length, 1);
    writeBrowser(BOOK_KEY, JSON.stringify(book));
    writeBrowser(ADS_KEY, JSON.stringify({ v: 1, proposals: [], applied: [{ no: 3, action: "stop", at: "2026-10-01T00:00:00.000Z", proposalId: "p1" }] }));
    const acct = manualItems(sortCurrent(seed)).reduce((st, i) => withChoice(seed, st, i.no, "shop"), EMPTY_ACCOUNTING);
    writeBrowser(ACCOUNTING_KEY, JSON.stringify(acct));
    // LINE：つないで、承認待ちを届けた印と、受け取った知らせの印がある
    const line = withHandled(withLinked(newLineState("link1.secret1", "123456", "2026-11-04T01:10:00.000Z"), "2026-11-04T13:00:00.000Z", ["ap-h-1"]), "ev-1");
    writeBrowser(LINE_KEY, JSON.stringify(line));
    // カルテ：施術メモ（LINE から入れたメモも）と案（画面を開いている間だけの物）
    setDesk(() => ({
      memos: { [deskKey(c.id, "2026-11-04")]: "LINE から：前髪は短めに" },
      drafts: { [deskKey(c.id, "2026-11-04")]: { sections: {}, removed: [], cut: false, memo: "x" } as never },
      mode: "script",
    }));

    const out = resetAll("2026-11-04");

    const resetBook = parseBook(readBrowser(BOOK_KEY));
    assert.deepEqual(resetBook, emptyBook("2026-11-04", resetBook?.epoch), "仮押さえ・承認の箱・保存したカルテ・翌日へが消える");
    assert.equal(readBrowser(ADS_KEY), null);
    assert.equal(readBrowser(ACCOUNTING_KEY), null);
    const back = parseLine(readBrowser(LINE_KEY));
    assert.ok(back, "LINE のつなぎは残す");
    assert.equal(back!.token, "link1.secret1");
    assert.equal(back!.linked, true);
    assert.deepEqual(back!.notified, [], "届けた承認待ちの印は消す（承認の箱が空に戻るので）");
    assert.deepEqual(back!.handled, ["ev-1"], "受け取って済ませた知らせは2回使わない");
    assert.equal(out.lineToken, "link1.secret1", "サーバーの預かり物を消すのに使う");
    assert.deepEqual(getDesk().memos, {}, "カルテの施術メモ（LINE から入れたメモも）を消す");
    assert.deepEqual(getDesk().drafts, {}, "カルテの案を消す");
    assert.equal(getDesk().mode, "script", "AI か決まった返事かの切りかえは残す");
  });

  test("発信：保存した下書きと、画面の材料・下書きも消える（AI か決まった返事かの切りかえは残す）", () => {
    const saved = withSavedPost(EMPTY_POSTS, { kind: "notice", text: "冬のお知らせです。", mode: "ai" }, { id: "po-1", nowIso: "2026-11-04T01:00:00.000Z", gateWords: [], maxPerKind: 30 });
    assert.ok(saved.ok);
    if (!saved.ok) return;
    writeBrowser(POSTS_KEY, JSON.stringify(saved.state));
    setPostsDesk(() => ({ kind: "notice", materials: { notice: { topic: "冬" } }, mode: "script" }));
    resetAll("2026-11-04");
    assert.equal(readBrowser(POSTS_KEY), null);
    assert.deepEqual(parsePosts(readBrowser(POSTS_KEY)), EMPTY_POSTS);
    assert.equal(getPostsDesk().kind, null);
    assert.deepEqual(getPostsDesk().materials, {});
    assert.equal(getPostsDesk().draft, null);
    assert.equal(getPostsDesk().mode, "script");
  });

  test("カルテを人が直した分：最初の状態のカルテを直した分と、その ToDo の文の書きかえも消え、最初の中身に戻る", () => {
    const book: BookState = {
      ...emptyBook("2026-10-01"),
      seedKarteEdits: { "k-p01": { sections: { next: ["次はパーマ"] }, edited: ["next"], editedAt: { next: "2026-11-04T01:00:00.000Z" } } },
      todoTitles: { "ts-08": "江口様：次はパーマ" },
    };
    writeBrowser(BOOK_KEY, JSON.stringify(book));
    assert.ok(parseBook(readBrowser(BOOK_KEY))!.seedKarteEdits!["k-p01"]);
    resetAll("2026-11-04");
    const after = parseBook(readBrowser(BOOK_KEY))!;
    assert.equal(after.seedKarteEdits, undefined);
    assert.equal(after.todoTitles, undefined);
    assert.deepEqual(after.kartes, []);
  });

  test("LINE とつないでいなければ、LINE には何も書かない", () => {
    writeBrowser(LINE_KEY, null);
    const out = resetAll("2026-11-04");
    assert.equal(out.lineToken, null);
    assert.equal(readBrowser(LINE_KEY), null);
  });

  test("サーバーの LINE の預かり：まだ画面が受け取っていない一言を消す。つなぎは残る", async () => {
    let clock = Date.parse("2026-11-04T09:00:00+09:00");
    let seq = 0;
    const d: BridgeDeps = {
      store: memoryStore(() => clock),
      line: null,
      settings: getLineSettings(),
      timezone: getShop().timezone,
      now: () => new Date(clock),
      random: (n) => {
        seq += 1;
        const b = Buffer.alloc(n);
        for (let i = 0; i < n; i++) b[i] = (seq * 13 + i * 5) & 0xff;
        return b;
      },
    };
    const ev = (text: string) => ({ type: "message", webhookEventId: `we-${++seq}`, source: { type: "user", userId: "U-owner" }, message: { type: "text", text } });
    const s = await startLink(d);
    assert.ok(s.ok);
    if (!s.ok) return;
    await handleWebhook(d, { events: [ev(s.code)] });
    assert.ok((await pollScreen(d, s.token)).ok);
    // 画面が受け取りに来る前に、一言が預けられた
    await handleWebhook(d, { events: [ev("明日の15時に青木さんカット")] });
    assert.equal(await clearInbox(d, s.token), true);
    const p = await pollScreen(d, s.token);
    assert.ok(p.ok);
    if (!p.ok) return;
    assert.equal(p.linked, true, "つなぎは残る");
    assert.deepEqual(p.events, [], "預かっていた一言は消えた");
    // 消した後に来た一言は、いつもどおり届く
    await handleWebhook(d, { events: [ev("ToDo：シャンプーの発注")] });
    const p2 = await pollScreen(d, s.token);
    assert.ok(p2.ok && p2.events.length === 1);
    // 違う印では何もしない
    assert.equal(await clearInbox(d, "nope.nope"), false);
    clock += 1;
  });
});
