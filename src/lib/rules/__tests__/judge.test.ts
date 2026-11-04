// 型ごとのテスト：通る例と断る例を1つずつ以上。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resultOf, rule, run } from "./helpers";

describe("何分前まで（minLeadMinutes）", () => {
  const r = rule({ kind: "minLeadMinutes", value: 180 });
  test("通る：来店まで3時間ある", () => {
    const v = run([r], { date: "2026-11-04", start: "13:00" });
    assert.equal(resultOf(v, r)?.ok, true);
    assert.equal(v.ok, true);
  });
  test("断る：来店まで2時間しかない", () => {
    const v = run([r], { date: "2026-11-04", start: "12:00" });
    assert.equal(resultOf(v, r)?.ok, false);
    assert.equal(v.ok, false);
  });
});

describe("1日の上限（maxNewCustomersPerDay）", () => {
  const r = rule({ kind: "maxNewCustomersPerDay", value: 2 });
  const two = [
    { date: "2026-11-05", start: "10:00", menuIds: ["m60"], newCustomer: true },
    { date: "2026-11-05", start: "15:00", menuIds: ["m60"], newCustomer: true },
  ];
  test("通る：その日の初めての方が1人なら、2人目を受ける", () => {
    const v = run([r], { newCustomer: true }, { existing: two.slice(0, 1) });
    assert.equal(resultOf(v, r)?.ok, true);
    assert.equal(v.ok, true);
  });
  test("通る：初めての方でなければ数に入らない", () => {
    const v = run([r], { newCustomer: false }, { existing: two });
    assert.equal(resultOf(v, r)?.ok, true);
  });
  test("通る：ほかの日の初めての方は数えない", () => {
    const other = two.map((b) => ({ ...b, date: "2026-11-06" }));
    const v = run([r], { newCustomer: true }, { existing: other });
    assert.equal(resultOf(v, r)?.ok, true);
  });
  test("断る：もう2人いる日に、3人目", () => {
    const v = run([r], { newCustomer: true }, { existing: two });
    assert.equal(resultOf(v, r)?.ok, false);
    assert.equal(v.ok, false);
  });
});

describe("間を空ける（bufferAfterMinutes）", () => {
  const r = rule({ kind: "bufferAfterMinutes", value: 15 }, { level: "menu", menuId: "m90" });
  // 10:00–11:30 の90分のメニューが入っている（席は1つ）
  const before = [{ date: "2026-11-05", start: "10:00", menuIds: ["m90"], newCustomer: false }];
  test("通る：前の予約の後15分あけて 11:45 から", () => {
    const v = run([r], { start: "11:45" }, { existing: before });
    assert.equal(v.ok, true);
    assert.equal(resultOf(v, r), undefined, "60分のメニューには効かないので、通るときは出さない");
  });
  test("断る：前の予約のすぐ後 11:30 から（前の予約の側のルールが効く）", () => {
    const v = run([r], { start: "11:30" }, { existing: before });
    assert.equal(resultOf(v, r)?.ok, false);
    assert.equal(v.base.find((b) => b.id === "seats")?.ok, true, "間が無ければ席はある");
    assert.equal(v.ok, false);
  });
  test("断る：自分の後の15分が、次の予約にかかる", () => {
    const after = [{ date: "2026-11-05", start: "15:00", menuIds: ["m60"], newCustomer: false }];
    const v = run([r], { start: "13:30", menuIds: ["m90"] }, { existing: after });
    assert.equal(resultOf(v, r)?.ok, false);
  });
  test("通る：自分の後の15分を入れても次の予約にかからない", () => {
    const after = [{ date: "2026-11-05", start: "15:15", menuIds: ["m60"], newCustomer: false }];
    const v = run([r], { start: "13:30", menuIds: ["m90"] }, { existing: after });
    assert.equal(resultOf(v, r)?.ok, true);
  });
});

describe("同じ日に不可（noSameDay）", () => {
  const r = rule({ kind: "noSameDay" });
  test("通る：前の日に予約する", () => {
    const v = run([r], { date: "2026-11-05" });
    assert.equal(resultOf(v, r)?.ok, true);
  });
  test("断る：来店と同じ日に予約する", () => {
    const v = run([r], { date: "2026-11-04", start: "17:00" });
    assert.equal(resultOf(v, r)?.ok, false);
    assert.equal(v.ok, false);
  });
});

describe("最終受付（lastStart）", () => {
  const r = rule({ kind: "lastStart", time: "18:00" });
  test("通る：18:00 ちょうどに始まる", () => {
    const v = run([r], { start: "18:00" });
    assert.equal(resultOf(v, r)?.ok, true);
  });
  test("断る：18:30 に始まる", () => {
    const v = run([r], { start: "18:30" });
    assert.equal(resultOf(v, r)?.ok, false);
    assert.equal(v.ok, false);
  });
});

describe("文のルール（text）", () => {
  test("プログラムは判定せず、Claude への指示に回す", () => {
    const r = rule({ kind: "text" });
    const v = run([r]);
    assert.equal(resultOf(v, r), undefined);
    assert.deepEqual(v.texts.map((t) => t.id), [r.id]);
    assert.equal(v.ok, true);
  });
});

describe("店の設定で確かめる所", () => {
  test("お休みの日は断る", () => {
    const v = run([], {}, { hours: null });
    assert.equal(v.ok, false);
  });
  test("閉店までに終わらないと断る", () => {
    const v = run([], { start: "19:30" });
    assert.equal(v.base.find((b) => b.id === "hours")?.ok, false);
  });
  test("メニューの最終受付（設定）を過ぎると断る", () => {
    const v = run([], { start: "17:30" }, { menus: [{ id: "m60", name: "60分", minutes: 60, lastStart: "17:00" }] });
    assert.equal(v.base.find((b) => b.id === "menu-last")?.ok, false);
  });
  test("席がふさがっていると断る", () => {
    const v = run([], { start: "13:00" }, { existing: [{ date: "2026-11-05", start: "12:30", menuIds: ["m60"], newCustomer: false }] });
    assert.equal(v.base.find((b) => b.id === "seats")?.ok, false);
  });
  test("過ぎた時刻は断る", () => {
    const v = run([], { date: "2026-11-04", start: "09:00" });
    assert.equal(v.ok, false);
  });
});
