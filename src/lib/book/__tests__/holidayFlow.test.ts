// 月のカレンダーから休みの日を決める（直しG。docs/SPEC.md §1.3.1・§4.7）のテスト。Claude と LINE は呼ばない。
// - 「休みを決める」の入・切で、日を押した時の動きが変わる（切は台帳の週へ・入は休みにする／戻す）
// - 最初は切。開き直し（新しく作る）・「翌日へ」・「最初に戻す」で切に戻る
// - 休みにできる範囲は book.now.date を含めて56日（台帳で見られる範囲とは別）。その外と設定の定休日は押せない。オーナーの休みは押すと戻す
// - 予約がある日は一覧を出し「それでも休みにする」の時だけ休みにする（ToDo・日誌・書けなかった時の文は今のまま）
// - 「翌日へ」「最初に戻す」で開いている一覧が閉じる。一覧から戻す。「最初に戻す」で休みが消える
// - 流れは1か所（holidayFlow.ts と HolidayFlow.tsx）で、カレンダーと一覧の両方が使う

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SAVE_FAILED_MESSAGE, type BrowserWrite } from "../../browser";
import { addDays } from "../../calendar";
import { HOLIDAYS_KEY, holidayChoices, reservationsOn, withHolidays } from "../../holidays";
import { resetAllWrites } from "../../reset";
import { calDay } from "../../calendar";
import { getBookData } from "../data";
import {
  applyHoliday,
  freshHolidayFlow,
  holidayDay,
  holidayPress,
  holidayWindow,
  monthDayAction,
  syncHolidayFlow,
  type HolidayDeps,
} from "../holidayFlow";
import { ledgerView } from "../site";
import { emptyBook, type BookState } from "../state";
import { freshView, inRange, syncView, viewKey, viewRange, viewReduce } from "../weekView";

