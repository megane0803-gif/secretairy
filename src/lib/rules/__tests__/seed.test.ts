// 架空の店（omochi）の例のルールに、1本ずつテストを付ける。
// 例のルールを足したら、ここにもテストを足す（足し忘れると「どの例にもテストがある」が落ちる）。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getMenus, getShop } from "../../settings";
import { judge, type Booked, type Booking } from "../judge";
import { instructionsFor } from "../prompt";
import { getRules, getSeedRules } from "../store";

const rules = getRules();
const shop = getShop();
const menus = getMenus();
const id = (rid: string) => {
  const r = rules.find((x) => x.id === rid);
  assert.ok(r, `例のルール ${rid} が見つかりません`);
  return r;
};
const at = (b: Partial<Booking>, existing: Booked[] = [], now = { date: "2026-11-04", time: "10:00" }) =>
  judge({
    rules,
    booking: { date: "2026-11-05", start: "13:00", menuIds: ["cut"], newCustomer: false, ...b },
    now,
    hours: { open: "10:00", close: "20:00" },
    seats: shop.seats,
    menus,
    existing,
  });
const resultFor = (v: ReturnType<typeof at>, rid: string) => v.results.find((r) => r.rule.id === rid);

const TESTED = new Set<string>();
function seedTest(rid: string, name: string, fn: () => void) {
  TESTED.add(rid);
  test(`${rid}：${name}`, () => {
    id(rid);
    fn();
  });
}

describe("例のルール", () => {
  seedTest("seed-lead-time", "来店の3時間前まで", () => {
    const now = { date: "2026-11-04", time: "10:00" };
    assert.equal(resultFor(at({ date: "2026-11-04", start: "13:00" }, [], now), "seed-lead-time")?.ok, true);
    assert.equal(resultFor(at({ date: "2026-11-04", start: "12:30" }, [], now), "seed-lead-time")?.ok, false);
  });

  seedTest("seed-new-per-day", "初めてのお客様は1日4人まで", () => {
    const newOnes = (n: number): Booked[] =>
      Array.from({ length: n }, (_, i) => ({ date: "2026-11-05", start: `1${i}:00`, menuIds: ["headspa"], newCustomer: true }));
    // 4人目は受ける・5人目は断る（席がふさがらない時刻で）
    assert.equal(resultFor(at({ start: "18:30", newCustomer: true }, newOnes(3)), "seed-new-per-day")?.ok, true);
    assert.equal(resultFor(at({ start: "18:30", newCustomer: true }, newOnes(4)), "seed-new-per-day")?.ok, false);
  });

  seedTest("seed-color-buffer", "カラーの後は15分あける", () => {
    // 席の数だけカラーが 10:00–11:30 に入っている
    const colors: Booked[] = Array.from({ length: shop.seats }, () => ({
      date: "2026-11-05",
      start: "10:00",
      menuIds: ["color"],
      newCustomer: false,
    }));
    assert.equal(at({ start: "11:45" }, colors).ok, true);
    const v = at({ start: "11:30" }, colors);
    assert.equal(resultFor(v, "seed-color-buffer")?.ok, false);
    assert.equal(v.ok, false);
  });

  seedTest("seed-straight-lead", "縮毛矯正は前の日まで（全体の3時間より厳しい方を使う）", () => {
    const now = { date: "2026-11-04", time: "11:00" };
    const v = at({ menuIds: ["straight"], date: "2026-11-05", start: "10:00" }, [], now);
    assert.equal(resultFor(v, "seed-straight-lead")?.ok, false);
    assert.equal(resultFor(v, "seed-lead-time"), undefined, "厳しい方の1つだけを使う");
    const ok = at({ menuIds: ["straight"], date: "2026-11-05", start: "11:00" }, [], { date: "2026-11-04", time: "10:00" });
    assert.equal(resultFor(ok, "seed-straight-lead")?.ok, true);
    // カットには効かない（全体の3時間だけ）
    const cut = at({ menuIds: ["cut"], date: "2026-11-05", start: "10:00" }, [], now);
    assert.equal(resultFor(cut, "seed-lead-time")?.ok, true);
  });

  seedTest("seed-no-face", "顔が分かる写真は載せない（文のルール。発信のタブで Claude に渡す）", () => {
    const r = id("seed-no-face");
    assert.ok(instructionsFor(rules, { tab: "posts", menuIds: [] }).includes(r.label));
    assert.ok(!instructionsFor(rules, { tab: "reservations", menuIds: [] }).includes(r.label));
    assert.equal(resultFor(at({}), "seed-no-face"), undefined, "プログラムは判定しない");
  });

  test("どの例のルールにもテストがある", () => {
    assert.deepEqual(
      getSeedRules().map((r) => r.id).filter((x) => !TESTED.has(x)),
      [],
    );
  });
});
