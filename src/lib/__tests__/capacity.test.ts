// 同じ時間に受ける人数（前は「席の数」）のテスト。Claude は呼ばず、決まった返事に置きかえる。
// - 最初は 1（1人で営業する店）。ルールのタブで 1〜3 の間で変えられ、このブラウザに残り、「最初に戻す」で 1 に戻る
// - 予約チャット・台帳・予約サイト・朝の要点の空き枠・発信の空き枠・AI の仕事・LINE が、みな同じ1つの数を使う
// - 最初の状態の架空の予約は、1人でも重ならない（11/9 の久保様と青木様など）
// - 例文ボタンと AI の仕事の架空の相談は、ずらした後の台帳でも今までどおり動く

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import shopJson from "../../../config/shop.json";
import { normalExample, previousExample, rejectedExample } from "../ai/examples";
import { contextFor, parseReserveRequest } from "../ai/request";
import { judgeSlot } from "../ai/slots";
import { runTool } from "../ai/tools";
import { at, chat, ctxAt, twoTurns } from "../ai/__tests__/helpers";
import { getBookData } from "../book/data";
import { emptyBook } from "../book/state";
import { addDays, businessDayAt, calDay, shopToday } from "../calendar";
import { CAPACITY_KEY, capacityJournal, capacityRaw, clampSeats, parseCapacity, seatsRangeOf, withSeats } from "../capacity";
import { getCustomers, getJobSeeds, getSeedReservations } from "../data/seed";
import { bookView, reserveText, seedOf } from "../jobs/run";
import { parseLineAskRequest } from "../line/ask";
import { openRanges, postFacts } from "../posts/facts";
import { freeRanges, loadBook, resolveChatReservations, type ChatReservation } from "../reservations";
import { resetAllWrites } from "../reset";
import { getAiSettings, getLineSettings, getMenus, getPostsSettings, getShop } from "../settings";
import { slotFull } from "../todo/full";

const ROOT = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const shop = getShop();
const menus = getMenus();
const ai = getAiSettings();

describe("1. 最初は1人。幅は 1〜3（店の設定）", () => {
  test("config/shop.json：seats は 1、選べる幅は 1〜3", () => {
    assert.equal(shopJson.seats, 1);
    assert.deepEqual(shopJson.seatsRange, { min: 1, max: 3 });
    assert.deepEqual(seatsRangeOf(shop), { min: 1, max: 3 });
  });

  test("ブラウザに残した数を読む：幅の中の整数だけ。おかしければ設定の数（1）", () => {
    assert.equal(parseCapacity(null, shop), 1);
    assert.equal(parseCapacity(JSON.stringify({ seats: 2 }), shop), 2);
    assert.equal(parseCapacity(JSON.stringify({ seats: 3 }), shop), 3);
    for (const bad of [JSON.stringify({ seats: 4 }), JSON.stringify({ seats: 0 }), JSON.stringify({ seats: 1.5 }), JSON.stringify({ seats: "2" }), "{", "null"])
      assert.equal(parseCapacity(bad, shop), 1, bad);
    assert.equal(clampSeats(2, { min: 1, max: 3 }), 2);
    assert.equal(clampSeats(9, { min: 1, max: 3 }), null);
  });

  test("書く形：設定と同じ数なら消す（null）。日誌の1行", () => {
    assert.equal(capacityRaw(1, shop), null);
    assert.equal(capacityRaw(2, shop), JSON.stringify({ seats: 2 }));
    assert.match(capacityJournal(1, 2), /同じ時間に受ける人数を 1人 から 2人 にした/);
  });

  test("店の設定に重ねる：幅の外・無い時は設定のまま（同じ物を返す）", () => {
    assert.equal(withSeats(shop, 2).seats, 2);
    assert.equal(withSeats(shop, 5), shop);
    assert.equal(withSeats(shop, undefined), shop);
    assert.equal(withSeats(shop, 1), shop);
  });

  test("「最初に戻す」で消す（設定の 1 に戻る）。ルールのタブの変更は残す", () => {
    const w = resetAllWrites("2026-11-04");
    assert.deepEqual(w.find((x) => x.key === CAPACITY_KEY), { key: CAPACITY_KEY, value: null });
    assert.ok(!w.some((x) => x.key === "rules"));
  });
});

