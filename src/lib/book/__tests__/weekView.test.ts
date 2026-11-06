// 台帳を、先の週・前の週・月のカレンダーで見る（docs/SPEC.md §1.3.1）のテスト。AI は使わない。
// - 範囲：先は book.now.date を含めて56日（holidayLimits.aheadDays）・前は4週・その先に有効な予約があればその日まで
// - 端の週も7列（範囲の外は薄く・入れられない）・範囲の最初と最後の日を飛ばさない
// - 「翌日へ」「最初に戻す」（同じ日に押した時も）で今日の週・月に戻り、開いている1枚が閉じる
// - 月のカレンダーの件数と埋まりは台帳と同じ数・お休みの日は「—」・残った予約の件数は消さない

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { addDays } from "../../calendar";
import { withHolidays } from "../../holidays";
import { getRules } from "../../rules/store";
import { getBookData } from "../data";
import { ownerBook } from "../owner";
import { ledgerView } from "../site";
import { emptyBook, type BookState } from "../state";
import { timetable } from "../timetable";
import {
  BACK_WEEKS,
  canMonth,
  canStep,
  clampStart,
  fillPercent,
  freshView,
  monthGrid,
  monthOf,
  stepWeek,
  syncView,
  viewKey,
  viewRange,
  viewReduce,
  viewWeek,
  weekLabel,
  weekSummaries,

} from "../weekView";

