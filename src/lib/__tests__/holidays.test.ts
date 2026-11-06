// 休みの日（オーナーが予約のページで決める日）のテスト。Claude と LINE は呼ばず、決まった返事に置きかえる。
// - 今ある予約の日付は動かない（休みの日を店の closedDates にそのまま重ねると 11/7 の予約が 11/8 に動く。それを防ぐ）
// - 受け付けるかの判定の全部（台帳・予約サイト・予約チャット・LINE の一言・AI の仕事・ルールの試し・翌日へ・ホームの今日）で同じに効く
// - サーバーは画面から来た休みの日を、形・本当にある日・数の上限で確かめてから使う（おかしければ断る）
// - 予約がある日を休みにする時は一覧を出し、お客様ごとに ToDo「別の日時を案内」を足す（予約は消さない）
// - 休みの日の仮押さえと、開始の時刻をもう過ぎた仮押さえは、画面の承認の箱でも LINE の承認のボタンでも確定しない
// - 「最初に戻す」で消える

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { contextFor, parseReserveRequest } from "../ai/request";
import { findOnDays, findSlots, judgeSlot, noSlotOf } from "../ai/slots";
import { openTodayLine } from "../ai/replies";
import { at, bookedAt, chat, ctxAt } from "../ai/__tests__/helpers";
import { EMPTY_ADS } from "../ads/state";
import { approveBlocker } from "../book/approve";
import { getBookData } from "../book/data";
import { holidayTodos, withHolidayTodos } from "../book/holiday";
import { siteBook } from "../book/site";
import { emptyBook, pendingApprovals, withHold, type BookState } from "../book/state";
import { calDay, demoClock, shopToday } from "../calendar";
import { bookView } from "../jobs/run";
import {
  baseShop,
  HOLIDAYS_KEY,
  holidayChoices,
  holidayJournal,
  holidaysRaw,
  isRealDate,
  parseHolidays,
  readHolidays,
  reservationsOn,
  withHolidays,
} from "../holidays";
import { parseLineAskRequest, runLineAsk } from "../line/ask";
import { applyPress } from "../line/apply";
import { maskNames, scriptSortModel } from "../line/sort";
import { loadBook, seedAnchor } from "../reservations";
import { resetAllWrites } from "../reset";
import { getRules } from "../rules/store";
import { getAdSettings, getAiSettings, getLineSettings, getMenus, getShop } from "../settings";
import { getCustomers } from "../data/seed";

const ROOT = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const shop = getShop();
const menus = getMenus();
const customers = getCustomers();
const ai = getAiSettings();
// 水曜の朝（開店前）に開いた。11/10（火）は定休日
const NOW = at("2026-11-04", "08:30");
const TODAY = calDay(shop, "2026-11-04");
/** 来週の1日（金曜） */
const HOL = "2026-11-06";

const datesOf = (s: typeof shop) => loadBook(s, menus, TODAY).all.map((r) => `${r.id}@${r.date} ${r.start}`);

describe("1. 今ある予約の日付は動かさない（休みの日は判定にだけ効く）", () => {
  test("店の closedDates にそのまま重ねると、後ろの予約の日付がずれる（直す前の形。再現）", () => {
    const wrong = loadBook({ ...shop, closedDates: ["2026-11-06"] }, menus, TODAY).all;
    // 11/6 の予約が 11/7 に、11/8 の予約が 11/9 に…と動いてしまう
    assert.equal(wrong.find((r) => r.id === "r07")?.date, "2026-11-09");
  });

  test("withHolidays で重ねても、最初の状態の予約の日付はどれも同じ（11/8 の木村様は 11/8 のまま）", () => {
    const before = datesOf(shop);
    const after = datesOf(withHolidays(shop, [HOL, "2026-11-07", "2026-11-08"]));
    assert.deepEqual(after, before);
    assert.equal(loadBook(withHolidays(shop, [HOL]), menus, TODAY).all.find((r) => r.id === "r07")?.date, "2026-11-08");
  });

  test("起点の日を休みにしても、起点は動かない（seedAnchor は休みの日を見ない）", () => {
    const s = withHolidays(shop, ["2026-11-04"]);
    assert.equal(seedAnchor(s, "2026-11-04", calDay(s, "2026-11-05")).date, "2026-11-04");
    assert.equal(baseShop(s).ownerHolidays, undefined);
  });

  test("AI の仕事の台帳（bookView）も同じ日付", () => {
    const data = { ...getBookData(), shop: withHolidays(shop, [HOL]) };
    const v = bookView(data, emptyBook("2026-11-04"), NOW);
    const plain = bookView(getBookData(), emptyBook("2026-11-04"), NOW);
    assert.deepEqual(v.booked.map((b) => `${b.id}@${b.date}`), plain.booked.map((b) => `${b.id}@${b.date}`));
  });
});

