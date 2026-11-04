// 予約タブの見た目のテスト（数え方・承認の箱・判定は変えない。出し方だけ）。
// - 1週間の予約台帳の時間割（PC）：横に今日から7日・縦に営業時間・帯の長さは時間の長さ・確定は塗りつぶし・仮押さえは点線のしま模様
//   今日の列は目立たせ、定休日の列は灰色。帯の中にお客様（架空）とメニュー
// - PC は予約タブの一番上に横いっぱい。スマホは日ごとのカードのまま（予約チャットが上の並びも今のまま）
// - 予約サイト（架空）の ○△× の表は残す

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TimetableGrid } from "../../../app/reservations/TimetableGrid";
import { addDays, calDay, toMinutes } from "../../calendar";
import { getCustomers } from "../../data/seed";
import { loadBook, resolveChatReservations, weekLedger, type ChatReservation } from "../../reservations";
import { getMenus, getShop } from "../../settings";
import { bandTitle, timetable } from "../timetable";

const ROOT = join(__dirname, "../../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const shop = getShop();
const menus = getMenus();
const customers = getCustomers();

/** 火曜定休の店で、月曜を今日にする（7日の中に定休日の火曜が入る） */
const MONDAY = "2026-11-09";
const today = calDay(shop, MONDAY);

function chat(list: Partial<ChatReservation>[]): ReturnType<typeof resolveChatReservations> {
  return resolveChatReservations(
    menus,
    customers,
    list.map((r, i) => ({
      id: `chat-${i}`,
      customerId: customers[i % customers.length].id,
      menuId: "cut",
      date: MONDAY,
      start: "10:00",
      status: "hold",
      heldAt: "2026-11-09T00:00:00Z",
      expiresAt: "2026-11-10T00:00:00Z",
      ...r,
    })),
  );
}

const render = (tt: ReturnType<typeof timetable>) => renderToStaticMarkup(createElement(TimetableGrid, { tt }));
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

describe("1. 時間割の並べ方（src/lib/book/timetable.ts）", () => {
  const book = loadBook(shop, menus, today);
  const tt = timetable(book.week, { date: MONDAY, time: "12:30" });

  test("横に今日から7日（今日が先頭）、縦は営業時間（10:00〜20:00 を1時間ごと）", () => {
    assert.equal(tt.columns.length, 7);
    assert.equal(tt.columns[0].date, MONDAY);
    assert.ok(tt.columns[0].isToday);
    assert.equal(tt.columns.filter((c) => c.isToday).length, 1);
    assert.deepEqual(
      tt.columns.map((c) => c.date),
      Array.from({ length: 7 }, (_, i) => addDays(MONDAY, i)),
    );
    assert.equal(tt.from, toMinutes("10:00"));
    assert.equal(tt.to, toMinutes("20:00"));
    assert.deepEqual(
      tt.ticks.map((t) => t.label),
      ["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00"],
    );
    assert.equal(tt.ticks[0].top, 0);
    assert.equal(tt.ticks.at(-1)!.top, 100);
  });

  test("定休日（火曜）の列はお休み（帯なし・open が false）", () => {
    const tue = tt.columns.find((c) => calDay(shop, c.date).key === "tue")!;
    assert.equal(tue.open, false);
    assert.equal(tue.bands.length, 0);
    assert.equal(tue.count, 0);
  });

  test("件数と埋まりは台帳の数のまま（数え方は変えない）", () => {
    for (const [i, c] of tt.columns.entries()) {
      assert.equal(c.count, book.week[i].reservations.length);
      assert.equal(c.usedMinutes, book.week[i].usedMinutes);
      assert.equal(c.capacityMinutes, book.week[i].capacityMinutes);
      assert.equal(c.bands.length, c.count);
    }
  });

  test("帯は時間の長さの分だけ縦に伸びる（上の位置 = 始まり、高さ = かかる時間）", () => {
    const total = tt.to - tt.from;
    const bands = tt.columns.flatMap((c) => c.bands);
    assert.ok(bands.length > 0, "最初の状態の7日に予約がある");
    for (const b of bands) {
      assert.ok(Math.abs(b.top - ((toMinutes(b.start) - tt.from) / total) * 100) < 0.01, b.id);
      assert.ok(Math.abs(b.height - (b.minutes / total) * 100) < 0.01, b.id);
    }
    // 縮毛矯正（180分）はカット（60分）の3倍の高さ
    const cut = bands.find((b) => b.minutes === 60);
    const straight = bands.find((b) => b.minutes === 180);
    if (cut && straight) assert.ok(Math.abs(straight.height - cut.height * 3) < 0.05);
  });

  test("最初の状態の確定は「外」、仮押さえは「AI」、承認で確定は「人」", () => {
    for (const b of tt.columns.flatMap((c) => c.bands)) {
      if (b.status === "hold") assert.equal(b.actor, "ai");
      else assert.equal(b.actor, "outside");
    }
    const t2 = timetable(
      loadBook(shop, menus, today, today, chat([{ start: "15:00", status: "hold" }, { start: "17:00", status: "confirmed", menuId: "headspa" }])).week,
    );
    const mine = t2.columns[0].bands.filter((b) => b.id.startsWith("chat-"));
    assert.deepEqual(
      mine.map((b) => [b.status, b.actor, b.fresh]),
      [
        ["hold", "ai", false],
        ["confirmed", "human", true],
      ],
    );
  });

  test("いまの線は、今日の列の今の時刻（営業時間の外・7日の外なら出さない）", () => {
    assert.deepEqual(tt.now, { date: MONDAY, top: 25 });
    assert.equal(timetable(book.week, { date: MONDAY, time: "08:00" }).now, null);
    assert.equal(timetable(book.week, { date: "2026-12-31", time: "12:00" }).now, null);
    assert.equal(timetable(book.week).now, null);
  });

  test("同じ時間に受ける人数が2人以上で重なった帯は、横に分けて並べる（重ならない帯は1本の幅いっぱい）", () => {
    const two = { ...shop, seats: 2 };
    const list = chat([
      { start: "15:00", menuId: "perm" }, // 15:00–17:00
      { start: "16:00", menuId: "cut" }, // 16:00–17:00（重なる）
      { start: "17:00", menuId: "cut" }, // 17:00–18:00（どれとも重ならない）
    ]);
    const col = timetable(weekLedger(two, today, list)).columns[0];
    const by = (id: string) => col.bands.find((b) => b.id === id)!;
    assert.deepEqual([by("chat-0").lane, by("chat-0").lanes], [0, 2]);
    assert.deepEqual([by("chat-1").lane, by("chat-1").lanes], [1, 2]);
    assert.deepEqual([by("chat-2").lane, by("chat-2").lanes], [0, 1]);
  });

  test("帯の読み上げの文：時刻・メニュー・お客様（架空）・確定か仮押さえか・だれが入れたか", () => {
    const b = timetable(loadBook(shop, menus, today, today, chat([{ start: "15:00" }])).week).columns[0].bands.find((x) => x.id === "chat-0")!;
    const t = bandTitle(b);
    assert.match(t, /^15:00–16:00 カット /);
    assert.match(t, /（架空）様/);
    assert.match(t, /仮押さえ（承認待ち）/);
    assert.match(t, /［AI：AI がした事］/);
  });

  test("営業日が1日も無い7日でも 10:00〜20:00 で出す（こわれない）", () => {
    const closed = { ...shop, hours: Object.fromEntries(Object.keys(shop.hours).map((k) => [k, null])) as typeof shop.hours };
    const t = timetable(loadBook(closed, menus, calDay(closed, MONDAY)).week);
    assert.equal(t.from, 600);
    assert.equal(t.to, 1200);
    assert.ok(t.columns.every((c) => !c.open && c.bands.length === 0));
  });
});

describe("2. 時間割の出し方（TimetableGrid）", () => {
  const list = chat([{ start: "15:00", status: "hold" }, { start: "17:00", status: "confirmed", menuId: "headspa" }]);
  const tt = timetable(loadBook(shop, menus, today, today, list).week, { date: MONDAY, time: "12:30" });
  const html = render(tt);

  test("7日の列の頭と体（今日の列は today、定休日の列は closed で灰色・「お休み」）", () => {
    assert.equal(count(html, /class="tt-head[ "]/g), 7);
    assert.equal(count(html, /class="tt-col[ "]/g), 7);
    assert.equal(count(html, /class="tt-head today"/g), 1);
    assert.equal(count(html, /class="tt-col today"/g), 1);
    assert.equal(count(html, /class="tt-head closed"/g), 1);
    assert.equal(count(html, /class="tt-col closed"/g), 1);
    assert.match(html, /<span class="tag">今日<\/span>/);
    assert.match(html, /tt-closed-label">お休み</);
  });

  test("列の頭に件数（大きい数字）と埋まり（小さい棒）", () => {
    const open = tt.columns.filter((c) => c.open).length;
    assert.equal(count(html, /class="tt-count"/g), open);
    assert.equal(count(html, /class="minibar"/g), open);
  });

  test("帯：確定は塗りつぶし（confirmed）、仮押さえは点線のしま模様（hold）。どの帯にもお客様の「架空」の札とメニュー", () => {
    const bands = tt.columns.flatMap((c) => c.bands);
    assert.equal(count(html, /<li class="tt-band /g), bands.length);
    assert.equal(count(html, /<li class="tt-band confirmed /g), bands.filter((b) => b.status === "confirmed").length);
    assert.equal(count(html, /<li class="tt-band hold /g), bands.filter((b) => b.status === "hold").length);
    assert.equal(count(html, /class="tag fictional">架空</g), bands.length);
    for (const b of bands) assert.ok(html.includes(`${b.surname} 様`), b.surname);
    assert.match(html, /<span class="tag hold">仮押さえ<\/span>/);
    assert.match(html, /<span class="tag ok">承認で確定<\/span>/);
  });

  test("帯の頭に「AI」「人」「外」の文字の札（色だけに頼らない）", () => {
    const bands = tt.columns.flatMap((c) => c.bands);
    assert.equal(count(html, /class="tag actor actor-(ai|human|outside)"/g), bands.length);
    assert.match(html, /class="tag actor actor-ai"[^>]*><b class="actor-mark">AI<\/b>/);
    assert.match(html, /class="tag actor actor-human"[^>]*><b class="actor-mark">人<\/b>/);
    assert.match(html, /class="tag actor actor-outside"[^>]*><b class="actor-mark">外<\/b>/);
  });

  test("30分の帯は1行（short）。いまの線は1本", () => {
    assert.match(html, /<li class="tt-band confirmed actor-human fresh short"/);
    assert.equal(count(html, /class="tt-now"/g), 1);
  });

  test("帯の位置と高さは % で（縦に伸びる）", () => {
    const b = tt.columns[0].bands.find((x) => x.id === "chat-0")!;
    assert.ok(html.includes(`top:${b.top}%`));
    assert.ok(html.includes(`height:calc(${b.height}% - 2px)`));
  });
});

describe("3. 予約タブの並び（PC は上に横いっぱい・スマホはカードのまま）", () => {
  const page = read("src/app/reservations/page.tsx");
  const frame = read("src/components/TabFrame.tsx");
  const css = read("src/app/globals.css");

  test("予約タブは時間割を TabPage の top に渡し、スマホ用の日ごとのカードと予約サイト（架空）も残す", () => {
    assert.match(page, /top=\{<WeekTimetable data=\{data\} \/>\}/);
    assert.match(page, /<Ledger data=\{data\} className="ledger-cards" \/>/);
    assert.match(page, /<BookingSite data=\{data\} \/>/);
    assert.match(page, /rightFirstOnPhone/);
  });

  test("top は渡したタブだけ：承認待ち・見出しのあとに横いっぱい（ほかのタブは今までどおり main の中）", () => {
    assert.match(frame, /\{top && \(\s*<header className="page-top">\s*\{pending\}\s*\{head\}\s*\{top\}/);
    assert.match(frame, /\{!top && pending\}\s*\{!top && head\}/);
    assert.match(css, /\.page\.has-top > \.page-top \{ grid-column: 1 \/ -1;/);
  });

  test("PC（1024px 以上）は時間割を出してカードを隠す。スマホは時間割を隠し、予約チャットが上の並び（承認待ち・見出し → 右の列）", () => {
    assert.match(css, /\.ledger-timetable \{ display: none; \}/);
    const pc = css.slice(css.indexOf("/* 時間割（PC）と日ごとのカード（スマホ）の出し分け */"));
    assert.match(pc, /@media \(min-width: 1024px\) \{\s*\.ledger-timetable \{ display: block;/);
    assert.match(pc, /\.ledger\.ledger-cards \{ display: none; \}/);
    assert.match(css, /\.page\.right-first-sp > \.page-top \{ order: -2; \}/);
    assert.match(css, /\.page\.right-first-sp > \.page-right \{ order: -1; \}/);
  });

  test("時間割の列は minmax(0, 1fr) で、横にはみ出さない", () => {
    assert.match(css, /grid-template-columns: 44px repeat\(7, minmax\(0, 1fr\)\);/);
  });
});