const ROOT = join(__dirname, "../../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const data = getBookData();
const shop = data.shop;
const NOW = new Date("2026-11-04T08:30:00+09:00");
const start = emptyBook("2026-11-04");
const view = (s: BookState = start, now = NOW) => ledgerView(data, s, now);
const v0 = view();
const TODAY = v0.clock.today;
const range0 = viewRange(shop, { todayDate: TODAY.date, nowDate: v0.clock.now.date, all: v0.all });

describe("1. 見られる範囲", () => {
  test("先は book.now.date を含めて56日（55日後まで）。前は4週前まで", () => {
    assert.equal(TODAY.date, "2026-11-04");
    assert.equal(range0.aheadLast, addDays("2026-11-04", 55));
    assert.equal(range0.last, "2026-12-29");
    assert.equal(range0.first, addDays("2026-11-04", -7 * BACK_WEEKS));
    assert.equal(range0.first, "2026-10-07");
  });

  test("その先にこれから先の有効な予約（確定・期限の切れていない仮押さえ）があれば、その日まで", () => {
    const far: BookState = {
      ...start,
      chat: [{ id: "h-far", customerId: "c01", menuId: "cut", date: "2027-01-15", start: "15:00", status: "hold", heldAt: NOW.toISOString(), expiresAt: "2026-11-05T00:00:00.000Z" }],
    };
    const v = view(far);
    const r = viewRange(shop, { todayDate: TODAY.date, nowDate: v.clock.now.date, all: v.all });
    assert.equal(r.last, "2027-01-15");
    // 仮押さえの期限が切れたら範囲は縮み、見ていた週は範囲の中へ戻る
    const later = new Date("2026-11-05T09:00:00+09:00");
    const v2 = view(far, later);
    const r2 = viewRange(shop, { todayDate: v2.clock.today.date, nowDate: v2.clock.now.date, all: v2.all });
    assert.equal(r2.last, addDays("2026-11-05", 55));
    assert.equal(clampStart("2027-01-15", r2), r2.last);
    // 期限の切れていない間は、そこまで動かせる
    let s = TODAY.date;
    while (canStep(s, 1, r)) s = stepWeek(s, 1, r);
    assert.ok(addDays(s, 6) >= "2027-01-15");
  });
});

describe("2. 週を動かす：7日ずつ・端の週も7列・最初と最後の日を飛ばさない", () => {
  test("7日ずつ。範囲の表示は「11/11（水）〜11/17（火）」", () => {
    assert.equal(stepWeek(TODAY.date, 1, range0), "2026-11-11");
    assert.equal(stepWeek(TODAY.date, -1, range0), "2026-10-28");
    assert.equal(weekLabel(shop, "2026-11-11"), "11/11（水）〜11/17（火）");
  });

  test("どこから動かしても、範囲の最初の日と最後の日を飛ばさない（端の日を選んだ後も）", () => {
    for (let k = 0; k <= 83; k++) {
      const s0 = addDays(range0.first, k);
      if (s0 > range0.last) break;
      let s = s0;
      while (canStep(s, -1, range0)) s = stepWeek(s, -1, range0);
      assert.equal(s, range0.first, `前へ：${s0}`);
      s = s0;
      while (canStep(s, 1, range0)) {
        const n = stepWeek(s, 1, range0);
        assert.ok(n <= addDays(s, 7), "見えていない日を飛ばさない");
        s = n;
      }
      assert.ok(addDays(s, 6) >= range0.last && s <= range0.last, `次へ：${s0}`);
    }
  });

  test("端の週も7列。範囲の外の列は outside で、時間割の空いたマスが無い（入れられない）", () => {
    const days = viewWeek(shop, TODAY, v0.all, range0.last, range0);
    assert.equal(days.length, 7);
    assert.equal(days[0].outside, false);
    assert.ok(days.slice(1).every((d) => d.outside));
    const tt = timetable(days, v0.clock.now, { seats: shop.seats, step: shop.slotMinutes });
    assert.ok(tt.columns.slice(1).every((c) => c.outside && c.picks.length === 0));
    // 範囲の外の日には、1枚も開かない
    const s = freshView("k");
    assert.equal(viewReduce(s, { kind: "open", target: { date: addDays(range0.last, 1), start: "10:00" } }, { todayDate: TODAY.date, range: range0 }).sheet, null);
    assert.ok(viewReduce(s, { kind: "open", target: { date: range0.last, start: "10:00" } }, { todayDate: TODAY.date, range: range0 }).sheet);
  });

  test("2週目の最初の予約は「次の週」で見える（今日の週には無い）", () => {
    const now = viewWeek(shop, TODAY, v0.all, TODAY.date, range0);
    const next = viewWeek(shop, TODAY, v0.all, stepWeek(TODAY.date, 1, range0), range0);
    const ids = (w: typeof now) => w.flatMap((d) => d.reservations.map((r) => r.id));
    assert.ok(ids(next).includes("r12"), ids(next).join(","));
    assert.ok(!ids(now).includes("r12"));
    // 今日の印は今日の週だけ
    assert.ok(now.some((d) => d.isToday));
    assert.ok(!next.some((d) => d.isToday));
    const tt = timetable(next, v0.clock.now, { seats: shop.seats, step: shop.slotMinutes });
    assert.equal(tt.now, null, "いまの時刻の線は今日の週だけ");
  });

  test("先の週でも、空いたマスから台帳から入れられる。過ぎた日は入れられない", () => {
    const next = viewWeek(shop, TODAY, v0.all, "2026-11-18", range0);
    const tt = timetable(next, v0.clock.now, { seats: shop.seats, step: shop.slotMinutes });
    const col = tt.columns.find((c) => c.date === "2026-11-20")!;
    assert.ok(col.picks.length > 0);
    const ctx = { data, rules: getRules(), now: NOW, newId: () => "own-w" };
    assert.ok(ownerBook(start, ctx, { customerId: "c01", menuId: "cut", date: "2026-11-20", start: col.picks[0].start }).ok);
    const past = viewWeek(shop, TODAY, v0.all, "2026-10-28", range0);
    const ttp = timetable(past, v0.clock.now, { seats: shop.seats, step: shop.slotMinutes });
    assert.ok(ttp.columns.filter((c) => c.date < "2026-11-04").every((c) => c.picks.length === 0));
    assert.equal(ownerBook(start, ctx, { customerId: "c01", menuId: "cut", date: "2026-10-29", start: "15:00" }).ok, false);
  });

  test("見ている週を動かしても、今日・台帳の確かめの数は変わらない", () => {
    const a = viewWeek(shop, TODAY, v0.all, "2026-11-18", range0);
    assert.equal(v0.clock.today.date, "2026-11-04");
    assert.ok(a.every((d) => !d.isToday));
    // 台帳の確かめ・承認の箱・ホームは book.book（今日からの7日）のまま。画面は見ている週を別の所から読む
    assert.match(read("src/app/reservations/WeekTimetable.tsx"), /timetable\(view\.days,/);
    assert.match(read("src/app/reservations/Ledger.tsx"), /view\.days\.map/);
  });
});

describe("3. 「翌日へ」「最初に戻す」で今日の週・月に戻り、開いている1枚が閉じる", () => {
  const ctx = { todayDate: TODAY.date, range: range0 };
  let s = freshView(viewKey(undefined, 0));
  s = viewReduce(s, { kind: "step", dir: 1 }, ctx);
  s = viewReduce(s, { kind: "month", dir: 1 }, ctx);
  s = viewReduce(s, { kind: "open", target: { date: "2026-11-12", start: "10:00" } }, ctx);

  test("同じ印なら、そのまま", () => {
    assert.equal(syncView(s, viewKey(undefined, 0)), s);
    assert.equal(s.start, "2026-11-11");
    assert.ok(s.sheet && s.month);
  });

  test("「翌日へ」（実際に進んだ dayOffset が変わる）で戻る", () => {
    const t = syncView(s, viewKey(undefined, 1));
    assert.deepEqual([t.start, t.month, t.sheet], [null, null, null]);
  });

  test("「最初に戻す」（同じ日に押しても印 epoch が変わる）で戻る", () => {
    const t = syncView(s, viewKey("e2", 0));
    assert.deepEqual([t.start, t.month, t.sheet], [null, null, null]);
  });

  test("画面：ページの共通の親が1つだけ持ち、印は book.state.epoch と book.dayOffset。部品は週を持たない", () => {
    const p = read("src/app/reservations/LedgerView.tsx");
    assert.match(p, /viewKey\(book\.state\.epoch, book\.dayOffset\)/);
    assert.match(p, /const view = syncView\(raw, key\);/);
    assert.match(read("src/app/reservations/page.tsx"), /<LedgerViewProvider data=\{data\}>/);
    for (const f of ["WeekTimetable.tsx", "Ledger.tsx", "MonthCalendar.tsx"]) assert.doesNotMatch(read(`src/app/reservations/${f}`), /useState/, f);
  });
});

describe("4. 月のカレンダー", () => {
  const hol = withHolidays(shop, ["2026-11-06"]);
  const vh = ledgerView({ ...data, shop: hol }, start, NOW);
  const r = viewRange(hol, { todayDate: vh.clock.today.date, nowDate: vh.clock.now.date, all: vh.all });
  const g = monthGrid(hol, "2026-11", { todayDate: vh.clock.today.date, all: vh.all, range: r, viewStart: vh.clock.today.date });
  const cells = g.weeks.flat().filter((c) => c.inMonth);
  const cell = (d: string) => cells.find((c) => c.date === d)!;

  test("見出しに年。日曜はじまりで、その月の日が全部ある", () => {
    assert.equal(g.title, "2026年11月");
    assert.equal(cells.length, 30);
    assert.equal(g.weeks[0][0].date, "2026-11-01");
  });

  test("件数と埋まりは台帳（7日の台帳と同じ ledgerDay）と同じ数", () => {
    const week = viewWeek(hol, vh.clock.today, vh.all, vh.clock.today.date, r);
    for (const d of week) {
      const c = cell(d.date);
      assert.equal(c.count, d.reservations.length, d.date);
      assert.equal(c.usedMinutes, d.usedMinutes);
      assert.equal(c.capacityMinutes, d.capacityMinutes);
    }
  });

  test("休みの日は埋まり「—」。残った予約の件数は消さない。定休日も「—」", () => {
    const c = cell("2026-11-06");
    assert.equal(c.closed && c.holiday, true);
    assert.equal(c.count, 2);
    assert.equal(fillPercent(c.usedMinutes, c.capacityMinutes), null);
    const tue = cell("2026-11-10");
    assert.equal(tue.closed && !tue.holiday, true);
  });

  test("範囲の外の日は押せない印・いま見ている7日の印・今日", () => {
    assert.equal(cell("2026-11-01").inRange, true);
    assert.equal(cell("2026-11-04").isToday, true);
    assert.deepEqual(cells.filter((c) => c.inView).map((c) => c.date), Array.from({ length: 7 }, (_, i) => addDays("2026-11-04", i)));
    const jan = monthGrid(hol, "2027-01", { todayDate: "2026-11-04", all: vh.all, range: r, viewStart: "2026-11-04" });
    assert.ok(jan.weeks.flat().filter((c) => c.inMonth).every((c) => !c.inRange));
    assert.equal(canMonth("2026-12", 1, r), false);
    assert.equal(canMonth("2026-10", -1, r), false);
    assert.equal(canMonth("2026-11", 1, r), true);
  });

  test("日を押すとその日から7日の台帳へ。月だけ動かしても台帳は動かない。週を動かすと月はその週の月", () => {
    const ctx = { todayDate: "2026-11-04", range: r };
    let s = freshView("k");
    s = viewReduce(s, { kind: "month", dir: 1 }, ctx);
    assert.equal(s.month, "2026-12");
    assert.equal(s.start, null, "月だけでは台帳は動かない");
    s = viewReduce(s, { kind: "pick", date: "2026-12-20" }, ctx);
    assert.equal(s.start, "2026-12-20");
    assert.equal(s.month, null);
    assert.equal(monthOf(s.start!), "2026-12");
    s = viewReduce(s, { kind: "step", dir: -1 }, ctx);
    s = viewReduce(s, { kind: "step", dir: -1 }, ctx);
    s = viewReduce(s, { kind: "step", dir: -1 }, ctx);
    assert.equal(monthOf(s.start!), "2026-11");
    assert.equal(s.month, null);
  });

  test("週ごとの件数と埋まりは「埋まっている分の合計 ÷ 受けられる分の合計」", () => {
    const sums = weekSummaries(hol, { today: vh.clock.today, all: vh.all, range: r });
    const w = sums.find((x) => x.start === "2026-11-04")!;
    const week = viewWeek(hol, vh.clock.today, vh.all, "2026-11-04", r);
    const used = week.reduce((a, d) => a + d.usedMinutes, 0);
    const cap = week.reduce((a, d) => a + d.capacityMinutes, 0);
    assert.equal(w.count, week.reduce((a, d) => a + d.reservations.length, 0));
    assert.equal(w.percent, Math.round((used / cap) * 100));
    assert.match(w.label, /^11\/4〜11\/10：\d+件・埋まり \d+%$/);
    assert.equal(sums[0].start, r.first);
  });
});

