// 直しI：まだ何も触っていないブラウザは、開いた時に起点を今日にそろえる（PC とスマホで最初の中身を同じにする）。
// 何か入れた後のブラウザの起点は動かさない。ほかの置き場所（休みの日・日報・メニュー・止めた時間・人数・日誌）は触らない。
// ブラウザの置き場所（localStorage）は、テストの中だけの物に置きかえる。

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { HoldOffer } from "../../ai/wire";
import { BOOK_KEY, BROWSER_PREFIX, DAILY_KEY, JOURNAL_KEY, readBrowser, writeBrowser } from "../../browser";
import { shopToday } from "../../calendar";
import { CAPACITY_KEY } from "../../capacity";
import { getCustomers } from "../../data/seed";
import { HOLIDAYS_KEY } from "../../holidays";
import { MENUS_KEY } from "../../menuEdits";
import { getMenus, getShop } from "../../settings";
import { assembleBook } from "../assemble";
import { SITE_STOPS_KEY } from "../siteStops";
import { emptyBook, isUntouched, parseBook, withHold, withNextDay, type BookState } from "../state";
import { alignAnchor, readBook } from "../store";

const store = new Map<string, string>();
let refuse = false;
const g = globalThis as { window?: unknown };
let had: unknown;

before(() => {
  had = g.window;
  g.window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (refuse) throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    },
    addEventListener() {},
    removeEventListener() {},
  };
});
after(() => {
  g.window = had;
});
beforeEach(() => {
  store.clear();
  refuse = false;
});

const YESTERDAY = "2026-11-06";
const TODAY = "2026-11-07";
const put = (s: BookState) => writeBrowser(BOOK_KEY, JSON.stringify(s));
const hold: HoldOffer = {
  id: "h1",
  customerId: "c04",
  menuId: "cut",
  date: "2026-11-08",
  start: "15:00",
  heldAt: "2026-11-06T01:00:00.000Z",
  expiresAt: "2026-11-09T01:00:00.000Z",
  reason: "お客様が候補から選びました",
};

describe("起点をそろえる（最初の状態のままのブラウザ）", () => {
  test("まだ一度も開いていない：今日を起点に覚える", () => {
    assert.deepEqual(alignAnchor(TODAY), { ok: true });
    assert.equal(readBook("2000-01-01").anchor, TODAY);
  });

  test("最初の状態のまま・昨日の起点：今日に書き直す", () => {
    put(emptyBook(YESTERDAY));
    assert.deepEqual(alignAnchor(TODAY), { ok: true });
    assert.equal(readBook(TODAY).anchor, TODAY);
  });

  test("書き直した後は、今日初めて開いたブラウザと同じ台帳になる", () => {
    const shop = getShop();
    const now = new Date(`${TODAY}T03:00:00.000Z`);
    const { today } = shopToday(shop, now);
    const src = { shop, menus: getMenus(), customers: getCustomers() };
    put(emptyBook("2026-10-20"));
    alignAnchor(today.date);
    const aligned = assembleBook(src, readBook(today.date), today, now.toISOString()).booked;
    const fresh = assembleBook(src, emptyBook(today.date), today, now.toISOString()).booked;
    assert.ok(fresh.length > 0, "最初の予約がある");
    assert.deepEqual(aligned, fresh);
  });

  test("起点がもう今日なら書かない", () => {
    put(emptyBook(TODAY));
    assert.equal(alignAnchor(TODAY), null);
  });

  test("epoch（「最初に戻す」の印）は変えない", () => {
    put(emptyBook(YESTERDAY, "r-abc-123456"));
    alignAnchor(TODAY);
    const s = readBook(TODAY);
    assert.equal(s.anchor, TODAY);
    assert.equal(s.epoch, "r-abc-123456");
  });

  test("書けなかった時：エラーにせず、今の起点のまま開く", () => {
    put(emptyBook(YESTERDAY));
    refuse = true;
    let out: ReturnType<typeof alignAnchor> = null;
    assert.doesNotThrow(() => {
      out = alignAnchor(TODAY);
    });
    assert.deepEqual(out, { ok: false, why: "full" });
    assert.equal(readBook(TODAY).anchor, YESTERDAY);
  });

  test("休みの日・予約サイトの止めた時間・日報・メニュー・人数・日誌は消えない", () => {
    const others: [string, string][] = [
      [HOLIDAYS_KEY, JSON.stringify(["2026-11-12"])],
      [SITE_STOPS_KEY, JSON.stringify(["2026-11-08 15:00"])],
      [DAILY_KEY, JSON.stringify({ v: 1, days: { "2026-11-06": { sales: 12000, visits: 2 } } })],
      [MENUS_KEY, JSON.stringify({ cut: { minutes: 60 } })],
      [CAPACITY_KEY, "2"],
      [JOURNAL_KEY, JSON.stringify([{ at: "2026-11-06T01:00:00.000Z", text: "ルールを足した" }])],
    ];
    for (const [k, v] of others) writeBrowser(k, v);
    put(emptyBook(YESTERDAY));
    alignAnchor(TODAY);
    assert.equal(readBook(TODAY).anchor, TODAY);
    for (const [k, v] of others) assert.equal(readBrowser(k), v, `${k} はそのまま`);
    assert.equal(store.size, others.length + 1, "台帳のほかに書いた物は無い");
    assert.ok([...store.keys()].every((k) => k.startsWith(BROWSER_PREFIX)));
  });
});

