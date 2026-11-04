// 経理：売上（見るだけ）と、通販の明細の仕分け（自動のルール → 人が選ぶ → プログラムの門 → 人が登録）。
// AI は使わない。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { calDay } from "../../calendar";
import { getAccounting } from "../../data/seed";
import type { CardUse } from "../../data/types";
import { getAccountingSettings, getShop } from "../../settings";
import { summarizeSales } from "../sales";
import { manualItems } from "../sort";
import {
  EMPTY_ACCOUNTING,
  effectiveRules,
  gateOf,
  parseAccounting,
  register,
  sortCurrent,
  sortTrial,
  withAutoNext,
  withChoice,
  type AccountingState,
} from "../state";

const seed = getAccounting();
const shop = getShop();
const service = getAccountingSettings().service;
const id = (name: string) => seed.merchants.find((m) => m.name === name)!.id;
const MALL = id("通販モールE");
const TOWEL = id("タオルの通販F");
const nowIso = "2026-11-11T01:00:00.000Z";

/** 人が選ぶ行に印を付ける（pick で購入先ごとに変えられる） */
function chooseAll(s: AccountingState, pick: (merchantId: string, no: number) => CardUse = () => "shop"): AccountingState {
  return manualItems(sortCurrent(seed)).reduce((x, i) => withChoice(seed, x, i.no, pick(i.merchantId, i.no)), s);
}

describe("最初の状態（seed/accounting.json）", () => {
  test("通販の明細は番号つきの23件（10/13〜11/10）。購入先は10か所、自動のルールは4件", () => {
    const items = seed.statement.items;
    assert.equal(items.length, 23);
    assert.deepEqual(items.map((i) => i.no), Array.from({ length: 23 }, (_, k) => k + 1));
    assert.equal(seed.statement.from, "2026-10-13");
    assert.equal(seed.statement.to, "2026-11-10");
    for (const i of items) {
      assert.ok(i.date >= seed.statement.from && i.date <= seed.statement.to, `${i.no}番の日付`);
      assert.ok(seed.merchants.some((m) => m.id === i.merchantId), `${i.no}番の購入先`);
      assert.deepEqual(Object.keys(i).sort(), ["amount", "date", "merchantId", "no"], "品名は持たない");
    }
    assert.equal(seed.merchants.length, 10);
    assert.equal(new Set(items.map((i) => i.merchantId)).size, 10);
    assert.equal(seed.rules.length, 4);
    assert.deepEqual(seed.rules.find((r) => r.merchantId === id("美容材料の通販A")), { merchantId: id("美容材料の通販A"), use: "shop" });
  });

  test("通販モールは前の月までに店用と私用の両方があり、自動のルールは無い", () => {
    const h = seed.history.find((x) => x.merchantId === MALL)!;
    assert.ok(h.shop > 0 && h.private > 0);
    assert.ok(!seed.rules.some((r) => r.merchantId === MALL));
  });

  test("売上は10月分。定休日（火曜）には売上を置かない", () => {
    assert.equal(seed.sales.month, "2026-10");
    assert.equal(seed.sales.methods.length, 3);
    for (const d of seed.sales.days) {
      assert.ok(d.date.startsWith("2026-10-"));
      assert.ok(calDay(shop, d.date).open, `${d.date} は営業日`);
    }
  });
});

describe("売上（見るだけ）", () => {
  const s = summarizeSales(seed.sales, shop);
  test("大きい数字3つは日ごとの数の合計から出す", () => {
    const total = seed.sales.days.reduce((a, d) => a + Object.values(d.pay).reduce((x, y) => x + y, 0), 0);
    const visits = seed.sales.days.reduce((a, d) => a + d.visits, 0);
    assert.equal(s.total, total);
    assert.equal(s.visits, visits);
    assert.equal(s.perVisit, Math.round(total / visits));
  });
  test("日ごとの棒は1日〜31日。火曜は定休日（点）で売上0", () => {
    assert.equal(s.days.length, 31);
    const closed = s.days.filter((d) => !d.open);
    assert.deepEqual(closed.map((d) => d.day), [6, 13, 20, 27]);
    assert.ok(closed.every((d) => d.sales === 0 && d.visits === 0 && d.label.includes("火")));
  });
  test("支払い方法の割合は3本で、合計は売上と同じ", () => {
    assert.equal(s.methods.length, 3);
    assert.equal(s.methods.reduce((a, m) => a + m.amount, 0), s.total);
    assert.ok(Math.abs(s.methods.reduce((a, m) => a + m.pct, 0) - 100) <= 1);
  });
});