describe("2. 暦と、ブラウザに残す形", () => {
  test("休みの日は営業日でない（札は「休みの日」）。定休日の曜日はそのまま", () => {
    const s = withHolidays(shop, [HOL, "2026-11-10"]);
    const d = calDay(s, HOL);
    assert.equal(d.open, false);
    assert.equal(d.hours, null);
    assert.equal(d.holiday, true);
    // 火曜（定休日）を足しても「休みの日」ではなく定休日のまま
    assert.equal(calDay(s, "2026-11-10").holiday, undefined);
    assert.equal(calDay(shop, HOL).open, true);
  });

  test("欄に並べる日：今日から決めた日数。定休日の曜日は押せない印", () => {
    const list = holidayChoices(shop, TODAY);
    assert.equal(list.length, 56);
    assert.equal(list[0].date, "2026-11-04");
    assert.equal(list.find((d) => d.date === "2026-11-10")?.weekly, true);
    assert.equal(list.find((d) => d.date === HOL)?.weekly, false);
  });

  test("読む・書く：形のおかしい日・無い日は落とす。0日なら消す（null）", () => {
    assert.deepEqual(parseHolidays(holidaysRaw([HOL, "2026-02-30", "x", HOL]), shop), [HOL]);
    assert.equal(holidaysRaw([]), null);
    assert.deepEqual(parseHolidays("{", shop), []);
    assert.deepEqual(parseHolidays(null, shop), []);
    assert.equal(isRealDate("2026-02-29"), false);
    assert.equal(isRealDate("2028-02-29"), true);
  });

  test("日誌の1行", () => {
    assert.match(holidayJournal("11/6（金）", true, 2), /休みの日にした：11\/6（金）.*予約 2件は消さずに残し/);
    assert.match(holidayJournal("11/6（金）", false), /休みの日を戻した：11\/6（金）/);
  });

  test("「最初に戻す」で消える（seats と同じ扱い）", () => {
    assert.deepEqual(resetAllWrites("2026-11-04").find((w) => w.key === HOLIDAYS_KEY), { key: HOLIDAYS_KEY, value: null });
  });
});

describe("3. サーバー：形と数を確かめてから使う", () => {
  const body = (holidays: unknown) => ({
    mode: "script",
    messages: [{ role: "user", text: "カット" }],
    candidates: [],
    customer: { id: "c04", surname: "江口", firstVisit: false },
    booked: [],
    rules: [],
    visits: [],
    dayOffset: 0,
    holidays,
  });

  test("形のおかしい日付・無い日・配列でない・多すぎる物は断る", () => {
    for (const bad of [["2026-11-6"], ["2026-02-30"], ["11/6"], [6], "2026-11-06", Array.from({ length: 61 }, (_, i) => `2027-01-${String((i % 28) + 1).padStart(2, "0")}`)])
      assert.equal(parseReserveRequest(body(bad), menus, ai).ok, false, JSON.stringify(bad).slice(0, 40));
    assert.equal(readHolidays(["2026-13-01"], shop).ok, false);
  });

  test("無ければ 0日。正しければ受け取って、道具の店に重ねる（判定で「お休みの日」）", () => {
    const none = parseReserveRequest(body(undefined), menus, ai);
    assert.ok(none.ok && !none.value.holidays);
    const p = parseReserveRequest(body([HOL]), menus, ai);
    assert.ok(p.ok);
    assert.deepEqual(p.value.holidays, [HOL]);
    const ctx = contextFor({ ...p.value, booked: bookedAt(NOW) }, shop, menus, NOW);
    assert.deepEqual(ctx.shop.ownerHolidays, [HOL]);
    const v = judgeSlot(ctx, { menuId: "cut", date: HOL, start: "15:00" });
    assert.equal(v.ok, false);
    assert.equal(v.base.find((b) => b.id === "open-day")?.ok, false);
  });

  test("サーバーの今日も、休みを重ねてから決める（今日を休みにしたら次の営業日）", () => {
    const p = parseReserveRequest(body(["2026-11-04"]), menus, ai);
    assert.ok(p.ok);
    const ctx = contextFor(p.value, shop, menus, NOW);
    assert.equal(ctx.today.date, "2026-11-05");
    // 画面（useBook）と同じ決め方
    assert.equal(demoClock(withHolidays(shop, ["2026-11-04"]), NOW, 0).today.date, "2026-11-05");
    assert.equal(shopToday(withHolidays(shop, ["2026-11-04"]), NOW).shifted, true);
  });
});

