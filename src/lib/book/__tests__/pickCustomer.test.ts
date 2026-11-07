// 「予約を入れる」の1枚の ①お客様を選ぶ段（book/pickCustomer.ts）のテスト。お客様を95人にして確かめる（テストの中だけ。seed は変えない）。
// - 並べ方2つ：前回来た日が新しい順（記録の無い方は後ろ）・50音順（よみの順）。一覧は全員（「もっと表示」は無い）
// - 50音の行の分け方（よみのカタカナ・ひらがな・濁点つき）と、右の端の索引
// - 前回からの間：30日未満は「○日前」、それ以上は月の差（日がまだ来ていなければ1引く）、12か月以上は「○年○か月前」（0か月は書かない）、記録なしは「初めての方」
// - 同じ名字で前回からの間も同じ方は番号を出す・名字とよみで探し、カタカナでもひらがなのよみで見つかる

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Customer } from "../../data/types";
import type { KarteRecord } from "../../karte/record";
import { FIRST_TIME, kanaGroups, kanaIndex, matchCustomer, pickCountLabel, pickCustomers, sinceLabel } from "../pickCustomer";

const ROOT = join(__dirname, "../../../..");
const TODAY = "2026-11-07";
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

describe("① お客様を選ぶ：並べ方2つと、全員を出す一覧", () => {
  test("全員を出す（95人）。「もっと表示」は無い", () => {
    const p = pickCustomers(customers, kartes, "", { today: TODAY });
    assert.equal(p.total, 95);
    assert.equal(p.shown.length, 95);
    assert.equal(pickCountLabel(p, ""), "95人");
    assert.doesNotMatch(readFileSync(join(ROOT, "src/app/reservations/OwnerBookSheet.tsx"), "utf8"), /もっと表示|CUSTOMER_PAGE/);
  });

  test("前回来た日が新しい順（記録の無い方は後ろ）。いちばん新しいカルテが前回", () => {
    const p = pickCustomers(customers, kartes, "", { order: "recent", today: TODAY });
    assert.deepEqual(p.shown.slice(0, 4).map((x) => x.customer.id), ["o5", "s2", "s1", "s3"]);
    assert.deepEqual(p.shown[2].last, { date: "2026-10-24", menuId: "cut" });
    assert.equal(p.shown[4].last, null);
    assert.equal(p.shown[4].since, FIRST_TIME);
  });

  test("50音順：よみの順（カタカナで書いたよみもひらがなとして並ぶ）。前回来た日は見ない", () => {
    const list = [cust("a", "上野", "ウエノ"), cust("b", "青木", "あおき"), cust("c", "石田", "いしだ"), cust("d", "後藤", "ごとう"), cust("e", "加藤", "かとう")];
    const k: KarteRecord[] = [karte("e", "2026-11-06")];
    assert.deepEqual(pickCustomers(list, k, "", { order: "kana", today: TODAY }).shown.map((x) => x.customer.surname), ["青木", "石田", "上野", "加藤", "後藤"]);
    assert.deepEqual(pickCustomers(list, k, "", { order: "recent", today: TODAY }).shown[0].customer.surname, "加藤");
  });

  test("100人でも重くならない（並べて行に分けるのが 50ms 未満）", () => {
    const many = Array.from({ length: 100 }, (_, i) => cust(`m${i}`, `名${i}`, ["あおき", "かとう", "さとう", "たなか", "なかの", "はやし", "まつだ", "やまだ", "りゅう", "わたなべ"][i % 10]));
    const t = performance.now();
    const groups = kanaGroups(pickCustomers(many, kartes, "", { order: "kana", today: TODAY }).shown);
    assert.ok(performance.now() - t < 50);
    assert.equal(groups.reduce((s, g) => s + g.items.length, 0), 100);
  });
});