describe("自動のルールで仕分ける（AI は使わない）", () => {
  const sorted = sortCurrent(seed);
  test("自動のルールで15件が仕分けられる", () => {
    assert.equal(sorted.auto.length, 15);
    for (const a of sorted.auto) assert.equal(a.use, seed.rules.find((r) => r.merchantId === a.item.merchantId)!.use);
  });
  test("人が選ぶ8件が残る：初めての購入先5件・前にも仕分けた購入先（通販モール）3件", () => {
    assert.equal(manualItems(sorted).length, 8);
    assert.equal(sorted.fresh.length, 5);
    assert.equal(new Set(sorted.fresh.map((i) => i.merchantId)).size, 5);
    assert.ok(sorted.fresh.every((i) => !seed.history.some((h) => h.merchantId === i.merchantId)));
    assert.equal(sorted.known.length, 3);
    assert.ok(sorted.known.every((i) => i.merchantId === MALL));
  });
  test("自動の行には人の印を付けられない", () => {
    const autoNo = sorted.auto[0].item.no;
    assert.deepEqual(withChoice(seed, EMPTY_ACCOUNTING, autoNo, "private").choices, {});
    assert.deepEqual(withAutoNext(seed, EMPTY_ACCOUNTING, sorted.auto[0].item.merchantId, true).autoNext, []);
  });
});