describe("2. ルールのタブに「同じ時間に受ける人数」の欄", () => {
  const side = read("src/app/rules/RuleSide.tsx");
  test("1〜3 を選ぶ欄（幅は設定から）。人が選んだ時だけ変える。日誌は useCapacity が1行", () => {
    assert.match(side, /<Panel title="同じ時間に受ける人数">\s*<CapacityField \/>/);
    assert.match(side, /role="radiogroup" aria-label="同じ時間に受ける人数"/);
    assert.match(side, /range\.max - range\.min \+ 1/);
    assert.match(side, /if \(e\.nativeEvent\.isTrusted\) setSeats\(n\)/);
    const hook = read("src/lib/useCapacity.ts");
    assert.match(hook, /writeBrowser\(CAPACITY_KEY, capacityRaw\(v, getShop\(\)\)\)/);
    assert.match(hook, /writeJournal\(\{ who: "オーナー", text: capacityJournal\(before, v\) \}\)/);
  });
  test("「ためしに確かめる」も同じ数で判定する", () => {
    assert.match(side, /seats: book\.shop\.seats,/);
  });
});

describe("3. どの画面も同じ1つの数を使う", () => {
  test("画面の台帳（useBook）が店の設定に数を重ね、ほかはみな book.shop を使う（data.shop.seats を直に読まない）", () => {
    const useBook = read("src/lib/book/useBook.ts");
    assert.match(useBook, /const \{ seats \} = useCapacity\(\);/);
    assert.match(useBook, /withSeats\(data\.shop, seats\)/);
    assert.match(useBook, /assembleBook\(\{ shop, menus: data\.menus/);
    const files = [
      "src/app/reservations/BookingSite.tsx",
      "src/app/reservations/Ledger.tsx",
      "src/app/reservations/ReserveChat.tsx",
      "src/components/ApprovalBox.tsx",
      "src/app/home/HomeSummary.tsx",
      "src/app/home/LinePanel.tsx",
      "src/app/posts/PostsForm.tsx",
      "src/components/TodoFeeds.tsx",
      "src/components/LineBridge.tsx",
      "src/app/home/AiJobs.tsx",
      "src/app/rules/RuleSide.tsx",
    ];
    for (const f of files) {
      const src = read(f);
      assert.doesNotMatch(src, /data\.shop\.seats|shop: data\.shop,|freeRanges\(data\.shop|postFacts\(data\.shop/, f);
    }
    assert.match(read("src/app/home/AiJobs.tsx"), /data: book\.data,/, "AI の仕事も同じ数");
  });

  test("サーバー（予約チャット・AI の仕事・LINE）には画面が数を送り、サーバーは幅を確かめなおして使う", () => {
    assert.match(read("src/app/reservations/ReserveChat.tsx"), /seats: book\.shop\.seats,/);
    assert.match(read("src/lib/jobs/run.ts"), /seats: env\.data\.shop\.seats,/);
    assert.match(read("src/components/LineBridge.tsx"), /seats: L\.book\.shop\.seats,/);

    const base = {
      mode: "script",
      messages: [{ role: "user", text: "こんにちは" }],
      customer: { id: "c04", surname: "江口", firstVisit: false },
      booked: [],
      rules: [],
    };
    const two = parseReserveRequest({ ...base, seats: 2 }, menus, ai);
    assert.ok(two.ok);
    if (!two.ok) return;
    assert.equal(two.value.seats, 2);
    assert.equal(contextFor(two.value, shop, menus).shop.seats, 2);
    for (const bad of [9, 0, "3", 2.5]) {
      const r = parseReserveRequest({ ...base, seats: bad }, menus, ai);
      assert.ok(r.ok && r.value.seats === undefined, String(bad));
      if (r.ok) assert.equal(contextFor(r.value, shop, menus).shop.seats, 1, "送られなかった扱い＝設定の数");
    }
    const line = parseLineAskRequest({ text: "ToDo：タオル", customer: null, booked: [], rules: [], dayOffset: 0, seats: 3 }, menus, ai, getLineSettings().maxTextChars);
    assert.ok(line.ok && line.value.seats === 3);
  });

  // 11/5（木）13:00〜14:00 にカットが1件ある台帳で、同じ数がどこにも効くことを見る
  const today = calDay(shop, "2026-11-04");
  const c = getCustomers();
  const r = (id: string, date: string, start: string, menuId: string, i: number): ChatReservation => ({
    id,
    customerId: c[i].id,
    menuId,
    date,
    start,
    status: "confirmed",
    heldAt: "2026-11-01T00:00:00.000Z",
    expiresAt: "2026-11-02T00:00:00.000Z",
  });
  const all = resolveChatReservations(menus, c, [r("x1", "2026-11-05", "13:00", "cut", 0)]);
  const booked = all.map((x) => ({ id: x.id, customerId: x.customer.id, menuId: x.menu.id, date: x.date, start: x.start, status: x.status, newCustomer: false }));

  for (const seats of [1, 2]) {
    const s = withSeats(shop, seats);
    test(`${seats}人：予約チャットの判定・台帳・予約サイト・朝の要点・発信の空き枠・枠が埋まった時が、そろって同じ答え`, () => {
      const ctx = { ...ctxAt(at("2026-11-04", "10:00")), shop: s, booked };
      const same = { menuId: "cut", date: "2026-11-05", start: "13:00" };
      // 予約チャット（judge.ts）
      assert.equal(judgeSlot(ctx, same).ok, seats > 1);
      const v = judgeSlot(ctx, same);
      if (seats === 1) assert.match(v.base.find((b) => b.id === "seats")!.reason, /同じ時間に受けるのは1人まで/);
      // 朝の要点・予約サイト（freeRanges）
      const day = calDay(s, "2026-11-05");
      const at13 = freeRanges(s, day, all).ranges.find((x) => x.start <= "13:00" && "13:00" < x.end);
      if (seats === 1) assert.equal(at13, undefined, "13:00 は空きに出さない");
      else assert.equal(at13?.free, 1);
      // 発信の空き枠（同じ数え方）
      const open = openRanges(s, day, all).map((o) => `${o.start}〜${o.end}`).join("・");
      assert.equal(open, seats === 1 ? "10:00〜13:00・14:00〜20:00" : "10:00〜20:00");
      const facts = postFacts(s, getPostsSettings(), today, { date: "2026-11-04", time: "19:45" }, all);
      assert.equal(facts.openings[0], `11/5（木）${open}`);
      // 予約サイト（架空）で枠が埋まった時の ToDo
      assert.equal(slotFull(all, { id: "h", date: "2026-11-05", startMin: 13 * 60, endMin: 14 * 60 }, s.seats), seats === 1);
      // 台帳の確かめ（重なり）。最初の状態の予約が無い 18:00 に2件
      const twice = resolveChatReservations(menus, c, [r("y1", "2026-11-05", "18:00", "cut", 0), r("y2", "2026-11-05", "18:00", "cut", 1)]);
      const book = loadBook(s, menus, today, today, twice);
      assert.equal(book.checks.seats.ok, seats >= 2);
    });
  }

  test("予約チャットの道具も、送られた数で空きを出す（1人なら13時は出さず、2人なら出す）", () => {
    const ctx = { ...ctxAt(at("2026-11-04", "10:00")), booked };
    const one = runTool({ ...ctx, shop: withSeats(shop, 1) }, "check_rules", { menu_id: "cut", date: "2026-11-05", start: "13:00" });
    const two = runTool({ ...ctx, shop: withSeats(shop, 2) }, "check_rules", { menu_id: "cut", date: "2026-11-05", start: "13:00" });
    assert.match(one.content, /"ok":false/);
    assert.match(two.content, /"ok":true/);
  });
});

describe("4. 最初の状態の架空の予約は、1人でも重ならない", () => {
  test("11/9 の久保様（縮毛矯正 10:00〜13:00）と青木様（ヘッドスパ）は重ならない時刻に", () => {
    const seed = getSeedReservations();
    const kubo = seed.find((x) => x.id === "r09")!;
    const aoki = seed.find((x) => x.id === "r10")!;
    assert.equal(kubo.day, aoki.day);
    assert.equal(kubo.start, "10:00");
    assert.equal(aoki.start, "13:30");
  });

  for (const opened of ["2026-11-02", "2026-11-04", "2026-11-08"])
    test(`${opened} に開いた台帳：どの日も同じ時間に2件入っていない（台帳の確かめも ✓）`, () => {
      const { today } = shopToday(shop, at(opened, "09:00"));
      const book = loadBook(shop, menus, today);
      const byDay = new Map<string, typeof book.all>();
      for (const x of book.all) byDay.set(x.date, [...(byDay.get(x.date) ?? []), x]);
      for (const [date, list] of byDay)
        for (let i = 0; i < list.length; i++)
          for (const y of list.slice(i + 1))
            assert.ok(!(list[i].startMin < y.endMin && y.startMin < list[i].endMin), `${date} ${list[i].start} と ${y.start} が重なる`);
      assert.ok(book.checks.seats.ok, book.checks.seats.problems.join("／"));
    });
});

describe("5. 例文ボタンと AI の仕事の架空の相談は、ずらした後の台帳でも今までどおり", () => {
  const DATES = Array.from({ length: 7 }, (_, i) => addDays("2026-11-02", i));
  for (const date of DATES)
    for (const time of ["09:00", "12:00", "18:30"])
      test(`${date} ${time}：普通の予約は受けられ、ルールで断られる予約はルールで断られる（店の設定ではなく）`, async () => {
        const ctx = ctxAt(at(date, time));
        const normal = normalExample(ctx);
        assert.ok(normal, "普通の予約の例文が作れる");
        const { b } = await twoTurns(ctx, normal!.text);
        assert.equal(b.holds.length, 1, "仮押さえまで進む");
        const rejected = rejectedExample(ctx)!;
        assert.ok(rejected, "断られる予約の例文が作れる");
        const r = await chat(ctx, [{ role: "user", text: rejected.text }]);
        assert.equal(r.holds.length, 0);
        if (time === "12:00") assert.ok(r.steps.some((s) => s.text.startsWith("ルールで外した")), r.steps.map((s) => s.text).join("\n"));
      });

  test("「前と同じで」：前回のメニューで候補を出し、仮押さえまで", async () => {
    const ctx = ctxAt(at("2026-11-04", "10:00"));
    const { b } = await twoTurns(ctx, previousExample().text);
    assert.equal(b.holds.length, 1);
  });

  test("AI の仕事の架空の相談（大橋様・カット・1番目の営業日の15:00）は、1人でもそのまま受けられる", () => {
    const data = getBookData();
    const seed = seedOf(getJobSeeds(), "reserve")!;
    for (const opened of ["2026-11-02", "2026-11-04", "2026-11-07"]) {
      const now = at(opened, "09:00");
      const state = emptyBook(shopToday(shop, now).today.date);
      const text = reserveText(data, state, now, seed);
      assert.match(text ?? "", /の15:00からカットをお願いします/);
      const view = bookView(data, state, now);
      const ctx = { ...ctxAt(now, {}, seed.customerId), booked: view.booked };
      const date = businessDayAt(shop, view.clock.today, seed.day)!.date;
      assert.equal(judgeSlot(ctx, { menuId: seed.menuId, date, start: seed.start }).ok, true, `${opened}：${text}`);
    }
  });
});
