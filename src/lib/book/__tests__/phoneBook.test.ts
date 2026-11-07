// 直しL：予約のページ（スマホの並び・スマホの週の時間割・予約を入れる流れを段に分ける）のテスト。AI は使わない。
// - スマホ（1024 より狭い）の並び：見出し → 台帳 → 月のカレンダー → 休みの日の一覧 → 予約サイト → 予約チャット → 承認待ちの予約 → AI の手順 → くわしく。PC は今のまま
// - スマホの時間割：同じ部品（TimetableGrid）で7列・縦は営業時間だけ・30分は 24〜32px・定休日と休みの日の列・今日の丸・横に動かない
// - 帯を押すと予約の1枚・空いた所を押すと「予約を入れる」・起点の説明と「最初に戻す」は1回だけ・日ごとのカードは畳む（最初は閉じる）
// - ②の前回のメニュー・よく使うメニューの数え方・何も選んでいない時は押せない／③の判定2回は今のまま／戻った時に先を消す

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TimetableGrid } from "../../../app/reservations/TimetableGrid";
import { TabFrame } from "../../../components/TabFrame";
import { calDay } from "../../calendar";
import { comboIdOf } from "../../combo";
import { getCustomers } from "../../data/seed";
import { withHolidays } from "../../holidays";
import { loadBook, resolveChatReservations, type Reservation } from "../../reservations";
import { getMenus, getShop, getTabSwitches, type Menu } from "../../settings";
import { frequentMenus, isChoice, lastMenuChoice, yen } from "../menuPick";
import { canDecide, freshOwnerFlow, ownerFlowReduce, type OwnerFlow, type OwnerFlowAction } from "../ownerFlow";
import { dowOf, timetable } from "../timetable";
import { freshView, viewReduce, weekLabelShort } from "../weekView";