describe("プログラムの門と登録", () => {
  test("選び終わるまでは登録できない（あと N件）", () => {
    let s = EMPTY_ACCOUNTING;
    assert.equal(gateOf(seed, s).remaining, 8);
    assert.equal(gateOf(seed, s).ok, false);
    s = withChoice(seed, s, manualItems(sortCurrent(seed))[0].no, "shop");
    assert.equal(gateOf(seed, s).remaining, 7);
    assert.equal(register(seed, s, { nowIso, service }).ok, false);
    s = chooseAll(s);
    const g = gateOf(seed, s);
    assert.equal(g.remaining, 0);
    assert.deepEqual(g.checks.map((c) => c.ok), [true, true]);
    assert.equal(g.ok, true);
  });

  test("通販モールで印が店用と私用に分かれているのに「次から自動」なら止めて理由を出す", () => {
    const mallNos = sortCurrent(seed).known.map((i) => i.no);
    let s = chooseAll(EMPTY_ACCOUNTING, (m, no) => (m === MALL && no === mallNos[0] ? "private" : "shop"));
    assert.equal(gateOf(seed, s).ok, true, "「次から自動」が無ければ分かれていてもよい");
    s = withAutoNext(seed, s, MALL, true);
    const g = gateOf(seed, s);
    assert.equal(g.ok, false);
    assert.equal(g.checks.find((c) => c.id === "autoAligned")!.ok, false);
    assert.equal(g.checks.find((c) => c.id === "allChosen")!.ok, true);
    assert.equal(g.problems.length, 1);
    assert.equal(g.problems[0].merchantId, MALL);
    assert.match(g.problems[0].text, /通販モールE.*店用と私用に分かれて/);
    const r = register(seed, s, { nowIso, service });
    assert.equal(r.ok, false);
    // そろえれば通る
    s = withChoice(seed, s, mallNos[0], "shop");
    assert.equal(gateOf(seed, s).ok, true);
  });

  test("登録：会計（架空）に登録済み・件数・足したルールの文、日誌に「人が登録」とルールの1行", () => {
    let s = chooseAll(EMPTY_ACCOUNTING, (m) => (m === TOWEL ? "shop" : "private"));
    s = withAutoNext(seed, s, TOWEL, true);
    const r = register(seed, s, { nowIso, service });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.state.registered!.total, 23);
    assert.equal(r.state.registered!.auto, 15);
    assert.equal(r.state.registered!.manual, 8);
    assert.equal(r.state.registered!.shopAmount + r.state.registered!.privateAmount, seed.statement.items.reduce((a, i) => a + i.amount, 0));
    assert.equal(r.message, "自動 15件・人が選んだ 8件。自動のルールに「タオルの通販F＝店用」を足しました");
    assert.equal(r.journal.length, 2);
    assert.match(r.journal[0].text, /^人が登録：会計（架空）に通販の明細 23件（自動 15件・人が選んだ 8件）/);
    assert.equal(r.journal[0].who, "オーナー");
    assert.match(r.journal[1].text, /自動のルールに足した：タオルの通販F＝店用/);
    assert.deepEqual(effectiveRules(seed.rules, r.state).length, 5);
    // 登録の後は印を変えない・2回目は登録しない
    assert.equal(withChoice(seed, r.state, sortCurrent(seed).fresh[0].no, "private"), r.state);
    assert.equal(register(seed, r.state, { nowIso, service }).ok, false);
  });

  test("「次から自動」が無ければルールは足さず、日誌は「人が登録」の1行だけ", () => {
    const r = register(seed, chooseAll(EMPTY_ACCOUNTING), { nowIso, service });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.message, "自動 15件・人が選んだ 8件。自動のルールは足していません");
    assert.equal(r.journal.length, 1);
    assert.deepEqual(r.state.addedRules, []);
  });

  test("登録で足したルールが「次の明細（試し）」で自動で効く", () => {
    const before = sortTrial(seed, EMPTY_ACCOUNTING);
    const towelTrial = seed.trial.items.find((i) => i.merchantId === TOWEL)!;
    assert.ok(towelTrial, "試しの明細にタオルの通販Fがある");
    assert.ok(!before.auto.some((a) => a.item.no === towelTrial.no), "足す前は人が選ぶ");

    let s = chooseAll(EMPTY_ACCOUNTING);
    s = withAutoNext(seed, s, TOWEL, true);
    s = withAutoNext(seed, s, MALL, true); // 通販モールも全部店用でそろえたので足せる
    const r = register(seed, s, { nowIso, service });
    assert.ok(r.ok);
    if (!r.ok) return;
    const after = sortTrial(seed, r.state);
    const towel = after.auto.find((a) => a.item.no === towelTrial.no);
    assert.equal(towel?.use, "shop");
    assert.ok(after.byAdded.includes(towelTrial.no));
    const mallTrial = seed.trial.items.find((i) => i.merchantId === MALL)!;
    assert.ok(after.byAdded.includes(mallTrial.no));
    // 前の月までのルールはそのまま効く
    const beauty = seed.trial.items.find((i) => i.merchantId === id("美容材料の通販A"))!;
    assert.equal(after.auto.find((a) => a.item.no === beauty.no)?.use, "shop");
    assert.ok(!after.byAdded.includes(beauty.no));
    // ルールの無い購入先は、登録の後は「前にも仕分けた購入先」
    assert.ok(after.fresh.length === 0);
    assert.ok(after.known.length > 0);
  });
});

describe("ブラウザに残す形", () => {
  test("読みなおしても同じ。形のおかしい物は落とす", () => {
    let s = chooseAll(EMPTY_ACCOUNTING);
    s = withAutoNext(seed, s, TOWEL, true);
    const r = register(seed, s, { nowIso, service });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(parseAccounting(JSON.stringify(r.state)), r.state);
    assert.deepEqual(parseAccounting("こわれた"), EMPTY_ACCOUNTING);
    assert.deepEqual(parseAccounting(null), EMPTY_ACCOUNTING);
    const bad = parseAccounting(JSON.stringify({ choices: { "1": "shop", x: "shop", "2": "どちらでも" }, autoNext: [1, "m-f"], addedRules: [{ merchantId: "m-f", use: "?" }] }));
    assert.deepEqual(bad.choices, { "1": "shop" });
    assert.deepEqual(bad.autoNext, ["m-f"]);
    assert.deepEqual(bad.addedRules, []);
  });
});