const ROOT = join(__dirname, "../../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const data = getBookData();
const shop = data.shop;
// 水曜の朝（開店前）。11/10（火）は定休日。11/6（金）には大橋様・加藤様の予約
const NOW = new Date("2026-11-04T08:30:00+09:00");
const start = emptyBook("2026-11-04");
const v0 = ledgerView(data, start, NOW);
const NOW_DATE = v0.clock.now.date;
const HOL = "2026-11-06";
const FREE = "2026-11-19";

/** 書く所の置きかえ（ブラウザの代わりに配列。書けないようにもできる） */
function fakeDeps(opts: { holidays?: string[]; holidayFails?: boolean; todoFails?: boolean } = {}) {
  const holidays = [...(opts.holidays ?? [])];
  let book: BookState = start;
  const journal: string[] = [];
  let holidayWrites = 0;
  let todoWrites = 0;
  const fail: BrowserWrite = { ok: false, why: "full" };
  const deps: HolidayDeps = {
    setHoliday: (date, on) => {
      if (on === holidays.includes(date)) return null;
      holidayWrites++;
      if (opts.holidayFails) return fail;
      if (on) holidays.push(date);
      else holidays.splice(holidays.indexOf(date), 1);
      return { ok: true };
    },
    update: (fn) => {
      todoWrites++;
      if (opts.todoFails) return fail;
      book = fn(book);
      return { ok: true };
    },
    journal: (e) => journal.push(`${e.who}：${e.text}`),
  };
  return { deps, holidays, journal, get book() { return book; }, get holidayWrites() { return holidayWrites; }, get todoWrites() { return todoWrites; } };
}

const press = (dates: string[], date: string, from: "calendar" | "list" = "calendar", epoch?: string) =>
  holidayPress({ shop, nowDate: NOW_DATE, dates, all: v0.all, date, epoch }, from);

describe("1. 「休みを決める」の切り替え：最初は切。開き直し・「翌日へ」・「最初に戻す」で切", () => {
  const range = viewRange(shop, { todayDate: v0.clock.today.date, nowDate: NOW_DATE, all: v0.all });
  const ctx = { todayDate: v0.clock.today.date, range };

  test("最初（開き直した時に新しく作る形）は切。入れると入。週・月は動かさない", () => {
    const s = freshView(viewKey(undefined, 0));
    assert.equal(s.holidayMode, false);
    const on = viewReduce(s, { kind: "holidayMode", on: true }, ctx);
    assert.equal(on.holidayMode, true);
    assert.deepEqual([on.start, on.month], [s.start, s.month]);
    assert.equal(viewReduce(on, { kind: "holidayMode", on: false }, ctx).holidayMode, false);
  });

  test("「翌日へ」（dayOffset が変わる）と「最初に戻す」（epoch が変わる）で切に戻る。同じ印なら入のまま", () => {
    const on = viewReduce(freshView(viewKey(undefined, 0)), { kind: "holidayMode", on: true }, ctx);
    assert.equal(syncView(on, viewKey(undefined, 0)).holidayMode, true);
    assert.equal(syncView(on, viewKey(undefined, 1)).holidayMode, false);
    assert.equal(syncView(on, viewKey("e2", 0)).holidayMode, false);
  });

  test("画面：切り替えは共通の親（LedgerView）が持ち、ブラウザには残さない。カレンダーは useState を持たない", () => {
    const p = read("src/app/reservations/LedgerView.tsx");
    assert.match(p, /holidayMode: view\.holidayMode === true/);
    assert.match(p, /useState<ViewState>\(\(\) => freshView\(key\)\)/);
    const m = read("src/app/reservations/MonthCalendar.tsx");
    assert.doesNotMatch(m, /useState|writeBrowser|localStorage/);
    assert.match(m, /view\.act\(\{ kind: "holidayMode", on: e\.target\.checked \}\)/);
    assert.match(m, /role="switch"/);
    assert.match(m, /休みを決める/);
  });
});

describe("2. 入・切で、日を押した時の動きが変わる", () => {
  const range = viewRange(shop, { todayDate: v0.clock.today.date, nowDate: NOW_DATE, all: v0.all });
  const act = (mode: boolean, date: string, dates: string[] = []) =>
    monthDayAction(mode, { shop, nowDate: NOW_DATE, dates, date, inViewRange: inRange(date, range) });

  test("切：その日から7日の台帳へ（台帳で見られる範囲の中なら押せる。定休日・過ぎた日も見られる）", () => {
    assert.deepEqual(act(false, FREE), { act: "week", enabled: true });
    assert.deepEqual(act(false, "2026-11-10"), { act: "week", enabled: true });
    assert.deepEqual(act(false, "2026-10-20"), { act: "week", enabled: true });
    assert.deepEqual(act(false, "2027-02-01"), { act: "week", enabled: false });
  });

  test("入：休みにする・戻す（営業日は off・オーナーの休みは on。どちらも押せる）", () => {
    assert.deepEqual(act(true, FREE), { act: "holiday", day: "off", enabled: true });
    assert.deepEqual(act(true, FREE, [FREE]), { act: "holiday", day: "on", enabled: true });
  });

  test("画面：入なら休みの流れ（flow.press）・切なら台帳の週（view.pickDay）。押せない日は disabled", () => {
    const m = read("src/app/reservations/MonthCalendar.tsx");
    assert.match(m, /monthDayAction\(picking,/);
    assert.match(m, /a\.act === "holiday" \? flow\.press\(e, c\.date, "calendar"\) : view\.pickDay\(c\.date\)/);
    assert.match(m, /disabled=\{!a\.enabled\}/);
  });
});

describe("3. 休みにできる範囲（今日を含む56日）・定休日・上限", () => {
  test("範囲は book.now.date から55日後まで（今の欄 holidayChoices と同じ日）。台帳で見られる範囲とは別", () => {
    const w = holidayWindow(shop, NOW_DATE);
    assert.deepEqual([w.first, w.last, w.days], ["2026-11-04", "2026-12-29", 56]);
    const choices = holidayChoices(shop, calDay(shop, NOW_DATE));
    assert.deepEqual([choices[0].date, choices[choices.length - 1].date], [w.first, w.last]);
    // 台帳で見られる範囲は4週前から（もっと広い）。過ぎた日は台帳では見られても、休みにはできない
    const range = viewRange(shop, { todayDate: v0.clock.today.date, nowDate: NOW_DATE, all: v0.all });
    assert.ok(range.first < w.first);
    assert.equal(holidayDay(shop, NOW_DATE, [], "2026-11-03"), "outside");
    assert.equal(holidayDay(shop, NOW_DATE, [], "2026-12-30"), "outside");
    assert.equal(holidayDay(shop, NOW_DATE, [], "2026-12-28"), "off", "範囲の最後の営業日（12/29 は火曜の定休日）");
    assert.equal(holidayDay(shop, NOW_DATE, [], "2026-12-29"), "weekly");
    assert.equal(holidayDay(shop, NOW_DATE, [], NOW_DATE), "off");
    // 台帳で見られる範囲の先に予約があって範囲が伸びても、休みにできる範囲は伸ばさない
    const wide = viewRange(shop, { todayDate: v0.clock.today.date, nowDate: NOW_DATE, all: [{ date: "2027-01-20" }] });
    assert.equal(wide.last, "2027-01-20");
    assert.equal(monthDayAction(true, { shop, nowDate: NOW_DATE, dates: [], date: "2027-01-15", inViewRange: inRange("2027-01-15", wide) }).enabled, false);
  });

  test("「翌日へ」で book.now.date が進めば、範囲もいっしょに進む", () => {
    const v1 = ledgerView(data, { ...start, dayOffset: 1 }, NOW);
    const w = holidayWindow(shop, v1.clock.now.date);
    assert.equal(w.first, v1.clock.now.date);
    assert.equal(w.last, addDays(v1.clock.now.date, 55));
  });

  test("範囲の外と設定の定休日（曜日と closedDates）は押せない。押しても書かない", () => {
    assert.equal(holidayDay(shop, NOW_DATE, [], "2026-11-10"), "weekly");
    assert.equal(holidayDay({ ...shop, closedDates: [FREE] }, NOW_DATE, [], FREE), "weekly");
    assert.equal(monthDayAction(true, { shop, nowDate: NOW_DATE, dates: [], date: "2026-11-10", inViewRange: true }).enabled, false);
    assert.equal(press([], "2026-11-10").kind, "blocked");
    assert.equal(press([], "2026-12-30").kind, "blocked");
    assert.match((press([], "2026-12-30") as { note: string }).note, /今日から56日（12\/29（火）まで）/);
  });

  test("オーナーの休みの日は押すと戻す（休みを重ねた店で見ても「定休日」にしない）", () => {
    const s = withHolidays(shop, [FREE]);
    assert.equal(holidayDay(s, NOW_DATE, [FREE], FREE), "on");
    assert.deepEqual(holidayPress({ shop: s, nowDate: NOW_DATE, dates: [FREE], all: v0.all, date: FREE }, "calendar"), { kind: "apply", on: false });
  });

  test("上限（holidayLimits.max = 60）に届いたら、新しくは休みにしない（戻すのはできる）", () => {
    const many = Array.from({ length: 60 }, (_, i) => addDays("2027-03-01", i));
    const p = press(many, FREE);
    assert.equal(p.kind, "blocked");
    assert.match((p as { note: string }).note, /休みの日は 60日までです/);
    assert.deepEqual(press([...many.slice(1), FREE], FREE), { kind: "apply", on: false });
  });
});

describe("4. 予約がある日：一覧を出し、「それでも休みにする」の時だけ休みにする", () => {
  const all = v0.all;

  test("予約（確定・仮押さえ）がある日は、まず一覧（その時の印つき）。予約の無い日はそのまま休みに", () => {
    const p = press([], HOL, "calendar", "e1");
    assert.equal(p.kind, "ask");
    if (p.kind === "ask") {
      assert.deepEqual(p.ask.list.map((r) => r.id), ["r05", "r06"]);
      assert.equal(p.ask.epoch, "e1");
      assert.deepEqual(p.ask.list, reservationsOn(all, HOL));
    }
    assert.deepEqual(press([], FREE), { kind: "apply", on: true });
  });

  test("「それでも休みにする」：休みにして、お客様ごとに ToDo「別の日時を案内」・日誌に1行（今と同じ文）", () => {
    const f = fakeDeps();
    const ask = { date: HOL, list: reservationsOn(all, HOL), epoch: undefined };
    const out = applyHoliday(f.deps, { shop, state: start, dates: [], date: HOL, on: true, list: ask.list, ask, nowIso: NOW.toISOString(), todayDate: "2026-11-04" });
    assert.equal(out.close, true);
    assert.equal(out.note, "11/6（金）を休みの日にしました。予約 2件は残し、ToDo を2件足しました");
    assert.deepEqual(f.holidays, [HOL]);
    assert.deepEqual(
      f.book.todos.map((t) => t.title),
      ["大橋様に別の日時を案内（11/6（金） 10:30 パーマの代わり）", "加藤様に別の日時を案内（11/6（金） 16:00 カットの代わり）"],
    );
    assert.equal(f.journal.length, 1);
    assert.match(f.journal[0], /^オーナー：休みの日にした：11\/6（金）.*予約 2件は消さずに残し/);
  });

  test("一覧を出した後に「最初に戻す」が押されていたら、その一覧は使わない（書かない・日誌も無し）", () => {
    const f = fakeDeps();
    const ask = { date: HOL, list: reservationsOn(all, HOL), epoch: "old" };
    const out = applyHoliday(f.deps, { shop, state: { epoch: "new" }, dates: [], date: HOL, on: true, list: ask.list, ask, nowIso: NOW.toISOString(), todayDate: "2026-11-04" });
    assert.equal(out.close, true);
    assert.match(out.note ?? "", /最初に戻したので、さっきの一覧は使いません/);
    assert.equal(f.holidayWrites, 0);
    assert.equal(f.journal.length, 0);
  });

  test("書けなかった時：「休みにした」と言わず、一覧は残す（日誌・ToDo も無し）。もう一度押せば書け、日誌は1回だけ", () => {
    const f = fakeDeps({ holidayFails: true });
    const ask = { date: HOL, list: reservationsOn(all, HOL) };
    const input = { shop, state: start, dates: [], date: HOL, on: true, list: ask.list, ask, nowIso: NOW.toISOString(), todayDate: "2026-11-04" };
    const out = applyHoliday(f.deps, input);
    assert.deepEqual(out, { close: false, note: SAVE_FAILED_MESSAGE });
    assert.equal(f.todoWrites, 0);
    assert.equal(f.journal.length, 0);
    const g = fakeDeps();
    assert.equal(applyHoliday(g.deps, input).close, true);
    assert.equal(g.journal.length, 1);
  });

  test("ToDo だけ書けなかった時は、休みにしたと言い、ToDo は手で足すよう伝える（今と同じ）", () => {
    const f = fakeDeps({ todoFails: true });
    const ask = { date: HOL, list: reservationsOn(all, HOL) };
    const out = applyHoliday(f.deps, { shop, state: start, dates: [], date: HOL, on: true, list: ask.list, ask, nowIso: NOW.toISOString(), todayDate: "2026-11-04" });
    assert.match(out.note ?? "", /ToDo を0件足しました（ToDo はブラウザに保存できませんでした。手で足してください）/);
    assert.equal(f.journal.length, 1);
  });

  test("画面：一覧は「それでも休みにする」「やめる」。人が押した時だけ（isTrusted）", () => {
    const p = read("src/app/reservations/HolidayFlow.tsx");
    assert.match(p, /それでも休みにする/);
    assert.match(p, /やめる/);
    assert.match(p, /if \(p\.kind === "ask"\) return setRaw/);
    assert.match(p, /if \(!e\.nativeEvent\.isTrusted\) return;/);
    assert.match(p, /if \(!e\.nativeEvent\.isTrusted \|\| !flow\.ask\) return;/);
  });
});

describe("5. 「翌日へ」「最初に戻す」で一覧が閉じる", () => {
  const opened = { ...freshHolidayFlow(viewKey(undefined, 0)), ask: { date: HOL, list: reservationsOn(v0.all, HOL) }, note: { place: "calendar" as const, text: "x" } };

  test("同じ印なら開いたまま。「翌日へ」（dayOffset）・「最初に戻す」（epoch）で閉じ、知らせも消える", () => {
    assert.equal(syncHolidayFlow(opened, viewKey(undefined, 0)), opened);
    for (const key of [viewKey(undefined, 1), viewKey("e2", 0)]) {
      const s = syncHolidayFlow(opened, key);
      assert.equal(s.ask, null);
      assert.equal(s.note, null);
      assert.equal(s.key, key);
    }
  });

  test("画面：流れの親は viewKey（book.state.epoch と book.dayOffset）で閉じる。切り替えを切った時も閉じる", () => {
    const p = read("src/app/reservations/HolidayFlow.tsx");
    assert.match(p, /viewKey\(book\.state\.epoch, book\.dayOffset\)/);
    assert.match(p, /const flow = syncHolidayFlow\(raw, key\);/);
    assert.match(read("src/app/reservations/MonthCalendar.tsx"), /if \(!e\.target\.checked\) flow\.cancel\(\);/);
  });
});

describe("6. 休みの日の一覧から戻す・「最初に戻す」で消える", () => {
  test("一覧からは戻すだけ（休みの日でない日は何もしない）。戻すと日誌に1行。足した ToDo は消さない", () => {
    assert.deepEqual(press([FREE], FREE, "list"), { kind: "apply", on: false });
    assert.equal(press([], FREE, "list").kind, "blocked");
    // 範囲の外になった休みの日（「翌日へ」で過ぎた日）も、一覧からは戻せる
    assert.deepEqual(press(["2026-11-01"], "2026-11-01", "list"), { kind: "apply", on: false });
    const f = fakeDeps({ holidays: [HOL] });
    const out = applyHoliday(f.deps, { shop, state: start, dates: [HOL], date: HOL, on: false, list: [], nowIso: NOW.toISOString(), todayDate: "2026-11-04" });
    assert.deepEqual(out, { close: true, note: "11/6（金）を戻しました（また予約を受けられます）" });
    assert.deepEqual(f.holidays, []);
    assert.equal(f.todoWrites, 0, "ToDo は触らない");
    assert.match(f.journal[0], /休みの日を戻した：11\/6（金）/);
  });

  test("画面：日付の順に並べ、それぞれ「戻す」。空の時と、ToDo が残る1行", () => {
    const p = read("src/app/reservations/HolidayList.tsx");
    assert.match(p, /f\.dates\.map/);
    assert.match(p, /f\.press\(e, date, "list"\)/);
    assert.match(p, />\s*戻す\s*</);
    assert.match(p, /カレンダーの『休みを決める』で日を押すと休みになります/);
    assert.match(p, /休みを戻しても、休みにした時に足した ToDo は残ります/);
    // 新しく休みにするのはカレンダーから（一覧に日付のボタンの並びは無い）
    assert.doesNotMatch(p, /holidayChoices|"calendar"/);
  });

  test("「最初に戻す」で休みの日は消える（今のまま）", () => {
    assert.deepEqual(resetAllWrites("2026-11-04").find((w) => w.key === HOLIDAYS_KEY), { key: HOLIDAYS_KEY, value: null });
  });
});

describe("7. 共通の流れを、カレンダーと一覧の両方が使う（同じ物を2つ作らない）", () => {
  test("古い欄（HolidayPanel.tsx）は無い。流れは HolidayFlow.tsx の1か所で、決め方と書き方は holidayFlow.ts", () => {
    assert.equal(existsSync(join(ROOT, "src/app/reservations/HolidayPanel.tsx")), false);
    const flow = read("src/app/reservations/HolidayFlow.tsx");
    assert.match(flow, /holidayPress\(/);
    assert.match(flow, /applyHoliday\(/);
    assert.match(flow, /export function HolidayFlowBox/);
  });

  test("カレンダーと一覧はどちらも useHolidayFlow と HolidayFlowBox を使い、自分では書かない", () => {
    for (const f of ["MonthCalendar.tsx", "HolidayList.tsx"]) {
      const p = read(`src/app/reservations/${f}`);
      assert.match(p, /import \{ HolidayFlowBox, useHolidayFlow \} from "\.\/HolidayFlow";/, f);
      assert.match(p, /<HolidayFlowBox data=\{data\} place="(calendar|list)" \/>/, f);
      assert.doesNotMatch(p, /setHoliday|applyHoliday|writeJournal|holidayTodos|withHolidayTodos/, f);
    }
    // ToDo を足す・日誌を書くのは holidayFlow.ts の1か所だけ
    assert.match(read("src/lib/book/holidayFlow.ts"), /holidayTodos\(list, input\.nowIso, input\.todayDate\)/);
    assert.match(read("src/app/reservations/LedgerView.tsx"), /<HolidayFlowProvider data=\{data\}>\{children\}<\/HolidayFlowProvider>/);
  });

  test("ページ：月のカレンダーの下に休みの日の一覧（予約チャットと承認の箱の場所は今のまま）", () => {
    const p = read("src/app/reservations/page.tsx");
    const order = ["<WeekTimetable", 'id="res-approvals"', 'id="res-steps"', 'id="res-month"', 'id="res-holidays"', 'className="book-pair"'].map((x) => p.indexOf(x));
    assert.ok(order.every((n) => n >= 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(p, /休みの日の一覧/);
    assert.match(p, /<ReserveChat data=\{data\} \/>/);
  });

  test("カレンダーの説明の文は新しいやり方。スマホで日は高さ 44px 以上", () => {
    const m = read("src/app/reservations/MonthCalendar.tsx");
    assert.doesNotMatch(m, /休みの日の欄で決める/);
    assert.match(m, /上の「休みを決める」を入れて日を押すと休みにする・戻す/);
    const css = read("src/app/globals.css");
    const h = Number(/\.month-day \{[^}]*min-height: (\d+)px/.exec(css)?.[1]);
    assert.ok(h >= 44, String(h));
    assert.match(css, /\.month-mode \.switch \{ min-height: 44px;/);
  });
});