describe("① 50音の行の分け方と右の端の索引", () => {
  const list = [
    cust("1", "青木", "あおき"),
    cust("2", "上野", "ウエノ"), // カタカナのよみ
    cust("3", "後藤", "ごとう"), // 濁点つき → か行
    cust("4", "佐藤", "さとう"),
    cust("5", "島田", "ジマダ"), // カタカナの濁点 → さ行
    cust("6", "馬場", "ばば"), // 濁点 → は行
    cust("7", "本田", "ﾎﾝﾀﾞ"), // 半角カタカナ → は行
    cust("8", "渡辺", "わたなべ"),
    cust("9", "名無", ""), // よみが無い → ほか
  ];
  const groups = kanaGroups(pickCustomers(list, [], "", { order: "kana", today: TODAY }).shown);

  test("行の見出しで区切る（人のいない行は出さない。よみの無い方は最後の「ほか」）", () => {
    assert.deepEqual(groups.map((g) => g.label), ["あ", "か", "さ", "は", "わ", "ほか"]);
    const of = (id: string) => groups.find((g) => g.items.some((c) => c.customer.id === id))?.label;
    assert.equal(of("2"), "あ");
    assert.equal(of("3"), "か");
    assert.equal(of("5"), "さ");
    assert.equal(of("6"), "は");
    assert.equal(of("7"), "は");
    assert.equal(of("9"), "ほか");
  });

  test("索引は あ〜わ の10行。人のいない行は押せない", () => {
    const idx = kanaIndex(groups);
    assert.deepEqual(idx.map((k) => k.label), ["あ", "か", "さ", "た", "な", "は", "ま", "や", "ら", "わ"]);
    assert.deepEqual(idx.filter((k) => k.has).map((k) => k.label), ["あ", "か", "さ", "は", "わ"]);
  });

  test("画面：50音順の時だけ見出しと索引。索引を押すとその行の見出しへ動く", () => {
    const sheet = readFileSync(join(ROOT, "src/app/reservations/OwnerBookSheet.tsx"), "utf8");
    assert.match(sheet, /const groups = order === "kana" \? kanaGroups\(pick\.shown\) : null;/);
    assert.match(sheet, /id=\{`obs-g-\$\{g\.id\}`\}/);
    assert.match(sheet, /document\.getElementById\(`obs-g-\$\{k\.id\}`\)\?\.scrollIntoView/);
    assert.match(sheet, /disabled=\{!k\.has\}/);
  });
});

describe("① 前回からの間（台帳の今日から数える）", () => {
  test("30日未満は「○日前」（同じ日は「今日」）", () => {
    assert.equal(sinceLabel("2026-11-07", TODAY), "今日");
    assert.equal(sinceLabel("2026-11-06", TODAY), "1日前");
    assert.equal(sinceLabel("2026-10-09", TODAY), "29日前");
  });

  test("30日以上は月の差。日がまだ来ていなければ1引く（少なくとも1か月）", () => {
    assert.equal(sinceLabel("2026-10-08", TODAY), "1か月前"); // 30日
    assert.equal(sinceLabel("2026-09-07", TODAY), "2か月前"); // 日が来ている
    assert.equal(sinceLabel("2026-09-08", TODAY), "1か月前"); // 日がまだ（11/7 < 8日）
    assert.equal(sinceLabel("2026-01-31", "2026-03-02"), "1か月前"); // 30日・月の差は2 − 1
  });

  test("12か月以上は「○年○か月前」（0か月は書かない）。年をまたぐ時も月で数える", () => {
    assert.equal(sinceLabel("2025-11-07", TODAY), "1年前");
    assert.equal(sinceLabel("2025-11-08", TODAY), "11か月前");
    assert.equal(sinceLabel("2025-08-01", TODAY), "1年3か月前");
    assert.equal(sinceLabel("2026-12-20", "2027-02-19"), "1か月前"); // 年をまたぐ・日がまだ
    assert.equal(sinceLabel("2026-12-20", "2027-02-20"), "2か月前");
    assert.equal(sinceLabel("2023-01-15", TODAY), "3年9か月前");
  });

  test("記録が無い方は「初めての方」。行には前回からの間を出す", () => {
    assert.equal(sinceLabel(null, TODAY), "初めての方");
    const p = pickCustomers(customers, kartes, "", { today: TODAY });
    assert.equal(p.shown.find((x) => x.customer.id === "s1")!.since, "14日前");
    const sheet = readFileSync(join(ROOT, "src/app/reservations/OwnerBookSheet.tsx"), "utf8");
    assert.match(sheet, /pickCustomers\(data\.customers, book\.kartes, query, \{ order, today: book\.now\.date \}\)/);
    assert.match(sheet, /\{c\.since\}/);
  });
});

describe("① 探し方と、同じ名字の見分け方（今のまま）", () => {
  test("佐藤で探すと9人：同じ名字で前回からの間も同じ方（初めての方同士・14日前同士）は番号を出し、違う方は出さない", () => {
    const p = pickCustomers(customers, kartes, "佐藤", { today: TODAY });
    assert.equal(p.shown.length, 9);
    assert.equal(pickCountLabel(p, "佐藤"), "「佐藤」に合う 9人（全員で 95人）");
    const byId = Object.fromEntries(p.shown.map((x) => [x.customer.id, x.showId]));
    assert.equal(byId.s2, false, "前回からの間が違う");
    assert.equal(byId.s1, true, "s3 と同じ14日前");
    assert.equal(byId.s3, true);
    assert.equal(byId.s4, true, "初めての方同士");
  });

  test("名字とよみで探す。カタカナ（全角・半角）でもひらがなのよみで見つかる", () => {
    for (const q of ["佐藤", "さとう", "サトウ", "ｻﾄｳ", "さと"]) assert.equal(pickCustomers(customers, kartes, q, { today: TODAY }).shown.length, 9, q);
    assert.equal(matchCustomer(cust("x", "青木", "あおき"), "アオ"), true);
    assert.equal(matchCustomer(cust("x", "青木", "あおき"), "いし"), false);
  });
});