describe("4. 予約チャットと LINE の一言は、休みの日を候補に出さない", () => {
  test("予約チャット（決まった返事）：休みの日を頼まれても、その日の候補は出さない", async () => {
    const ctx = ctxAt(NOW, { shop: withHolidays(shop, [HOL]) });
    const r = await chat(ctx, [{ role: "user", text: "11/6の15時にカット" }]);
    assert.ok(r.candidates && r.candidates.length > 0, "代わりの候補は出す");
    assert.ok(r.candidates!.every((c) => c.date !== HOL), JSON.stringify(r.candidates));
    assert.equal(r.holds.length, 0);
    // 空きを調べる道具も、休みの日は飛ばす
    assert.ok(findSlots(ctx, "cut", { date: HOL }, 6).slots.every((c) => c.date !== HOL));
  });

  test("休みの日でなければ、同じ頼みでその日を出す（比べ）", async () => {
    const r = await chat(ctxAt(NOW), [{ role: "user", text: "11/6の15時にカット" }]);
    assert.ok(r.candidates?.some((c) => c.date === HOL));
  });

  const lineReq = (text: string, holidays: unknown) => {
    const { masked, found } = maskNames(text, customers);
    return parseLineAskRequest(
      { mode: "script", text: masked, customer: found[0] ?? null, booked: bookedAt(NOW), rules: getRules().filter((r) => !r.locked), dayOffset: 0, holidays },
      menus,
      ai,
      getLineSettings().maxTextChars,
    );
  };

  test("LINE の一言：受け取る途中で落とさない（型・受け取り・引き渡し）。休みの日は仮押さえしない", async () => {
    const parsed = lineReq("11/6 15時に青木さんカットで仮押さえ", [HOL]);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value.holidays, [HOL]);
    const today = demoClock(withHolidays(shop, [HOL]), NOW, 0).today;
    const res = await runLineAsk({ req: parsed.value, shop, menus, model: scriptSortModel({ menus, today }), maxTokens: 300, now: NOW });
    assert.ok(res.ok);
    assert.equal(res.kind, "hold-no");
    if (res.kind === "hold-no") assert.ok(res.alternatives.every((a) => !a.startsWith("11/6")), res.alternatives.join(" / "));
  });

  test("LINE の一言：形のおかしい休みの日は断る", () => {
    assert.equal(lineReq("シャンプー発注", ["2026-11-31"]).ok, false);
  });

  test("画面は休みの日を送る（予約チャット・LINE の一言・AI の仕事）", () => {
    assert.match(read("src/app/reservations/ReserveChat.tsx"), /holidays: book\.shop\.ownerHolidays \?\? \[\]/);
    assert.match(read("src/components/LineBridge.tsx"), /holidays: L\.book\.shop\.ownerHolidays \?\? \[\]/);
    assert.match(read("src/lib/jobs/run.ts"), /holidays: env\.data\.shop\.ownerHolidays \?\? \[\]/);
    assert.match(read("src/app/api/ai/line/route.ts"), /demoClock\(ownerShop\(shop, req\)/);
  });
});

