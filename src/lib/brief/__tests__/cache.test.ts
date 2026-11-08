// 直しA 10：ホームの「今日の注意」（朝の要点の AI の一言）は、同じ材料の答えをブラウザに残し、開き直しても AI を呼ばない。
// ブラウザの置き場所（localStorage）はテストの中だけの物。AI の窓口は呼ばず、数を数える ask に置きかえる。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, test } from "node:test";
import { BRIEF_KEY, BROWSER_PREFIX, readBrowser, writeBrowser } from "../../browser";
import { getBriefLimits } from "../../settings";
import { briefAnswer, briefCacheKey, briefKnown, parseBriefCache } from "../cache";
import { briefKey } from "../items";
import type { BriefItem, BriefResult } from "../wire";

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
beforeEach(() => store.clear());

const item = (mark: string, text: string) => ({ mark, text }) as unknown as BriefItem;
const keyA = briefKey([item("【予約1】", "10:00 カット〔お客様〕前回は根元を気にしていた"), item("【ToDo1】", "カラー剤の7番を発注")], []);
const keyB = briefKey([item("【予約1】", "10:00 カット〔お客様〕前回は根元を気にしていた"), item("【ToDo1】", "シャンプーを発注")], []);
const answer = (n: string): BriefResult => ({ mode: "ai", notes: [`【予約1】の方は${n}`], dropped: [] });

/** 開くたびに新しい「画面の覚え」（開き直すと消える物）。AI を呼んだ回数を数える */
function opener(reply: (n: number) => BriefResult | null = (n) => answer(`前回の話を${n}`)) {
  let calls = 0;
  const max = getBriefLimits().maxCachedAnswers;
  const open = (key: string) =>
    briefAnswer(key, {
      memory: new Map(),
      ask: async () => reply(++calls),
      max,
      now: () => new Date("2026-11-04T00:00:00.000Z"),
    });
  return { open, calls: () => calls };
}

describe("直しA 10：朝の要点の AI の一言は、同じ材料なら開き直しても AI を呼ばない", () => {
  test("ホームを1日に何回開き直しても、材料が同じなら AI を呼ぶのは1回だけ（2回目からは残した答え・日誌も書かない）", async () => {
    const o = opener();
    const first = await o.open(keyA);
    assert.equal(first.fresh, true);
    for (let i = 0; i < 9; i++) {
      const again = await o.open(keyA);
      assert.equal(again.fresh, false);
      assert.deepEqual(again.value, first.value);
    }
    assert.equal(o.calls(), 1);
  });

  test("材料が変わった時だけ呼ぶ（戻った材料は残した答えを使う）", async () => {
    const o = opener();
    await o.open(keyA);
    const b = await o.open(keyB);
    assert.equal(b.fresh, true);
    assert.equal(o.calls(), 2);
    await o.open(keyA);
    await o.open(keyB);
    assert.equal(o.calls(), 2);
    // オーナーのルールが変わったら、それも材料
    await o.open(briefKey([item("【ToDo1】", "シャンプーを発注")], [{ id: "r1" }]));
    assert.equal(o.calls(), 3);
  });

  test("つながらない・混んでいた（答え無し）は残さない：開き直したら、また頼める。同じ画面の中では呼び直さない", async () => {
    let n = 0;
    const memory = new Map<string, BriefResult | null>();
    const ask = async () => (++n === 1 ? null : answer("x"));
    assert.deepEqual(await briefAnswer(keyA, { memory, ask, max: 5 }), { value: null, fresh: false });
    await briefAnswer(keyA, { memory, ask, max: 5 });
    assert.equal(n, 1, "同じ画面では呼び直さない");
    assert.equal(readBrowser(BRIEF_KEY), null, "答え無しはブラウザに残さない");
    const reopened = await briefAnswer(keyA, { memory: new Map(), ask, max: 5 });
    assert.equal(n, 2);
    assert.equal(reopened.fresh, true);
  });

  test("残すのは材料の印（ハッシュ）と答えだけ。材料の文は残さない。数は上限まで（古い物から消す）", async () => {
    const keys = [1, 2, 3, 4].map((i) => briefKey([item("【ToDo1】", `メモ${i}`)], []));
    for (const k of keys) await briefAnswer(k, { memory: new Map(), ask: async () => answer(k), max: 3 });
    const raw = store.get(BROWSER_PREFIX + BRIEF_KEY)!;
    assert.ok(!raw.includes("メモ1") && !raw.includes("〔お客様〕"), "材料の文は残さない");
    const c = parseBriefCache(raw);
    assert.equal(c.entries.length, 3);
    assert.deepEqual(c.entries.map((e) => e.key), [keys[3], keys[2], keys[1]].map(briefCacheKey), "新しい順・いちばん古い物を消す");
    assert.equal(briefKnown(new Map(), keys[0]), false);
    assert.equal(briefKnown(new Map(), keys[3]), true);
    assert.notEqual(briefCacheKey(keyA), briefCacheKey(keyB));
  });

  test("形のおかしい物は読まない（その時は AI に頼む）", async () => {
    writeBrowser(BRIEF_KEY, "{こわれた");
    assert.deepEqual(parseBriefCache(readBrowser(BRIEF_KEY)).entries, []);
    writeBrowser(BRIEF_KEY, JSON.stringify({ v: 1, entries: [{ key: briefCacheKey(keyA), at: "x", value: { mode: "ai", notes: "文字" } }] }));
    const o = opener();
    await o.open(keyA);
    assert.equal(o.calls(), 1);
  });

  test("上限の数は config/ai.json（brief.maxCachedAnswers）。画面は briefAnswer を通し、窓口を直に呼ばない", () => {
    assert.ok(getBriefLimits().maxCachedAnswers >= 1);
    const src = readFileSync("src/app/home/BriefNotes.tsx", "utf8");
    // 画面は、覚え（cache）と上限の数を、呼ぶ間合いの部品（brief/pace.ts。直しY）に渡す。部品が briefAnswer を通す
    assert.match(src, /memory: cache,\n\s+max: limits\.maxCachedAnswers,/);
    assert.match(readFileSync("src/lib/brief/pace.ts", "utf8"), /briefAnswer\(key, \{ memory: deps\.memory, ask, max: deps\.max \}\)/);
    assert.doesNotMatch(src, /fetch\(/);
    assert.match(src, /if \(value && fresh\)/, "日誌は AI が答えた時だけ");
  });
});
