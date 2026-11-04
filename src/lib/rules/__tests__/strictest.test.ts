// ぶつかったら厳しい方。段の上下では決めない。判定（judge）もこれを通る。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatMinutes } from "../describe";
import { effective, strictest } from "../strictest";
import { PROGRAM_KINDS, STRICTER } from "../types";
import { resultOf, rule, run } from "./helpers";

describe("厳しい方を使う", () => {
  test("どの種類にも、厳しさの向きが決まっている", () => {
    for (const k of PROGRAM_KINDS) assert.ok(STRICTER[k], k);
  });

  test("何分前まで：全体3時間 と メニュー1日 → メニューの予約では1日", () => {
    const g = rule({ kind: "minLeadMinutes", value: 180 });
    const m = rule({ kind: "minLeadMinutes", value: 1440 }, { level: "menu", menuId: "m90" });
    assert.equal(effective([g, m], { tab: "reservations", menuIds: ["m90"] }, "minLeadMinutes")?.id, m.id);
    assert.equal(effective([g, m], { tab: "reservations", menuIds: ["m60"] }, "minLeadMinutes")?.id, g.id);
  });

  test("段が下でも、緩い方は使わない：全体1日 と メニュー3時間 → 1日", () => {
    const g = rule({ kind: "minLeadMinutes", value: 1440 });
    const m = rule({ kind: "minLeadMinutes", value: 180 }, { level: "menu", menuId: "m90" });
    const v = run([g, m], { menuIds: ["m90"], date: "2026-11-04", start: "18:00" });
    assert.equal(resultOf(v, g)?.ok, false);
    assert.equal(resultOf(v, m), undefined);
  });

  test("1日の上限：小さい方", () => {
    const a = rule({ kind: "maxNewCustomersPerDay", value: 4 });
    const b = rule({ kind: "maxNewCustomersPerDay", value: 2 }, { level: "tab", tab: "reservations" });
    assert.deepEqual(strictest([a, b]).map((r) => r.id), [b.id]);
  });

  test("最終受付：早い方", () => {
    const a = rule({ kind: "lastStart", time: "19:00" });
    const b = rule({ kind: "lastStart", time: "16:00" }, { level: "menu", menuId: "m90" });
    assert.deepEqual(strictest([a, b]).map((r) => r.id), [b.id]);
  });

  test("間を空ける：大きい方", () => {
    const a = rule({ kind: "bufferAfterMinutes", value: 30 });
    const b = rule({ kind: "bufferAfterMinutes", value: 15 }, { level: "menu", menuId: "m90" });
    assert.deepEqual(strictest([a, b]).map((r) => r.id), [a.id]);
  });

  test("同じ日に不可：2つあっても1つにまとまる", () => {
    const a = rule({ kind: "noSameDay" });
    const b = rule({ kind: "noSameDay" }, { level: "menu", menuId: "m90" });
    assert.equal(strictest([a, b]).length, 1);
  });

  test("文のルールはぜんぶ残す", () => {
    const a = rule({ kind: "text" });
    const b = rule({ kind: "text" }, { level: "tab", tab: "posts" });
    assert.equal(strictest([a, b]).length, 2);
  });

  test("ほかのタブのルールは予約の判定に入らない", () => {
    const r = rule({ kind: "minLeadMinutes", value: 9999 }, { level: "tab", tab: "posts" });
    assert.equal(run([r]).results.length, 0);
  });
});

describe("時間の書き方", () => {
  test("1日ちょうどは「24時間」、2日からは「N日」", () => {
    assert.equal(formatMinutes(1440), "24時間");
    assert.equal(formatMinutes(2880), "2日");
    assert.equal(formatMinutes(180), "3時間");
    assert.equal(formatMinutes(90), "1時間30分");
  });
});