describe("5. 画面の判定の全部で同じに効く", () => {
  test("予約サイト：休みの日には入らない", () => {
    // 11/4〜11/9 の営業日を全部休みにすると、入るのはその先の日
    const hol = ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"];
    const data = { ...getBookData(), shop: withHolidays(shop, hol) };
    const out = siteBook(emptyBook("2026-11-04"), { data, rules: getRules(), now: NOW }, "free");
    assert.ok(out.ok);
    if (out.ok) assert.ok(!hol.includes(out.placed.date), out.placed.date);
  });

  test("台帳の時間割・日ごとのカード：休みの日の列はお休み。残った予約は隠さない", () => {
    const ledger = read("src/app/reservations/Ledger.tsx");
    assert.match(ledger, /お休みの日に残っている予約/);
    assert.match(ledger, /d\.holiday \? "休みの日" : "お休み"/);
    const view = loadBook(withHolidays(shop, [HOL]), menus, TODAY);
    const day = view.week.find((d) => d.date === HOL)!;
    assert.equal(day.open, false);
    assert.equal(day.reservations.length, 2, "11/6 の大橋様・加藤様の予約は台帳に残る");
    assert.equal(view.checks.hours.ok, false, "プログラムの確認で「お休みの日に入っています」と出す");
  });

  test("ルールの試し・ホームの「翌日へ」と前日のお知らせ・予約サイトの空き表は、休みの日を重ねた店で", () => {
    assert.match(read("src/app/rules/RuleSide.tsx"), /calDay\(book\.shop, d\.date\)/);
    // 「翌日へ」は advanceDay（直しA）に、休みの日を重ねた店（book.shop）を渡す
    assert.match(read("src/app/home/HomeSummary.tsx"), /advanceDay\(\{ update: book\.update, journal: writeJournal \}, \{ shop: book\.shop/);
    assert.match(read("src/app/reservations/BookingSite.tsx"), /weekFrom\(book\.shop, book\.today\)/);
    assert.match(read("src/lib/book/useBook.ts"), /demoClock\(shop, now, state\.dayOffset\)/);
  });

  test("「翌日へ」は休みの日も飛ばす（画面とサーバーで同じ）", () => {
    const s = withHolidays(shop, ["2026-11-05"]);
    assert.equal(demoClock(s, NOW, 1).today.date, "2026-11-06");
    assert.equal(demoClock(shop, NOW, 1).today.date, "2026-11-05");
  });
});

describe("6. 予約がある日を休みにする時：一覧と ToDo（予約は消さない）", () => {
  const all = loadBook(shop, menus, TODAY).all;

  test("その日の予約（確定・仮押さえ）を一覧で出す", () => {
    const list = reservationsOn(all, HOL);
    assert.deepEqual(list.map((r) => r.id), ["r05", "r06"]);
  });

  test("その予約のお客様に ToDo「○○様に別の日時を案内（11/6（金） 10:30 パーマの代わり）」（todo/reschedule.ts の1か所）。2回押しても重ねない", () => {
    const todos = holidayTodos(reservationsOn(all, HOL), NOW.toISOString(), "2026-11-04");
    assert.deepEqual(
      todos.map((t) => t.title),
      ["大橋様に別の日時を案内（11/6（金） 10:30 パーマの代わり）", "加藤様に別の日時を案内（11/6（金） 16:00 カットの代わり）"],
    );
    assert.deepEqual(todos.map((t) => t.id), ["td-hol-r05", "td-hol-r06"]);
    assert.ok(todos.every((t) => t.due === "2026-11-04" && t.source === "reserve"));
    const once = withHolidayTodos(emptyBook("2026-11-04"), todos);
    assert.equal(once.added.length, 2);
    const twice = withHolidayTodos(once.state, todos);
    assert.equal(twice.added.length, 0);
    assert.equal(twice.state.todos.length, 2);
  });

  test("画面：予約がある日はまず一覧、もう一度押した時だけ休みにする。人が押した時だけ", () => {
    const p = read("src/app/reservations/HolidayPanel.tsx");
    assert.match(p, /if \(on && list\.length\) return setAsk/);
    assert.match(p, /それでも休みにする/);
    assert.match(p, /if \(!e\.nativeEvent\.isTrusted\) return;/);
    assert.match(p, /writeJournal\(\{ who: "オーナー", text: holidayJournal/);
  });
});

describe("7. 承認の時：休みの日と過ぎた時刻の仮押さえは確定しない（画面と LINE の両方）", () => {
  const c = customers.find((x) => x.id === "c04")!;
  const holdOn = (s: BookState, date: string, start: string, id = "h-1") =>
    withHold(s, { id, customerId: c.id, menuId: "cut", date, start, heldAt: NOW.toISOString(), expiresAt: "2026-12-31T00:00:00.000Z", reason: "テスト" });

  test("approveBlocker：休みの日・定休日・過ぎた時刻は理由を返す。これから先の営業日は null", () => {
    const s = withHolidays(shop, [HOL]);
    const now = { date: "2026-11-04", time: "08:30" };
    assert.match(approveBlocker(s, now, { date: HOL, start: "15:00" }) ?? "", /11\/6（金）は休みの日なので確定できません/);
    assert.match(approveBlocker(s, now, { date: "2026-11-10", start: "15:00" }) ?? "", /お休みの日なので確定できません/);
    assert.match(approveBlocker(s, { date: "2026-11-06", time: "09:00" }, { date: "2026-11-05", start: "15:00" }) ?? "", /もう過ぎたので確定できません/);
    assert.match(approveBlocker(s, { date: "2026-11-05", time: "15:00" }, { date: "2026-11-05", start: "15:00" }) ?? "", /もう過ぎた/);
    assert.equal(approveBlocker(s, now, { date: "2026-11-05", start: "15:00" }), null);
  });

  const ctx = (holidays: string[], now: { date: string; time: string }) => ({
    shop: withHolidays(shop, holidays),
    menus,
    customers,
    nowIso: NOW.toISOString(),
    today: now.date,
    now,
    adSettings: getAdSettings(),
  });

  test("LINE の承認のボタン：休みの日の仮押さえは確定しない（台帳は変えず、理由を返す）", () => {
    const book = holdOn(emptyBook("2026-11-04"), HOL, "15:00");
    const ev = { kind: "press" as const, id: "ev-1", target: "reservation" as const, approvalId: "ap-h-1", how: "approve" as const, at: NOW.toISOString() };
    const out = applyPress(ev as never, book, EMPTY_ADS, ctx([HOL], { date: "2026-11-04", time: "08:30" }));
    assert.equal(out.book, book);
    assert.match(out.reply, /✗ 確定しませんでした/);
    assert.match(out.reply, /休みの日/);
    assert.equal(pendingApprovals(out.book, NOW.toISOString()).length, 1, "仮押さえは承認待ちのまま（直す・見送りはできる）");
  });

  test("LINE の承認のボタン：「翌日へ」で過ぎた日の仮押さえは確定しない。これからの物は確定する", () => {
    const book = holdOn(emptyBook("2026-11-04"), "2026-11-05", "15:00");
    const ev = { kind: "press" as const, id: "ev-2", target: "reservation" as const, approvalId: "ap-h-1", how: "approve" as const, at: NOW.toISOString() };
    const past = applyPress(ev as never, book, EMPTY_ADS, ctx([], { date: "2026-11-06", time: "09:00" }));
    assert.equal(past.book, book);
    assert.match(past.reply, /もう過ぎた/);
    const ok = applyPress(ev as never, book, EMPTY_ADS, ctx([], { date: "2026-11-04", time: "08:30" }));
    assert.match(ok.reply, /✓ 確定しました/);
    assert.equal(ok.book.chat[0].status, "confirmed");
  });

  test("画面の承認の箱：同じ確かめ。確定しない時は押せず、理由を出す", () => {
    const box = read("src/components/ApprovalBox.tsx");
    assert.match(box, /const blocked = approveBlocker\(book\.shop, book\.now, r\);\s*if \(blocked\) return refuse\(what, blocked\);/);
    assert.match(box, /disabled=\{!!blocked\}/);
    assert.match(box, /✗ 確定しませんでした/);
  });
});

describe("8. お客様への文：休みの日は「（定休日）」を付けない（定休日は今のまま）", () => {
  test("空きが1つも無い時の1文（頼まれた日がお休み）", () => {
    const s = withHolidays(shop, [HOL]);
    const ctx = ctxAt(NOW, { shop: s });
    assert.equal(noSlotOf(findOnDays(ctx, "cut", [HOL])).text, "その日はお休みなので、お受けできません。");
    assert.equal(noSlotOf(findOnDays(ctx, "cut", ["2026-11-10"])).text, "その日はお休み（定休日）なので、お受けできません。");
  });

  test("「今日やってますか」の答え", () => {
    const s = withHolidays(shop, ["2026-11-04"]);
    assert.match(openTodayLine(s, { date: "2026-11-04", time: "09:00" }), /^今日（11\/4（水））はお休みです。次は/);
    assert.match(openTodayLine(shop, { date: "2026-11-10", time: "09:00" }), /^今日（11\/10（火））はお休み（定休日）です。/);
  });
});