const ROOT = join(__dirname, "../../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const shop = getShop();
const menus = getMenus();
const customers = getCustomers();
const css = read("src/app/globals.css");
/** スマホの @media（max-width: 1023.98px）の塊のうち、中に want を含む物 */
const phoneBlock = (want: string) =>
  [...css.matchAll(/@media \(max-width: 1023\.98px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).find((b) => b.includes(want)) ?? "";

describe("1. スマホの予約のページの並び（PC は今のまま）", () => {
  const page = read("src/app/reservations/page.tsx");

  test("予約タブは rightMidOnPhone（予約チャットを一番上に出さない）", () => {
    assert.match(page, /<TabPage\s+tab="reservations"\s+rightMidOnPhone\s+right=\{/);
    assert.doesNotMatch(page, /rightFirstOnPhone/);
  });

  test("CSS の並べ替えでスマホの順になる：札 after-right-sp の欄だけが予約チャットの後（DOM の順はそのまま）", () => {
    const block = phoneBlock(".page.right-mid-sp");
    assert.match(block, /\.page\.right-mid-sp > \.page-main \{ display: contents; \}/);
    const order = (sel: string) => Number(block.match(new RegExp(`${sel.replace(/[.>*]/g, (c) => `\\${c}`)} \\{[^}]*order: (-?\\d+)`))?.[1]);
    const before = order(".page.right-mid-sp > .page-main > *");
    const right = order(".page.right-mid-sp > .page-right");
    const after = order(".page.right-mid-sp > .page-main > .after-right-sp");
    assert.ok(before < right && right < after, `${before} < ${right} < ${after}`);
    assert.equal(order(".page.right-mid-sp > .page-main > .tab-switch-fold"), after);

    // ページの欄の DOM の順と札から、スマホで出る順を組み立てる（同じ order の中は DOM の順）
    const marks: [string, string][] = [
      ["台帳", "<WeekTimetable"],
      ["承認待ちの予約", 'aria-labelledby="res-approvals"'],
      ["AI の手順", 'aria-labelledby="res-steps"'],
      ["月のカレンダー", 'aria-labelledby="res-month"'],
      ["休みの日の一覧", 'aria-labelledby="res-holidays"'],
      ["予約サイト", 'className="book-pair"'],
      ["くわしく", 'summary="くわしく'],
    ];
    const items = marks.map(([name, m]) => {
      const at = page.indexOf(m);
      assert.ok(at > 0, name);
      const tagStart = page.lastIndexOf("<", at);
      const tag = page.slice(tagStart, page.indexOf(">", at) + 1);
      return { name, at, after: /after-right-sp/.test(tag) };
    });
    const dom = [...items].sort((a, b) => a.at - b.at);
    const phone = [...dom.filter((x) => !x.after).map((x) => x.name), "予約チャット", ...dom.filter((x) => x.after).map((x) => x.name)];
    assert.deepEqual(phone, ["台帳", "月のカレンダー", "休みの日の一覧", "予約サイト", "予約チャット", "承認待ちの予約", "AI の手順", "くわしく"]);
    // PC は今のまま：台帳 → 承認待ち → AI の手順 → 月 → 休み → 予約サイト → くわしく（右の列に予約チャット）
    assert.deepEqual(dom.map((x) => x.name), ["台帳", "承認待ちの予約", "AI の手順", "月のカレンダー", "休みの日の一覧", "予約サイト", "くわしく"]);
  });

  const render = (extra: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(TabFrame, {
        tab: "reservations",
        baseSwitches: getTabSwitches(),
        pending: createElement("a", { className: "pending" }, "p"),
        right: createElement("p", null, "RIGHT"),
        children: [createElement("section", { key: "a", id: "a" }, "A"), createElement("section", { key: "b", id: "b", className: "after-right-sp" }, "B")],
        ...extra,
      }),
    );

  test("TabFrame の rightMidOnPhone：札 right-mid-sp を付けるだけで包まない（右の列は1つ・DOM は main の後）。渡さないタブは今のまま", () => {
    const html = render({ rightMidOnPhone: true });
    assert.match(html, /^<div class="page right-mid-sp">/);
    assert.doesNotMatch(html, /page-lead|page-rest|right-first-sp/);
    assert.match(html, /<section id="a">A<\/section><section id="b" class="after-right-sp">B<\/section>/);
    assert.equal(html.match(/RIGHT/g)?.length, 1);
    assert.match(render({}), /^<div class="page">/);
    // ほかの口と一緒なら、そちらのまま（予約タブは使わない）
    assert.doesNotMatch(render({ rightMidOnPhone: true, rightFirstOnPhone: true }), /right-mid-sp/);
  });

  test("ページの上の承認待ちの1行は今のまま（並べ替えで見出しの前）", () => {
    assert.match(read("src/components/TabFrame.tsx"), /\{!top && pending\}\s*\{!top && head\}/);
  });
});

describe("2. スマホの1週間の予約台帳（同じ部品で、見た目だけ詰める）", () => {
  const MONDAY = "2026-11-09";
  // 水曜をオーナーの休みの日に（火曜は定休日）
  const s2 = withHolidays(shop, ["2026-11-11"]);
  const today = calDay(s2, MONDAY);
  const chat = resolveChatReservations(menus, customers, [
    { id: "h1", customerId: customers[0].id, menuId: "cut", date: MONDAY, start: "11:00", status: "hold", heldAt: "2026-11-09T00:00:00Z", expiresAt: "2026-11-10T00:00:00Z" },
  ]);
  const book = loadBook(s2, menus, today, undefined, chat);
  const tt = timetable(book.week, { date: MONDAY, time: "09:00" }, { seats: s2.seats, step: s2.slotMinutes });
  const html = renderToStaticMarkup(createElement(TimetableGrid, { tt, onPick: () => {}, onOpen: () => {} }));
  const count = (re: RegExp) => (html.match(re) ?? []).length;

  test("7列が出る（列の頭は曜日と日にち。今日は丸の印）", () => {
    assert.equal(count(/class="tt-col[ "]/g), 7);
    assert.equal(count(/class="tt-day-sp"/g), 7);
    assert.deepEqual(dowOf(MONDAY), { dow: "月", dayNum: 9 });
    assert.match(html, /<div class="tt-head today"><span class="tt-day-sp" aria-hidden="true"><span class="tt-dow">月<\/span><span class="tt-dnum num">9<\/span>/);
    assert.match(css, /\.tt-head\.today \.tt-dnum \{ background: var\(--accent\); color: var\(--on-accent\); \}/);
  });

  test("縦は営業時間だけ（開店 10:00 から閉店 20:00）。1時間ごとの目盛りと30分の点線", () => {
    assert.equal(tt.from, 600);
    assert.equal(tt.to, 1200);
    assert.equal(tt.ticks.length, 11);
    assert.equal(tt.halves.length, 10);
    assert.equal(count(/class="tt-half"/g), 70);
    assert.match(phoneBlock(".tt-half"), /\.tt-half \{ display: block;[^}]*border-top: 1px dotted/);
  });

  test("定休日（火）と休みの日（水）の列は灰色。休みの日は列の頭の色も分ける", () => {
    const tue = tt.columns.find((c) => c.date === "2026-11-10")!;
    const wed = tt.columns.find((c) => c.date === "2026-11-11")!;
    assert.equal(tue.open, false);
    assert.equal(tue.holiday, false);
    assert.equal(wed.open, false);
    assert.equal(wed.holiday, true);
    assert.match(html, /class="tt-col closed" aria-label="11\/10（火）：お休み"/);
    assert.match(html, /class="tt-col closed holiday" aria-label="11\/11（水）：休みの日"/);
    assert.match(css, /\.tt-head\.holiday \{ background:/);
    assert.match(css, /\.tt-col\.closed \{/);
  });

  test("スマホの CSS：7列が幅に収まる（min-width 0・横に動かない）・30分の高さ（空いたマスの高さ）は 44px 以上", () => {
    const b = phoneBlock("--tt-hour");
    assert.match(b, /grid-template-columns: \d+px repeat\(7, minmax\(0, 1fr\)\);/);
    assert.match(b, /min-width: 0;/);
    assert.match(b, /\.tt-wrap \{ overflow-x: hidden; \}/);
    const hour = Number(/--tt-hour: (\d+)px/.exec(b)?.[1]);
    assert.ok(hour / 2 >= 44, String(hour));
    // 列の頭の件数と埋まりの棒・帯の中の時刻とメニュー名と札は、スマホでははぶく（名字は残す）
    assert.match(b, /\.tt-head \.tt-date, \.tt-head \.tt-count, \.tt-head \.minibar, \.tt-head \.tt-off-label \{ display: none; \}/);
    assert.match(b, /\.tt-band \.tt-band-top, \.tt-band \.tt-band-menu, \.tt-band\.short \.tt-band-menu \{ display: none; \}/);
    assert.doesNotMatch(b, /\.customer[^{]*\{[^}]*display: none/);
    // 確定と仮押さえの違い（点線のしま）は残す：仮押さえの帯の決まりはスマホで消さない
    assert.doesNotMatch(b, /\.tt-band\.hold \{[^}]*border-style: solid/);
    // PC は今のまま（620px の時間割と箱の中の横の動き）
    assert.match(css, /\.tt \{\s*--tt-hour: 84px;[\s\S]*?min-width: 620px;/);
    assert.match(css, /\.tt-day-sp, \.tt-half, \.wk-sp \{ display: none; \}/);
  });

  test("帯の中に「名字＋様」。仮押さえは点線（hold）のまま。同じ時間に受ける人数が2人以上なら横に分ける（今のまま）", () => {
    assert.match(html, /class="tt-band hold [^"]*openable"/);
    assert.match(html, new RegExp(`<span class="customer">${customers[0].surname} 様</span>`));
    const two = timetable(
      [{ ...book.week[0], reservations: [...book.week[0].reservations, ...resolveChatReservations(menus, customers, [{ id: "h2", customerId: customers[1].id, menuId: "cut", date: MONDAY, start: "11:00", status: "hold", heldAt: "x", expiresAt: "y" }])] }],
      undefined,
    );
    const lanes = two.columns[0].bands.filter((b) => b.start === "11:00").map((b) => [b.lane, b.lanes]);
    assert.deepEqual(lanes, [[0, 2], [1, 2]]);
  });

  test("帯を押すと予約の1枚（detail）・空いたマスを押すと「予約を入れる」（open）。押せる所は30分のマス", () => {
    const wt = read("src/app/reservations/WeekTimetable.tsx");
    assert.match(wt, /onPick=\{\(date, start\) => view\.act\(\{ kind: "open", target: \{ date, start \} \}\)\}/);
    assert.match(wt, /onOpen=\{\(id\) => view\.act\(\{ kind: "detail", id \}\)\}/);
    const range = { first: "2026-11-01", last: "2026-12-31", aheadLast: "2026-12-31" };
    const opened = viewReduce(freshView("k"), { kind: "open", target: { date: MONDAY, start: "15:00" } }, { todayDate: MONDAY, range });
    assert.deepEqual(opened.sheet, { date: MONDAY, start: "15:00" });
    assert.equal(viewReduce(opened, { kind: "detail", id: "h1" }, { todayDate: MONDAY, range }).detail, "h1");
    // 空いたマス（10:00 は最初の状態のカット・11:00〜12:00 は仮押さえで埋まる。12:00 は空き）
    const mon = tt.columns[0];
    assert.ok(mon.picks.some((p) => p.start === "12:00"));
    assert.ok(!mon.picks.some((p) => p.start === "10:00"));
    assert.ok(!mon.picks.some((p) => p.start === "11:00" || p.start === "11:30"));
    assert.ok(mon.picks.every((p) => Math.abs(p.height - 5) < 0.01), "30分 = 600分の5%");
    assert.match(css, /\.tt-pick \{\s*position: absolute;\s*left: 0;\s*right: 0;/);
  });

  test("週の移動はスマホで「< 先週」「11月2日〜8日」「来週 >」（同じ動き）", () => {
    assert.equal(weekLabelShort("2026-11-02"), "11月2日〜8日");
    assert.equal(weekLabelShort("2026-10-29"), "10月29日〜11月4日");
    assert.equal(weekLabelShort("2026-12-29"), "12月29日〜1月4日");
    const nav = read("src/app/reservations/LedgerView.tsx");
    assert.match(nav, /&lt; 先週/);
    assert.match(nav, /来週 &gt;/);
    assert.match(nav, /<span className="wk-sp">\{v\.shortLabel\}<\/span>/);
    assert.match(phoneBlock(".wk-sp"), /\.wk-pc \{ display: none; \}/);
  });

  test("起点の説明・「最初に戻す」・確かめの一覧・凡例・週の動かし方は1回だけ（時間割の箱に。日ごとのカードには出さない）", () => {
    const wt = read("src/app/reservations/WeekTimetable.tsx");
    for (const x of ["<LedgerNotes", "<LedgerChecks", "<LedgerReset", "<WeekNav"]) assert.equal(wt.split(x).length - 1, 1, x);
    const ledger = read("src/app/reservations/Ledger.tsx");
    const days = ledger.slice(ledger.indexOf("export function LedgerDays"), ledger.indexOf("/** 1日の予約の行"));
    assert.doesNotMatch(days, /<LedgerNotes|<LedgerChecks|<LedgerReset|<WeekNav|<h2/);
    const page = read("src/app/reservations/page.tsx");
    assert.doesNotMatch(page, /<Ledger\b|<LedgerDays|<LedgerReset|<ResetBook/);
  });

  test("日ごとのカードは、スマホだけ時間割の下に「日ごとの一覧で見る」として畳む（最初は閉じる）。PC は出さない", () => {
    const wt = read("src/app/reservations/WeekTimetable.tsx");
    assert.match(wt, /<details className="fold ledger-cards-fold">\s*<summary>日ごとの一覧で見る<\/summary>\s*<LedgerDays data=\{data\} \/>/);
    assert.doesNotMatch(wt, /<details[^>]*\bopen\b/);
    assert.ok(wt.indexOf("tt-wrap") < wt.indexOf("ledger-cards-fold"));
    assert.match(css, /@media \(min-width: 1024px\) \{\s*\.ledger-cards-fold \{ display: none; \}/);
  });
});

describe("② メニューを選ぶ：前回のメニュー・よく使うメニュー", () => {
  const TODAY = "2026-11-07";
  const res = (id: string, menuId: string, date: string, status: "confirmed" | "hold" = "confirmed"): Reservation => {
    const r = resolveChatReservations(menus, customers, [{ id, customerId: "c01", menuId, date, start: "10:00", status, heldAt: "x", expiresAt: "y" }])[0];
    assert.ok(r, menuId);
    return r;
  };

  test("前回のメニュー：lastVisitOf のメニュー。組み合わせは組み合わせのまま1行・記録なし・いま無いメニューは出さない", () => {
    assert.equal(lastMenuChoice(menus, { date: "2026-10-01", menuId: "cut" })?.menu.name, "カット");
    assert.equal(lastMenuChoice(menus, { date: "2026-10-01", menuId: "cut_color" })?.id, "cut_color");
    const combo = lastMenuChoice(menus, { date: "2026-10-01", menuId: "cut+headspa" });
    assert.equal(combo?.id, "cut+headspa");
    assert.equal(combo?.menu.name, "カット＋ヘッドスパ");
    assert.equal(combo?.menu.minutes, 90);
    assert.equal(lastMenuChoice(menus, null), null);
    assert.equal(lastMenuChoice(menus, { date: "2026-10-01", menuId: "gone" }), null);
    assert.equal(lastMenuChoice(menus.filter((m) => m.id !== "headspa"), { date: "2026-10-01", menuId: "cut+headspa" }), null);
  });

  test("よく使うメニュー：今日より前の確定だけ（仮押さえ・今日・これから先は数えない）。組み合わせは1つに数える。多い順・同じ数は並び順・最大5つ", () => {
    const all = [
      res("a", "color", "2026-11-01"),
      res("b", "color", "2026-11-02"),
      res("c", "cut", "2026-11-03"),
      res("d", "cut+headspa", "2026-11-04"),
      res("e", "cut+headspa", "2026-11-05"),
      res("f", "perm", "2026-11-06", "hold"), // 仮押さえは数えない
      res("g", "perm", TODAY), // 今日は数えない
      res("h", "perm", "2026-11-20"), // これから先は数えない
      res("i", "straight", "2026-10-01"),
      res("j", "headspa", "2026-10-02"),
      res("k", "cut_color", "2026-10-03"),
    ];
    const f = frequentMenus(all, TODAY, menus);
    // color 2・cut+headspa 2（同じ数は並び順：設定にある color が先、設定に無い組み合わせは後ろ）・その後は1回ずつ並び順
    assert.deepEqual(f.map((x) => [x.id, x.count]), [["color", 2], ["cut+headspa", 2], ["cut", 1], ["cut_color", 1], ["straight", 1]]);
    assert.ok(!f.some((x) => x.id === "perm"), "perm は数えない");
    assert.equal(f.length, 5, "最大5つ（headspa は6つ目）");
    // 1回も無いメニューは出さない・いま無い（消した）メニューは出さない
    assert.deepEqual(frequentMenus([], TODAY, menus), []);
    assert.ok(!frequentMenus(all, TODAY, menus.filter((m) => m.id !== "color")).some((x) => x.id === "color"));
    // 取り消した予約は台帳（book.all）から外れるので数えない：画面は book.all を渡す
    assert.match(read("src/app/reservations/OwnerBookSheet.tsx"), /frequentMenus\(book\.all, book\.now\.date, menus\)/);
  });

  test("最初の状態の台帳（過去の確定 4件）でも、よく使うメニューが出る", () => {
    const b = loadBook(shop, menus, calDay(shop, "2026-11-09"));
    const f = frequentMenus(b.all, "2026-11-09", menus);
    assert.ok(f.length > 0);
    assert.equal(f[0].id, "color");
  });

  test("一覧の1行：色の印・名前・値段（円）・時間（分）。メニューは今の入口（book.data.menus）から読み、id を決め打ちしない", () => {
    assert.equal(yen(4800), "4,800円");
    const sheet = read("src/app/reservations/OwnerBookSheet.tsx");
    assert.match(sheet, /const menus = book\.data\.menus;/);
    assert.match(sheet, /className=\{`obs-menu \$\{menuColorClass\(m\)\}/);
    assert.match(sheet, /\{yen\(m\.price\)\}/);
    assert.match(sheet, /\{m\.minutes\}分/);
    assert.match(sheet, /menus\.map\(\(m\) => line\(m, selected\.includes\(m\.id\)/);
    assert.doesNotMatch(sheet, /"cut"|"color"|"perm"|"headspa"|"straight"/);
    // オーナーが足したメニュー（直しJ）も全部のメニューに出て、前回・よく使うにも数えられる
    const added: Menu[] = [...menus, { id: "m_new", name: "トリートメント", minutes: 30, price: 2500 }];
    assert.equal(lastMenuChoice(added, { date: "2026-10-01", menuId: "m_new" })?.menu.name, "トリートメント");
    assert.equal(comboIdOf(added, ["cut", "m_new"]), "cut+m_new");
  });

  test("前回・よく使うの行は、押すとそれだけを選ぶ（同じ物なら外す）", () => {
    assert.equal(isChoice(menus, ["cut", "color"], "cut_color"), true);
    assert.equal(isChoice(menus, ["cut"], "cut+headspa"), false);
    assert.equal(isChoice(menus, [], "cut"), false);
    assert.match(read("src/app/reservations/OwnerBookSheet.tsx"), /go\(\{ kind: "setMenus", ids: isChoice\(menus, menuIds, c\.id\) \? \[\] : idsOfChoice\(c\.id\) \}\)/);
  });
});

describe("3. 段の流れ（src/lib/book/ownerFlow.ts）", () => {
  const target = { start: "15:00" };
  const run = (acts: OwnerFlowAction[], from: OwnerFlow = freshOwnerFlow("15:00")) => acts.reduce<OwnerFlow | null>((s, a) => (s ? ownerFlowReduce(s, a, target) : s), from);

  test("枠を押すと最初は①。お客様を押すと②・メニューを選んで「メニューを決める」で③", () => {
    const s0 = freshOwnerFlow("15:00");
    assert.equal(s0.stage, "customer");
    const s1 = run([{ kind: "customer", id: "c01" }])!;
    assert.equal(s1.stage, "menu");
    assert.equal(s1.customerId, "c01");
    const s2 = run([{ kind: "customer", id: "c01" }, { kind: "toggleMenu", id: "cut" }, { kind: "toggleMenu", id: "headspa" }, { kind: "decide" }])!;
    assert.equal(s2.stage, "confirm");
    assert.deepEqual(s2.menuIds, ["cut", "headspa"]);
  });

  test("何も選んでいない時は「メニューを決める」を押せない（押しても③へ進まない）", () => {
    const s = run([{ kind: "customer", id: "c01" }])!;
    assert.equal(canDecide(s), false);
    assert.equal(ownerFlowReduce(s, { kind: "decide" }, target)!.stage, "menu");
    const s2 = run([{ kind: "toggleMenu", id: "cut" }, { kind: "toggleMenu", id: "cut" }], s)!;
    assert.equal(canDecide(s2), false, "選んで外した");
    assert.match(read("src/app/reservations/OwnerBookSheet.tsx"), /onClick=\{\(\) => go\(\{ kind: "decide" \}\)\} disabled=\{!canDecide\(flow\)\}/);
  });

  test("「戻る」：③ → ② → ①、①では閉じる（null）。戻るだけでは選んだ物を消さない", () => {
    const s = run([{ kind: "customer", id: "c01" }, { kind: "toggleMenu", id: "cut" }, { kind: "decide" }, { kind: "start", time: "16:00" }])!;
    const back1 = ownerFlowReduce(s, { kind: "back" }, target)!;
    assert.equal(back1.stage, "menu");
    assert.deepEqual(back1.menuIds, ["cut"]);
    assert.equal(back1.start, "16:00");
    const back2 = ownerFlowReduce(back1, { kind: "back" }, target)!;
    assert.equal(back2.stage, "customer");
    assert.equal(back2.customerId, "c01");
    assert.equal(ownerFlowReduce(back2, { kind: "back" }, target), null);
    assert.match(read("src/app/reservations/OwnerBookSheet.tsx"), /if \(next === null\) return onClose\(\);/);
  });

  test("戻って選び直した時は、選び直した所から先を消す（違うお客様 → メニューと時刻。メニュー → 時刻と確かめの印）", () => {
    const s = run([{ kind: "customer", id: "c01" }, { kind: "toggleMenu", id: "cut" }, { kind: "decide" }, { kind: "start", time: "16:00" }, { kind: "asked", keys: ["r1"], note: "n" }])!;
    assert.deepEqual(s.asked, ["r1"]);
    // ①まで戻って違うお客様
    const other = run([{ kind: "back" }, { kind: "back" }, { kind: "customer", id: "c02" }], s)!;
    assert.equal(other.stage, "menu");
    assert.deepEqual(other.menuIds, []);
    assert.equal(other.start, "15:00");
    assert.equal(other.asked, null);
    // 同じお客様を押しただけなら消さない
    const same = run([{ kind: "back" }, { kind: "back" }, { kind: "customer", id: "c01" }], s)!;
    assert.deepEqual(same.menuIds, ["cut"]);
    // ②まで戻ってメニューを選び直す → ③で変えた時刻と確かめの印を消す
    const menu = run([{ kind: "back" }, { kind: "toggleMenu", id: "headspa" }], s)!;
    assert.deepEqual(menu.menuIds, ["cut", "headspa"]);
    assert.equal(menu.start, "15:00");
    assert.equal(menu.asked, null);
    // ③で時刻を変える → 確かめの印を消す（今の reset と同じ）
    const t = ownerFlowReduce(s, { kind: "start", time: "17:00" }, target)!;
    assert.equal(t.asked, null);
    assert.equal(t.note, null);
  });

  test("③ の確かめは今のまま：入れる前（useMemo の ownerCheck）と保存の直前（book.update の中の ownerBook）の2回・人のボタンだけ", () => {
    const sheet = read("src/app/reservations/OwnerBookSheet.tsx");
    assert.match(sheet, /ownerCheck\(slot, \{ menuId, date: target\.date, start \}\)/);
    assert.match(sheet, /const w = book\.update\(\(s\) => \{\s*out = ownerBook\(s, \{ \.\.\.ctx, startedEpoch: \{ epoch: openedEpoch \} \}/);
    assert.match(sheet, /if \(!e\.nativeEvent\.isTrusted/);
    assert.match(sheet, /if \(o\.ok && !w\.ok\) return go\(\{ kind: "note", note: SAVE_FAILED_MESSAGE \}\);/);
    assert.match(sheet, /writeJournal\(\.\.\.o\.journal\);/);
    // 「入れる」は③の段だけ
    const confirm = sheet.indexOf('{stage === "confirm" && (');
    assert.ok(confirm > 0 && sheet.indexOf("onClick={press}") > confirm);
    assert.equal(sheet.split("onClick={press}").length - 1, 1);
  });

  test("スマホの右の索引（50音の行）は1つ 44×44px 以上。PC の索引の大きさは今のまま", () => {
    const b = phoneBlock(".obs-kana-btn");
    assert.match(b, /\.obs-kana-btn \{ min-width: 44px; min-height: 44px;/);
    assert.match(b, /\.obs-kana-wrap \{ grid-template-columns: minmax\(0, 1fr\) 44px; \}/);
    // PC（どの @media の外）は 32px の列・高さ 30px のまま
    assert.match(css, /^\.obs-kana-wrap \{ display: grid; grid-template-columns: minmax\(0, 1fr\) 32px;/m);
    assert.match(css, /^\.obs-kana-btn \{[^}]*min-height: 30px;/m);
  });

  test("③のメニューの1行は1つのまとまり（「カット＋カラー（120分・10,800円）」。かっこの内側に空きを作らない）", () => {
    const sheet = read("src/app/reservations/OwnerBookSheet.tsx");
    assert.match(sheet, /<span>\s*\{menu\.name\}\s*<span className="obs-nowrap">\{`（\$\{menu\.minutes\}分・\$\{yen\(menu\.price\)\}）`\}<\/span>\s*<\/span>/);
    assert.match(css, /\.obs-nowrap \{ white-space: nowrap; \}/);
    const m = { name: "カット＋カラー", minutes: 120, price: 10800 };
    assert.equal(`${m.name}（${m.minutes}分・${yen(m.price)}）`, "カット＋カラー（120分・10,800円）");
  });

  test("スマホは画面いっぱいの1枚（予約を入れる1枚だけ。予約を押して開く1枚は今のまま）", () => {
    assert.match(phoneBlock(".owner-sheet"), /\.sheet\.owner-sheet \{ height: 100vh; height: 100dvh; max-height: none;/);
    assert.match(read("src/app/reservations/OwnerBookSheet.tsx"), /className="sheet owner-sheet"/);
    assert.doesNotMatch(read("src/app/reservations/ReservationSheet.tsx"), /owner-sheet/);
  });
});
