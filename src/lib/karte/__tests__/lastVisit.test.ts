// カルテのお客様一覧の「前回 日付 メニュー」：いちばん新しいカルテ（来店の記録）から取る・無い時は「前回の記録なし」。
// 画面に依らない関数（customers.ts の lastVisitOf・lastVisitLabel）だけを確かめる。AI は使わない。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { at, menus, shop } from "../../ai/__tests__/helpers";
import { calDay, shopToday } from "../../calendar";
import { resolveMenu } from "../../combo";
import { getCustomers, getSeedKartes } from "../../data/seed";
import { loadBook } from "../../reservations";
import { lastVisitLabel, lastVisitOf, NO_LAST_VISIT } from "../customers";
import { allKartes, resolveSeedKartes, type KarteRecord, type SavedKarte } from "../record";

const k = (id: string, customerId: string, date: string, menuId: string, extra: Partial<KarteRecord> = {}): KarteRecord => ({
  id,
  customerId,
  date,
  menuId,
  sections: {},
  source: "seed",
  ...extra,
});
const dayLabel = (d: string) => calDay(shop, d).label;
const menuName = (id: string) => resolveMenu(menus, id)?.name ?? id;

describe("前回の来店日とメニュー", () => {
  test("いちばん新しいカルテの日付とメニュー（並びの順に依らない）", () => {
    const list = [k("a", "c01", "2026-10-03", "cut"), k("b", "c01", "2026-10-24", "cut+color"), k("c", "c02", "2026-10-30", "perm")];
    assert.deepEqual(lastVisitOf(list, "c01"), { date: "2026-10-24", menuId: "cut+color" });
    assert.deepEqual(lastVisitOf([...list].reverse(), "c01"), { date: "2026-10-24", menuId: "cut+color" });
  });

  test("同じ日に2枚あれば、あとで保存した方", () => {
    const list = [
      k("a", "c01", "2026-11-05", "cut", { source: "saved", savedAt: "2026-11-05T03:00:00.000Z" }),
      k("b", "c01", "2026-11-05", "color", { source: "saved", savedAt: "2026-11-05T05:00:00.000Z" }),
    ];
    assert.equal(lastVisitOf(list, "c01")?.menuId, "color");
  });

  test("カルテが無いお客様は null で「前回の記録なし」", () => {
    const list = [k("a", "c01", "2026-10-03", "cut")];
    assert.equal(lastVisitOf(list, "c99"), null);
    assert.equal(lastVisitOf([], "c01"), null);
    assert.equal(lastVisitLabel(null, dayLabel, menuName), NO_LAST_VISIT);
    assert.equal(NO_LAST_VISIT, "前回の記録なし");
  });

  test("言葉は「前回 10/24（土）カット＋カラー」の形（日付は店の暦・組み合わせはメニューの名前を＋でつなぐ）", () => {
    const [a, b] = menus;
    const label = lastVisitLabel({ date: "2026-10-24", menuId: `${a.id}+${b.id}` }, dayLabel, menuName);
    assert.equal(label, `前回 ${calDay(shop, "2026-10-24").label}${a.name}＋${b.name}`);
    assert.match(label, /^前回 10\/24（.）/);
  });

  test("最初の状態のカルテ（架空）と人が保存したカルテを合わせても、新しい方を使う", () => {
    const { today } = shopToday(shop, at("2026-11-04", "10:00"));
    const seed = resolveSeedKartes(getSeedKartes(), loadBook(shop, menus, today).all);
    const withSeed = seed.find((x) => x.customerId);
    assert.ok(withSeed, "最初の状態のカルテがある");
    const cid = withSeed.customerId;
    const before = lastVisitOf(seed, cid);
    assert.ok(before && before.date < today.date);
    const saved: SavedKarte = { id: "s1", customerId: cid, date: today.date, menuId: menus[0].id, memo: "", sections: {}, savedAt: "2026-11-04T02:00:00.000Z" };
    assert.deepEqual(lastVisitOf(allKartes(seed, [saved]), cid), { date: today.date, menuId: menus[0].id });
    // 最初の状態でカルテの無い方は「前回の記録なし」
    const none = getCustomers().find((c) => !seed.some((x) => x.customerId === c.id));
    if (none) assert.equal(lastVisitLabel(lastVisitOf(seed, none.id), dayLabel, menuName), NO_LAST_VISIT);
  });
});
