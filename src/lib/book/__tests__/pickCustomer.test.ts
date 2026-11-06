// 「予約を入れる」の1枚のお客様を選ぶ所（book/pickCustomer.ts）のテスト。お客様を95人にして確かめる（テストの中だけ。seed は変えない）。
// - 「95人中 8人を表示」・前回来た日が新しい順・「前回 10/24（土） カット」（記録が無ければ何も足さない）
// - 同じ名字で前回も同じ方は番号を出す・残りは「もっと表示」・名字とよみで探し、カタカナでもひらがなのよみで見つかる

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Customer } from "../../data/types";
import type { KarteRecord } from "../../karte/record";
import { CUSTOMER_PAGE, lastLabel, matchCustomer, pickCountLabel, pickCustomers } from "../pickCustomer";

const ROOT = join(__dirname, "../../../..");
const cust = (id: string, surname: string, kana: string, firstVisit = false): Customer => ({ id, surname, kana, fictional: true, firstVisit });
// 佐藤 様が9人（よみ さとう）・ほかに86人
const sato = Array.from({ length: 9 }, (_, i) => cust(`s${i + 1}`, "佐藤", "さとう"));
const others = Array.from({ length: 86 }, (_, i) => cust(`o${i + 1}`, `名字${i + 1}`, `みょうじ${i + 1}`, i === 0));
const customers = [...others, ...sato];
const karte = (customerId: string, date: string, menuId = "cut"): KarteRecord => ({ id: `k-${customerId}-${date}`, customerId, date, menuId, sections: {}, source: "saved" });
const kartes: KarteRecord[] = [
  karte("s1", "2026-10-24"),
  karte("s1", "2026-09-01", "color"),
  karte("s2", "2026-10-30", "perm"),
  karte("s3", "2026-10-24"),
  karte("o5", "2026-11-01"),
];

describe("お客様を選ぶ所", () => {
  test("95人中 8人を表示（何人いるかが分かる）。残りは「もっと表示」", () => {
    const p = pickCustomers(customers, kartes, "");
    assert.equal(p.total, 95);
    assert.equal(p.shown.length, CUSTOMER_PAGE);
    assert.equal(pickCountLabel(p, ""), "95人中 8人を表示");
    assert.equal(p.more, true);
    assert.equal(pickCustomers(customers, kartes, "", 95).more, false);
  });

  test("前回来た日が新しい順（記録の無い方は後ろ）。いちばん新しいカルテが前回", () => {
    const p = pickCustomers(customers, kartes, "");
    assert.deepEqual(p.shown.slice(0, 4).map((x) => x.customer.id), ["o5", "s2", "s1", "s3"]);
    assert.deepEqual(p.shown[2].last, { date: "2026-10-24", menuId: "cut" });
    assert.equal(p.shown[4].last, null);
  });

  test("「前回 10/24（土） カット」。記録が無ければ何も足さない", () => {
    assert.equal(lastLabel({ date: "2026-10-24", menuId: "cut" }, () => "10/24（土）", () => "カット"), "前回 10/24（土） カット");
    assert.equal(lastLabel(null, () => "", () => ""), null);
  });

  test("佐藤で探すと9人：同じ名字で前回も同じ方（記録なし同士・10/24 カット同士）は番号を出し、違う方は出さない", () => {
    const p = pickCustomers(customers, kartes, "佐藤");
    assert.equal(p.matched, 9);
    assert.equal(p.shown.length, 8);
    assert.equal(p.more, true);
    assert.equal(pickCountLabel(p, "佐藤"), "「佐藤」に合う 9人中 8人を表示（全員で 95人）");
    const byId = Object.fromEntries(p.shown.map((x) => [x.customer.id, x.showId]));
    assert.equal(byId.s2, false, "前回が違う");
    assert.equal(byId.s1, true, "s3 と同じ前回");
    assert.equal(byId.s3, true);
    assert.equal(byId.s4, true, "記録なし同士");
    // もっと表示で9人目
    assert.equal(pickCustomers(customers, kartes, "佐藤", 16).shown.length, 9);
  });

  test("名字とよみで探す。カタカナ（全角・半角）でもひらがなのよみで見つかる", () => {
    for (const q of ["佐藤", "さとう", "サトウ", "ｻﾄｳ", "さと"]) assert.equal(pickCustomers(customers, kartes, q).matched, 9, q);
    assert.equal(matchCustomer(cust("x", "青木", "あおき"), "アオ"), true);
    assert.equal(matchCustomer(cust("x", "青木", "あおき"), "いし"), false);
  });

  test("「初めての方」は firstVisit で決める（画面の札）", () => {
    const sheet = readFileSync(join(ROOT, "src/app/reservations/OwnerBookSheet.tsx"), "utf8");
    assert.match(sheet, /\{c\.firstVisit && <span className="tag first">初めての方<\/span>\}/);
    assert.match(sheet, /pickCustomers\(data\.customers, book\.kartes, query, limit\)/);
    assert.match(sheet, /もっと表示/);
  });
});