describe("起点を動かさない（何か入れた後のブラウザ）", () => {
  const base = emptyBook(YESTERDAY);
  const touched: [string, BookState][] = [
    ["予約チャットの仮押さえ（承認BOXも）", withHold(base, hold)],
    ["予約サイト・台帳から入れた予約", { ...base, chat: [{ id: "site-1", customerId: "c04", menuId: "cut", date: "2026-11-08", start: "15:00", status: "confirmed", heldAt: hold.heldAt, expiresAt: hold.expiresAt, via: "site" }], siteSeq: 1 }],
    ["承認BOXの行だけ", { ...base, approvals: [{ id: "ap-x", reservationId: "x", createdAt: hold.heldAt, reason: "理由", state: "skipped" }] }],
    ["足した ToDo", { ...base, todos: [{ id: "td-1", title: "仕入れ", createdAt: hold.heldAt, done: false }] }],
    ["保存したカルテ", { ...base, kartes: [{ id: "k1", customerId: "c04", date: YESTERDAY, menuId: "cut", memo: "メモ", sections: {}, savedAt: hold.heldAt }] }],
    ["最初の ToDo の済みの印", { ...base, todoMarks: { "ts-01": { done: true, at: hold.heldAt } } }],
    ["最初のカルテの直し", { ...base, seedKarteEdits: { sk1: { sections: { memo: ["直した"] }, edited: ["memo"], editedAt: { memo: hold.heldAt } } } }],
    ["最初の ToDo の文の直し", { ...base, todoTitles: { "ts-01": "直した題" } }],
    ["最初の予約の直し（直しE）", { ...base, seedResEdits: { "r-01": { cancelled: true, at: hold.heldAt } } }],
    ["予約サイトの番号だけ", { ...base, siteSeq: 3 }],
    ["「翌日へ」", withNextDay(base)],
  ];
  for (const [name, s] of touched)
    test(`${name} があれば、起点は昨日のまま`, () => {
      assert.equal(isUntouched(s), false);
      put(s);
      const before = readBrowser(BOOK_KEY);
      assert.equal(alignAnchor(TODAY), null);
      assert.equal(readBrowser(BOOK_KEY), before, "何も書きかえない");
      assert.equal(parseBook(readBrowser(BOOK_KEY))?.anchor, YESTERDAY);
    });

  test("形がおかしくて読むときに落ちる物が残っていても、触ったと見て動かさない（消さない）", () => {
    writeBrowser(BOOK_KEY, JSON.stringify({ ...base, chat: [{ id: "broken" }] }));
    const before = readBrowser(BOOK_KEY);
    assert.equal(parseBook(before)?.chat.length, 0, "読むときは落ちる");
    assert.equal(alignAnchor(TODAY), null);
    assert.equal(readBrowser(BOOK_KEY), before);
  });

  test("最初の状態のままの形は isUntouched が true（todoMarks が空の箱でも）", () => {
    assert.equal(isUntouched(emptyBook(YESTERDAY)), true);
    assert.equal(isUntouched(emptyBook(YESTERDAY, "r-1")), true);
  });
});
