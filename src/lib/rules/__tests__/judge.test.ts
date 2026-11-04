// 型ごとのテスト：通る例と断る例を1つずつ以上。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MENUS, resultOf, rule, run } from "./helpers";

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

describe("同じ日に不可：相手のメニューつき（組み合わせに効く。noSameDay の with）", () => {
  const r = rule({ kind: "noSameDay", with: "m90" }, { level: "menu", menuId: "m60" });
  const seats = { seats: 3 };
  test("通る：60分のメニューだけ", () => {
    const v = run([r], { menuIds: ["m60"] }, seats);
    assert.equal(resultOf(v, r)?.ok, true);
    assert.equal(v.ok, true);
  });
  test("通る：ほかの方が同じ日に90分のメニュー", () => {
    const v = run([r], { menuIds: ["m60"], customerId: "a" }, { ...seats, existing: [{ date: "2026-11-05", start: "10:00", menuIds: ["m90"], newCustomer: false, customerId: "b" }] });
    assert.equal(v.ok, true);
  });
  test("断る：1回の来店で60分と90分のメニュー", () => {
    const v = run([r], { menuIds: ["m60", "m90"] }, seats);
    assert.equal(resultOf(v, r)?.ok, false);
    assert.equal(v.ok, false);
  });
  test("断る：同じ方がその日に90分のメニューを入れている（どちらに付けたルールでも効く）", () => {
    const existing = [{ date: "2026-11-05", start: "10:00", menuIds: ["m60"], newCustomer: false, customerId: "a" }];
    const v = run([r], { menuIds: ["m90"], start: "15:00", customerId: "a" }, { ...seats, existing });
    assert.equal(resultOf(v, r)?.ok, false);
    assert.match(resultOf(v, r)!.reason, /同じ日に/);
  });
  test("同じ組み合わせのルールは1つにまとめる（どちらのメニューに付けても同じ）", () => {
    const r2 = rule({ kind: "noSameDay", with: "m60" }, { level: "menu", menuId: "m90" });
    const v = run([r, r2], { menuIds: ["m60", "m90"] }, seats);
    assert.equal(v.results.filter((x) => !x.ok).length, 1);
  });
  test("相手のちがう組み合わせのルールは、ぜんぶ使う", () => {
    const menus = [...MENUS, { id: "m30", name: "30分のメニュー", minutes: 30 }];
    const r3 = rule({ kind: "noSameDay", with: "m30" }, { level: "menu", menuId: "m60" });
    const v = run([r, r3], { menuIds: ["m60", "m90", "m30"] }, { ...seats, menus });
    assert.equal(v.results.filter((x) => !x.ok).length, 2);
  });
  test("相手のメニューの無い「同じ日に不可」（当日の予約は受けない）はそのまま：相手つきと別に効く", () => {
    const today = rule({ kind: "noSameDay" }, { level: "menu", menuId: "m60" });
    const v = run([r, today], { date: "2026-11-04", start: "15:00", menuIds: ["m60"] }, seats);
    assert.equal(resultOf(v, today)?.ok, false, "当日の予約は断る");
    assert.equal(resultOf(v, r)?.ok, true, "組み合わせではないので相手つきは通る");
  });
  test("当日不可のメニューごとのルールは、そのメニューを含む組み合わせのメニューにも効く", () => {
    const menus = [...MENUS, { id: "combo", name: "組み合わせ", minutes: 150, includes: ["m60", "m90"] }];
    const today = rule({ kind: "noSameDay" }, { level: "menu", menuId: "m90" });
    const v = run([today], { date: "2026-11-04", start: "15:00", menuIds: ["combo"] }, { ...seats, menus });
    assert.equal(resultOf(v, today)?.ok, false);
  });
});

describe("同じ日に不可（相手のメニューつき）を足すときの確かめ（validate.ts）", () => {
  test("メニューに付ければ受け付ける・全体やタブには付けられない・同じメニューどうしは受け付けない", async () => {
    const { validateOwnerRule } = await import("../validate");
    const base = { id: "own-x", label: "縮毛矯正とパーマは同じ日に受けない" };
    const ok = validateOwnerRule({ ...base, level: "menu", menuId: "straight", check: { kind: "noSameDay", with: "perm" } }, ["straight", "perm"]);
    assert.ok(ok.ok && ok.value.check.kind === "noSameDay" && ok.value.check.with === "perm");
    assert.equal(validateOwnerRule({ ...base, level: "global", check: { kind: "noSameDay", with: "perm" } }, ["straight", "perm"]).ok, false);
    assert.equal(validateOwnerRule({ ...base, level: "menu", menuId: "perm", check: { kind: "noSameDay", with: "perm" } }, ["straight", "perm"]).ok, false);
    const plain = validateOwnerRule({ ...base, level: "global", check: { kind: "noSameDay" } }, ["straight", "perm"]);
    assert.ok(plain.ok && plain.value.check.kind === "noSameDay" && !("with" in plain.value.check));
  });
});
