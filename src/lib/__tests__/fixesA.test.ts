// 直しA：混んだ時・失敗した時・日付の境目で、画面の文が壊れる・成功していないのに成功と出る・日付が食い違う所の直し。
// ブラウザの置き場所（localStorage）は、テストの中だけの物に置きかえる（台帳だけ「いっぱい」「断られた」にできる）。

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { BOOK_KEY, BROWSER_PREFIX, JOURNAL_KEY, readBrowser, SAVE_FAILED_MESSAGE, writeBrowser } from "../browser";
import { emptyBook, parseBook } from "../book/state";
import { readBook, updateBook } from "../book/store";
import { calDay } from "../calendar";
import { getTodos } from "../data/seed";
import { parseJournal, writeJournal } from "../journal";
import type { SavedKarte } from "../karte/record";
import { commitKarteSave } from "../karte/save";
import { getKarteHeadings, getShop } from "../settings";
import { resolveSeedTodos } from "../todo/items";
import { commitMemoTodo } from "../todo/throw";

const shop = getShop();
const headings = getKarteHeadings();
const today = "2026-11-04"; // 水曜

// ── テストの中だけのブラウザ ───────────────────────────────
const store = new Map<string, string>();
/** 台帳（book）を書く時だけの失敗：full = いっぱい / denied = 断られた / null = 普通に書ける */
let bookFails: "full" | "denied" | null = null;
const g = globalThis as { window?: unknown };
let had: unknown;
before(() => {
  had = g.window;
  g.window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (k === BROWSER_PREFIX + BOOK_KEY && bookFails === "full") {
          const e = new Error("The quota has been exceeded.");
          e.name = "QuotaExceededError";
          throw e;
        }
        if (k === BROWSER_PREFIX + BOOK_KEY && bookFails === "denied") {
          const e = new Error("The operation is insecure.");
          e.name = "SecurityError";
          throw e;
        }
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
  bookFails = null;
  writeBrowser(BOOK_KEY, JSON.stringify(emptyBook(today)));
});

const journal = () => parseJournal(readBrowser(JOURNAL_KEY));

describe("直しA 1：保存できなかった時は「保存しました」「足しました」と出さない", () => {
  test("writeBrowser は書けたかを返す（いっぱい・断られた・普通）。例外は外へ投げない", () => {
    assert.deepEqual(writeBrowser("x", "1"), { ok: true });
    bookFails = "full";
    assert.deepEqual(writeBrowser(BOOK_KEY, "{}"), { ok: false, why: "full" });
    bookFails = "denied";
    assert.deepEqual(writeBrowser(BOOK_KEY, "{}"), { ok: false, why: "denied" });
    // 失敗した時は前の中身のまま
    assert.equal(parseBook(readBrowser(BOOK_KEY))?.anchor, today);
    assert.deepEqual(updateBook((s) => ({ ...s, dayOffset: 3 }), today), { ok: false, why: "denied" });
    assert.equal(readBook(today).dayOffset, 0);
  });

  const karte = (n: number): SavedKarte => ({
    id: `k-${today}-c01-${n}`,
    customerId: "c01",
    date: today,
    menuId: "cut",
    memo: "根元が伸びていた",
    sections: { next: ["次は2か月後にカット"], treatment: ["カット"] },
    savedAt: `${today}T08:00:0${n}.000Z`,
  });

  /** 画面と同じつなぎ方：書く・日誌・案を消す */
  const saveKarte = (n: number, draft: { has: boolean }) =>
    commitKarteSave(
      { update: (f) => updateBook(f, today), journal: writeJournal, dropDraft: () => (draft.has = false) },
      { karte: karte(n), surname: "青木", headings, dayLabel: "11/4（水）", menuName: "カット", editedNames: [] },
    );

  for (const why of ["full", "denied"] as const) {
    test(`カルテの保存：${why === "full" ? "置き場所がいっぱい" : "書き込みを断られた"}の時は、案を残し、成功の文と日誌を出さない。その後もう一度押すと保存でき、日誌は1回だけ`, () => {
      const draft = { has: true };
      bookFails = why;
      const r = saveKarte(1, draft);
      assert.equal(r.ok, false);
      assert.equal(r.message, SAVE_FAILED_MESSAGE);
      assert.ok(!r.message.includes("保存しました"));
      assert.equal(draft.has, true, "案は残す");
      assert.equal(readBook(today).kartes.length, 0);
      assert.equal(journal().length, 0, "日誌は書かない");

      bookFails = null;
      const again = saveKarte(2, draft);
      assert.equal(again.ok, true);
      assert.ok(again.message.startsWith("✓ 保存しました"));
      assert.equal(draft.has, false, "書けたら案を消す");
      assert.equal(readBook(today).kartes.length, 1);
      assert.equal(readBook(today).todos.filter((t) => t.kind === "next-talk").length, 1);
      assert.equal(journal().filter((e) => e.text.startsWith("人が保存：")).length, 1, "成功の日誌は1回だけ");
    });
  }

  test("カルテの保存：普通に書ける時は1回で保存・日誌1行・案を消す", () => {
    const draft = { has: true };
    const r = saveKarte(1, draft);
    assert.equal(r.ok, true);
    assert.equal(draft.has, false);
    assert.equal(journal().filter((e) => e.text.startsWith("人が保存：")).length, 1);
    // 同じ日の2回目は決まりで保存しない（書けなかった、とは言わない）
    const second = saveKarte(2, { has: true });
    assert.equal(second.ok, false);
    assert.ok(!second.ok && second.written === true && second.message !== SAVE_FAILED_MESSAGE);
  });

  const seedItems = resolveSeedTodos(shop, calDay(shop, today), getTodos());
  const throwMemo = () =>
    commitMemoTodo(
      { update: (f) => updateBook(f, today), journal: writeJournal },
      { title: "カラー剤の7番を発注", memo: "カラー剤の7番が少ない", due: null, category: "supply", via: "program", how: "script", seedItems, shop, nowIso: `${today}T01:00:00.000Z` },
    );

  for (const why of ["full", "denied"] as const) {
    test(`メモを投げる：${why === "full" ? "置き場所がいっぱい" : "書き込みを断られた"}の時は「足しました」と日誌を出さない。もう一度で足せて、日誌は1回だけ`, () => {
      bookFails = why;
      const r = throwMemo();
      assert.deepEqual(r, { ok: false, why: "write", message: SAVE_FAILED_MESSAGE });
      assert.equal(readBook(today).todos.length, 0);
      assert.equal(journal().length, 0);
      bookFails = null;
      const again = throwMemo();
      assert.equal(again.ok, true);
      assert.ok(again.message.startsWith("✓ 足しました"));
      assert.equal(readBook(today).todos.length, 1);
      assert.equal(journal().filter((e) => e.text.startsWith("メモを ToDo に足した")).length, 1);
    });
  }

  test("メモを投げる：普通に書ける時は1回で足し、日誌1行", () => {
    const r = throwMemo();
    assert.equal(r.ok, true);
    assert.equal(readBook(today).todos.length, 1);
    assert.equal(journal().filter((e) => e.text.startsWith("メモを ToDo に足した")).length, 1);
  });
});
