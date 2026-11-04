// ホームの「最初に戻す」1回で、予約・カルテ・広告・経理（自動のルールも）が全部最初に戻る。
// ブラウザの置き場所（localStorage）は、テストの中だけの物に置きかえる。

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { register, parseAccounting, EMPTY_ACCOUNTING, withChoice, withAutoNext, sortCurrent, effectiveRules } from "../accounting/state";
import { manualItems } from "../accounting/sort";
import { EMPTY_ADS, parseAds, type AdsState } from "../ads/state";
import { emptyBook, parseBook, type BookState } from "../book/state";
import { ACCOUNTING_KEY, ADS_KEY, BOOK_KEY, BROWSER_PREFIX, JOURNAL_KEY, RULES_KEY, readBrowser, writeBrowser } from "../browser";
import { getAccounting } from "../data/seed";
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
    const r = register(seed, acct, { nowIso: "2026-11-11T00:00:00.000Z", service: "会計（架空）" });
    assert.ok(r.ok);
    if (!r.ok) return;
    writeBrowser(ACCOUNTING_KEY, JSON.stringify(r.state));
    assert.equal(effectiveRules(seed.rules, parseAccounting(readBrowser(ACCOUNTING_KEY))).length, 5);
    writeBrowser(JOURNAL_KEY, "[]");
    writeBrowser(RULES_KEY, "{}");

    resetAll("2026-11-04");

    assert.deepEqual(parseBook(readBrowser(BOOK_KEY)), emptyBook("2026-11-04"));
    assert.equal(readBrowser(ADS_KEY), null);
    assert.deepEqual(parseAds(readBrowser(ADS_KEY)), EMPTY_ADS);
    assert.equal(readBrowser(ACCOUNTING_KEY), null);
    const back = parseAccounting(readBrowser(ACCOUNTING_KEY));
    assert.deepEqual(back, EMPTY_ACCOUNTING);
    assert.deepEqual(effectiveRules(seed.rules, back), seed.rules, "自動のルールは前の月までの4件に戻る");
    assert.ok(store.has(BROWSER_PREFIX + JOURNAL_KEY), "日誌は残す");
    assert.ok(store.has(BROWSER_PREFIX + RULES_KEY), "ルールのタブの変更は残す");
  });

  test("書く物：予約は今日を起点に作り直し、広告と経理は消す", () => {
    const w = resetAllWrites("2026-11-04");
    assert.deepEqual(w.map((x) => x.key).sort(), [ACCOUNTING_KEY, ADS_KEY, BOOK_KEY].sort());
    assert.equal(w.find((x) => x.key === ADS_KEY)!.value, null);
    assert.equal(w.find((x) => x.key === ACCOUNTING_KEY)!.value, null);
  });
});
