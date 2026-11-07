// 台帳の予約を押して開く1枚・取り消す・日時とメニューを変える（docs/SPEC.md §1.4.2）のテスト。Claude は呼ばない（AI を使わない流れ）。
// - 押して開く：確定で開始前 = 直せる / 仮押さえ = 承認BOXへ / 開始を過ぎた・カルテがある = 見るだけ
// - 取り消す：台帳・空き表・ホームの今日・前日のお知らせ・サーバーへ送る台帳から消える。承認BOXの履歴・カルテは残る。日誌
// - 予約サイトの番号は、取り消しても重ならない
// - 変える：自分とはぶつからない・同じお客様のほかの予約は残して判定・入れられない物と鍵つきのルールは変えられない・
//   ほかのルールはもう一度押せば変えられる・今日の中でずらせる・保存の直前の確かめ・終わる時刻・変えた先の週へ・日誌
// - 最初の予約を直した分は parseBook で読み直せて、「最初に戻す」で消える。保存できなかった時は何も変わらない。
//   「翌日へ」「最初に戻す」で1枚が閉じ、古い中身を保存しない

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { BOOK_KEY, BROWSER_PREFIX, DAILY_KEY, readBrowser, writeBrowser } from "../../browser";
import { HOLIDAYS_KEY } from "../../holidays";
import { SITE_STOPS_KEY } from "../siteStops";
import { calDay } from "../../calendar";
import { allKartes, resolveSeedKartes } from "../../karte/record";
import { getReminderSettings } from "../../settings";
import { freeRanges } from "../../reservations";
import { getRules } from "../../rules/store";
import type { Rule } from "../../rules/types";
import { resetAll } from "../../reset";
import { bookView } from "../../jobs/run";
import { assembleBook } from "../assemble";
import {
  cancelReservation,
  changeCheck,
  changeReservation,
  HOLD_NOTE,
  MOVED_NOTE,
  openedMark,
  sheetMode,
  SOURCE_LABEL,
  STALE_NOTE,
  type ChangeContext,
} from "../change";
import { getBookData } from "../data";
import { advanceDay, reminderDay, remindersNow } from "../nextDay";
import { ownerBook } from "../owner";
import { ledgerView, siteBook } from "../site";
import { updateBook } from "../store";
import { emptyBook, parseBook, withApproved, withHold, type BookState } from "../state";
import { freshView, syncView, viewKey, viewRange, viewReduce } from "../weekView";

const ROOT = join(__dirname, "../../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const data = getBookData();
const rules = getRules();
// 水曜の朝（開店前）に開いた
const NOW = new Date("2026-11-04T08:30:00+09:00");
const base = emptyBook("2026-11-04");
const ctx: ChangeContext = { data, rules, now: NOW, kartes: [] };

const view = (s: BookState, now = NOW) => ledgerView(data, s, now);
const resOf = (s: BookState, id: string) => view(s).all.find((r) => r.id === id);
const markOf = (s: BookState, id: string, now = NOW) => {
  const v = view(s, now);
  return openedMark(viewKey(s.epoch, v.clock.dayOffset), v.all.find((r) => r.id === id)!);
};
const kartesOf = (s: BookState) => allKartes(resolveSeedKartes(data.seedKartes, view(s).all), s.kartes);

// 最初の状態：r01 青木 11/4（水）10:00 カット・r02 石田 11/4 17:00 カラー・r04 江口 11/5（木）13:00 カット＋カラー・
// r10 青木 5番目の営業日 13:30 ヘッドスパ。同じ時間に受けるのは1人
describe("1. 押して開く：出る物が違う", () => {
  test("確定で開始前 = 取り消す・変えるを出す（edit）。どこから入ったかの札", () => {
    const r = resOf(base, "r04")!;
    assert.equal(sheetMode(r, view(base).clock.now, kartesOf(base)), "edit");
    assert.equal(SOURCE_LABEL[r.source], "最初から");
    assert.equal(SOURCE_LABEL.chat, "予約チャット");
    assert.equal(SOURCE_LABEL.site, "予約サイト");
    assert.equal(SOURCE_LABEL.owner, "台帳から（オーナー）");
  });

  test("仮押さえ = 直さず「承認BOXで、承認か見送り」", () => {
    const s = withHold(base, { id: "h1", customerId: "c05", menuId: "cut", date: "2026-11-06", start: "13:00", heldAt: NOW.toISOString(), expiresAt: "2026-11-05T08:30:00+09:00", reason: "r" } as never);
    const r = resOf(s, "h1")!;
    assert.equal(sheetMode(r, view(s).clock.now, []), "hold");
    assert.equal(HOLD_NOTE, "仮押さえは承認BOXで、承認か見送りを決めます");
    // 仮押さえは取り消し・変えるの関数でも直さない
    const out = cancelReservation(s, ctx, markOf(s, "h1"));
    assert.equal(out.ok, false);
    assert.equal(out.state, s);
  });

  test("開始の時刻を過ぎた予約 = 見るだけ（今日 10:00 の予約は 10:00 から過ぎた扱い）", () => {
    const later = new Date("2026-11-04T10:00:00+09:00");
    const r = view(base, later).all.find((x) => x.id === "r01")!;
    assert.equal(sheetMode(r, view(base, later).clock.now, []), "past");
    const out = cancelReservation(base, { ...ctx, now: later }, markOf(base, "r01", later));
    assert.equal(out.ok, false);
  });

  test("保存したカルテがある予約 = 見るだけ（人が保存したカルテ・最初の状態のカルテ）", () => {
    const s: BookState = {
      ...base,
      kartes: [{ id: "k1", customerId: "c04", date: "2026-11-05", menuId: "cut_color", reservationId: "r04", memo: "", sections: {}, savedAt: NOW.toISOString() }],
    };
    const r = resOf(s, "r04")!;
    assert.equal(sheetMode(r, view(s).clock.now, kartesOf(s)), "karte");
    const out = cancelReservation(s, { ...ctx, kartes: kartesOf(s) }, markOf(s, "r04"));
    assert.equal(out.ok, false);
    // 最初の状態のカルテ（前回の来店）のある予約は、過ぎているので見るだけ
    const p01 = resOf(base, "p01")!;
    assert.equal(sheetMode(p01, view(base).clock.now, kartesOf(base)), "past");
  });

  test("台帳の帯とカードの行が押せる（見た目のクラスは今のまま・押せる印だけ足す）", () => {
    const grid = read("src/app/reservations/TimetableGrid.tsx");
    assert.match(grid, /onOpen \? `\$\{bandClass\(b\)\} openable` : bandClass\(b\)/);
    const ledger = read("src/app/reservations/Ledger.tsx");
    assert.match(ledger, /menuColorClass\(r\.menu\)\} openable`/);
    const sheet = read("src/app/reservations/ReservationSheet.tsx");
    assert.match(sheet, /承認BOXへ/);
    assert.match(sheet, /className="sheet-foot"/);
    // 取り消しはもう一度押した時だけ
    assert.match(sheet, /if \(!confirmCancel\) \{/);
    const css = read("src/app/globals.css");
    assert.match(css, /\.tt-band\.openable, \.slot\.openable \{ cursor: pointer; \}/);
  });

  test("1枚は親が持つ：detail で開き、閉じる。「翌日へ」「最初に戻す」（印が変わる）で閉じる", () => {
    const range = viewRange(data.shop, { todayDate: "2026-11-04", nowDate: "2026-11-04", all: view(base).all });
    let s = freshView(viewKey(undefined, 0));
    s = viewReduce(s, { kind: "detail", id: "r04" }, { todayDate: "2026-11-04", range });
    assert.equal(s.detail, "r04");
    assert.equal(syncView(s, viewKey(undefined, 1)).detail, null);
    assert.equal(syncView(s, viewKey("r-x", 0)).detail, null);
    assert.equal(viewReduce(s, { kind: "close" }, { todayDate: "2026-11-04", range }).detail, null);
  });
});

describe("2. 取り消す", () => {
  test("最初の予約を取り消す：台帳・空き表・前日のお知らせ・サーバーへ送る台帳から消える。日誌", () => {
    const out = cancelReservation(base, ctx, markOf(base, "r04"));
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.deepEqual(out.journal, [{ who: "オーナー", text: "予約を取り消した（江口様 11/5（木） 13:00 カット＋カラー）" }]);
    assert.deepEqual(out.state.seedResEdits?.r04, { cancelled: true, at: NOW.toISOString() });
    const v = view(out.state);
    assert.equal(v.all.some((r) => r.id === "r04"), false);
    // 空き表：13:00 からの枠が空きに戻る
    const free = (all: typeof v.all) => freeRanges(data.shop, calDay(data.shop, "2026-11-05"), all).ranges.some((x) => x.start <= "13:00" && x.end >= "15:00");
    assert.equal(free(view(base).all), false);
    assert.equal(free(v.all), true);
    // 前日のお知らせ
    const t = getReminderSettings().template;
    assert.ok(remindersNow({ date: "2026-11-05", dayLabel: "", sentLabel: "" }, view(base).all, t, "店").some((m) => m.reservationId === "r04"));
    assert.equal(remindersNow({ date: "2026-11-05", dayLabel: "", sentLabel: "" }, v.all, t, "店").some((m) => m.reservationId === "r04"), false);
    // サーバーへ送る台帳（予約チャット・LINE は useBook の booked、AI の仕事は bookView。どちらも assembleBook）
    assert.equal(assembleBook(data, out.state, v.clock.today, NOW.toISOString()).booked.some((b) => b.id === "r04"), false);
    assert.equal(bookView(data, out.state, NOW).booked.some((b) => b.id === "r04"), false);
    assert.equal(bookView(data, base, NOW).booked.some((b) => b.id === "r04"), true);
  });

  test("今日の予約を取り消す：ホームの今日のお客様（台帳の今日）から消える", () => {
    const out = cancelReservation(base, ctx, markOf(base, "r02"));
    assert.ok(out.ok);
    if (!out.ok) return;
    const today = (s: BookState) => view(s).all.filter((r) => r.date === view(s).clock.today.date).map((r) => r.id);
    assert.ok(today(base).includes("r02"));
    assert.equal(today(out.state).includes("r02"), false);
  });

  test("別のタブで取り消した時も、前日のお知らせは今の台帳から数え直すので合う", () => {
    let state = base;
    const deps = { update: (f: (s: BookState) => BookState) => ((state = f(state)), { ok: true as const }), journal: () => {} };
    const t = getReminderSettings().template;
    const out = advanceDay(deps, { shop: data.shop, now: NOW, all: view(state).all, template: t });
    assert.ok(out.moved);
    if (!out.moved) return;
    const day = reminderDay(out);
    assert.equal(day.date, "2026-11-05");
    assert.ok(out.reminders.some((m) => m.reservationId === "r04"));
    // 別のタブで取り消した（台帳だけ変わる。画面が持つのは日だけ）
    const c = cancelReservation(state, ctx, markOf(state, "r04"));
    assert.ok(c.ok);
    if (!c.ok) return;
    assert.equal(remindersNow(day, view(c.state).all, t, data.shop.name).some((m) => m.reservationId === "r04"), false);
    // ホームは日だけを持つ（作った時の並びを持たない）
    const home = read("src/app/home/HomeSummary.tsx");
    assert.match(home, /useState<ReminderDay \| null>/);
    assert.match(home, /remindersNow\(remind, book\.all/);
  });

  test("承認で確定した予約を取り消す：台帳から外れ、承認BOXの履歴・カルテ・ToDo は残る", () => {
    let s = withHold(base, { id: "h1", customerId: "c05", menuId: "cut", date: "2026-11-06", start: "13:00", heldAt: NOW.toISOString(), expiresAt: "2026-11-05T08:30:00+09:00", reason: "r" } as never);
    s = withApproved(s, "ap-h1", NOW.toISOString());
    s = {
      ...s,
      kartes: [{ id: "k1", customerId: "c01", date: "2026-11-04", menuId: "cut", memo: "", sections: {}, savedAt: NOW.toISOString() }],
      todos: [{ id: "td-1", title: "別の日時を案内", createdAt: NOW.toISOString(), done: false }],
    };
    const out = cancelReservation(s, { ...ctx, kartes: kartesOf(s) }, markOf(s, "h1"));
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.equal(out.state.chat.some((r) => r.id === "h1"), false);
    assert.deepEqual(out.state.approvals, s.approvals);
    assert.equal(out.state.approvals[0].state, "approved");
    assert.deepEqual(out.state.kartes, s.kartes);
    assert.deepEqual(out.state.todos, s.todos);
    assert.equal(view(out.state).all.some((r) => r.id === "h1"), false);
    // 見送りの仕組み（withReleased）は使わない
    assert.doesNotMatch(read("src/lib/book/change.ts"), /withReleased\(/);
  });
});

describe("3. 予約サイトの番号は、取り消しても重ならない", () => {
  test("2件入れて1件目を取り消し、もう1件入れても番号が重ならない（2件目を取り消しても戻らない）", () => {
    const site = { data, rules, now: NOW };
    const a = siteBook(base, site, "free");
    assert.ok(a.ok);
    if (!a.ok) return;
    const b = siteBook(a.state, site, "free");
    assert.ok(b.ok);
    if (!b.ok) return;
    assert.deepEqual([a.placed.id, b.placed.id], ["site-1", "site-2"]);
    const c1 = cancelReservation(b.state, ctx, markOf(b.state, "site-1"));
    assert.ok(c1.ok);
    if (!c1.ok) return;
    const c = siteBook(c1.state, site, "free");
    assert.ok(c.ok);
    if (!c.ok) return;
    assert.equal(c.placed.id, "site-3");
    const ids = c.state.chat.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    // いちばん新しい物を取り消しても、番号は戻らない
    const c3 = cancelReservation(c.state, ctx, markOf(c.state, "site-3"));
    assert.ok(c3.ok);
    if (!c3.ok) return;
    const d = siteBook(c3.state, site, "free");
    assert.ok(d.ok);
    if (d.ok) assert.equal(d.placed.id, "site-4");
    // parseBook で読み直しても番号を覚えている
    assert.equal(parseBook(JSON.stringify(c3.state))?.siteSeq, 3);
  });
});

describe("4. 日時とメニューを変える", () => {
  const change = (s: BookState, id: string, input: { date: string; start: string; menuId: string }, ack: string[] = [], c: ChangeContext = ctx) =>
    changeReservation(s, c, markOf(s, id), input, ack);

  test("自分とはぶつからない：江口様 11/5 13:00 カット＋カラー（2時間）を 14:00 にずらせる。終わる時刻も数え直す", () => {
    const out = change(base, "r04", { date: "2026-11-05", start: "14:00", menuId: "cut_color" });
    assert.ok(out.ok, out.ok ? "" : out.note);
    if (!out.ok) return;
    const r = resOf(out.state, "r04")!;
    assert.equal(r.start, "14:00");
    assert.equal(r.end, "16:00");
    assert.equal(r.status, "confirmed");
    assert.equal(r.source, "seed");
    assert.deepEqual(out.journal, [{ who: "オーナー", text: "予約を変えた（江口様 11/5（木） 13:00 カット＋カラー → 11/5（木） 14:00 カット＋カラー）" }]);
    assert.equal(out.message, "変えました：11/5（木） 14:00 カット＋カラー");
  });

  test("メニューを変える（組み合わせも）：終わる時刻・帯の長さが変わる。変えた先の日の週へ移る", () => {
    const out = change(base, "r04", { date: "2026-11-06", start: "13:00", menuId: "cut+headspa" });
    assert.ok(out.ok, out.ok ? "" : out.note);
    if (!out.ok) return;
    const r = resOf(out.state, "r04")!;
    assert.equal(r.date, "2026-11-06");
    assert.equal(r.menu.name, "カット＋ヘッドスパ");
    assert.equal(r.end, "14:30");
    assert.equal(out.date, "2026-11-06");
    const range = viewRange(data.shop, { todayDate: "2026-11-04", nowDate: "2026-11-04", all: view(out.state).all });
    const v = viewReduce({ ...freshView("k"), detail: "r04" }, { kind: "pick", date: out.date! }, { todayDate: "2026-11-04", range });
    assert.equal(v.start, "2026-11-06");
    assert.equal(v.detail, "r04");
    assert.equal(out.journal[0].text, "予約を変えた（江口様 11/5（木） 13:00 カット＋カラー → 11/6（金） 13:00 カット＋ヘッドスパ）");
  });

  test("今日の中でずらせる：石田様 今日 17:00 カラー → 18:00（最終受付ちょうど）", () => {
    const out = change(base, "r02", { date: "2026-11-04", start: "18:00", menuId: "color" });
    assert.ok(out.ok, out.ok ? "" : out.note);
    if (out.ok) assert.equal(resOf(out.state, "r02")!.end, "19:30");
  });

  test("同じお客様のほかの予約は残して判定する：青木様の別の予約（r10）を、同じ青木様の今日 10:00 に重ねられない", () => {
    const c = changeCheck(base, ctx, "r10", { menuId: "headspa", date: "2026-11-04", start: "10:00" })!;
    assert.ok(c.blocked.some((l) => l.key === "base:seats"), JSON.stringify(c.blocked));
    const out = change(base, "r10", { date: "2026-11-04", start: "10:00", menuId: "headspa" });
    assert.equal(out.ok, false);
    assert.equal(out.state, base);
  });

  const blocked: [string, { date: string; start: string; menuId: string }, string][] = [
    ["過ぎた日時", { date: "2026-11-02", start: "15:00", menuId: "cut" }, "base:future"],
    ["営業時間の外", { date: "2026-11-05", start: "09:00", menuId: "cut" }, "base:hours"],
    ["最終受付を過ぎる（カラーは18:00まで）", { date: "2026-11-06", start: "18:30", menuId: "color" }, "base:menu-last"],
    ["定休日（火曜）", { date: "2026-11-10", start: "15:00", menuId: "cut" }, "base:open-day"],
    ["同じ時間に受ける人数を超える（石田様の今日 17:00 に重なる）", { date: "2026-11-04", start: "17:00", menuId: "cut" }, "base:seats"],
    ["台帳で見られる範囲より先", { date: "2027-03-01", start: "15:00", menuId: "cut" }, "base:range"],
  ];
  for (const [what, input, key] of blocked)
    test(`変えられない：${what}（もう一度押しても変えない）`, () => {
      const c = changeCheck(base, ctx, "r04", input)!;
      assert.ok(c.blocked.some((l) => l.key === key), JSON.stringify(c.blocked));
      const out = change(base, "r04", input, c.rules.map((r) => r.key));
      assert.equal(out.ok, false);
      assert.equal(out.state, base);
    });

  test("鍵つきのルールに当たる時は、もう一度押しても変えない", () => {
    const lockedRule: Rule = { id: "t-locked", level: "global", label: "鍵つきのテスト", check: { kind: "minLeadMinutes", value: 100000 }, locked: true };
    const c2: ChangeContext = { ...ctx, rules: [...rules, lockedRule] };
    const input = { date: "2026-11-06", start: "13:00", menuId: "cut_color" };
    const c = changeCheck(base, c2, "r04", input)!;
    assert.ok(c.blocked.some((l) => l.key === "rule:t-locked"));
    assert.equal(change(base, "r04", input, ["rule:t-locked"], c2).ok, false);
  });

  test("オーナーが足したルールに当たる時だけ、もう一度押せば変えられる（名前を日誌に）", () => {
    // 今日 11:00 は来店の2時間半前（3時間前までのルール）
    const input = { date: "2026-11-04", start: "11:00", menuId: "cut_color" };
    const c = changeCheck(base, ctx, "r04", input)!;
    assert.equal(c.blocked.length, 0);
    assert.deepEqual(c.rules.map((r) => r.key), ["rule:seed-lead-time"]);
    const first = change(base, "r04", input);
    assert.equal(first.ok, false);
    if (!first.ok) assert.match(first.note, /もう一度押すと変えられます/);
    const second = change(base, "r04", input, ["rule:seed-lead-time"]);
    assert.ok(second.ok);
    if (second.ok)
      assert.equal(
        second.journal[0].text,
        "予約を変えた（江口様 11/5（木） 13:00 カット＋カラー → 11/4（水） 11:00 カット＋カラー）。ルール「予約は来店の3時間前まで」に当たったが、オーナーが確かめて変えた",
      );
  });

  test("保存の直前の確かめ：開いた後にほかの画面で同じ枠に予約が入ったら変えない", () => {
    const input = { date: "2026-11-06", start: "13:00", menuId: "cut" };
    const mark = markOf(base, "r04");
    assert.equal(changeCheck(base, ctx, "r04", input)!.blocked.length, 0);
    const other = ownerBook(base, { data, rules, now: NOW, newId: () => "own-x" }, { customerId: "c07", menuId: "cut", date: "2026-11-06", start: "13:00" });
    assert.ok(other.ok);
    if (!other.ok) return;
    const out = changeReservation(other.state, ctx, mark, input);
    assert.equal(out.ok, false);
    if (!out.ok) assert.ok(out.check?.blocked.some((l) => l.key === "base:seats"));
  });

  test("保存の直前の確かめ：開いた後にその予約がほかの画面で変わった・取り消されたら使わない", () => {
    const mark = markOf(base, "r04");
    const moved = change(base, "r04", { date: "2026-11-05", start: "14:00", menuId: "cut_color" });
    assert.ok(moved.ok);
    if (!moved.ok) return;
    const out = changeReservation(moved.state, ctx, mark, { date: "2026-11-06", start: "13:00", menuId: "cut" });
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.note, MOVED_NOTE);
    const gone = cancelReservation(base, ctx, mark);
    assert.ok(gone.ok);
    if (!gone.ok) return;
    assert.equal(cancelReservation(gone.state, ctx, mark).ok, false);
  });

  test("予約チャット・予約サイト・台帳から入った予約は、今ある記録の中を直す（札も確定もそのまま）", () => {
    const own = ownerBook(base, { data, rules, now: NOW, newId: () => "own-x" }, { customerId: "c07", menuId: "cut", date: "2026-11-06", start: "13:00" });
    assert.ok(own.ok);
    if (!own.ok) return;
    const out = change(own.state, "own-x", { date: "2026-11-06", start: "13:30", menuId: "cut+headspa" });
    assert.ok(out.ok, out.ok ? "" : out.note);
    if (!out.ok) return;
    const x = out.state.chat.find((r) => r.id === "own-x")!;
    assert.deepEqual([x.start, x.menuId, x.status, x.via], ["13:30", "cut+headspa", "confirmed", "owner"]);
    assert.equal(out.state.chat.length, own.state.chat.length);
    assert.equal(out.state.seedResEdits, undefined);
    // サーバーへ送る台帳にも同じに
    assert.ok(bookView(data, out.state, NOW).booked.some((b) => b.id === "own-x" && b.start === "13:30" && b.menuId === "cut+headspa"));
  });
});

describe("5. 保存の形・「最初に戻す」・「翌日へ」", () => {
  test("最初の予約を直した分は parseBook で読み直せる（形のおかしい物は落とす）", () => {
    const s: BookState = {
      ...base,
      seedResEdits: { r04: { cancelled: true, at: "x" }, r05: { date: "2026-11-07", start: "11:00", menuId: "cut", at: "y" } },
    };
    const raw = JSON.parse(JSON.stringify(s));
    raw.seedResEdits.bad = { date: "11/7", start: "11:00", menuId: "cut", at: "z" };
    const back = parseBook(JSON.stringify(raw))!;
    assert.deepEqual(back.seedResEdits, s.seedResEdits);
    assert.equal(view(back).all.some((r) => r.id === "r04"), false);
    assert.equal(resOf(back, "r05")!.date, "2026-11-07");
    // 直した分の無い台帳は今までと同じ形
    assert.equal("seedResEdits" in parseBook(JSON.stringify(base))!, false);
  });

  test("「翌日へ」「最初に戻す」で印が変わったら、古い中身は保存しない", () => {
    const mark = markOf(base, "r05");
    const next: BookState = { ...base, dayOffset: 1 };
    const a = cancelReservation(next, ctx, mark);
    assert.equal(a.ok, false);
    if (!a.ok) assert.equal(a.note, STALE_NOTE);
    const reset: BookState = { ...base, epoch: "r-new" };
    const b = changeReservation(reset, ctx, mark, { date: "2026-11-07", start: "11:00", menuId: "cut" });
    assert.equal(b.ok, false);
    if (!b.ok) assert.equal(b.note, STALE_NOTE);
  });
});

describe("6. ブラウザに書く（保存できなかった時・最初に戻す）", () => {
  const store = new Map<string, string>();
  let fail = false;
  const g = globalThis as { window?: unknown };
  let had: unknown;
  before(() => {
    had = g.window;
    g.window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          if (fail && k === BROWSER_PREFIX + BOOK_KEY) {
            const e = new Error("The quota has been exceeded.");
            e.name = "QuotaExceededError";
            throw e;
          }
          store.set(k, v);
        },
        removeItem: (k: string) => void store.delete(k),
      },
      addEventListener() {},
      removeEventListener() {},
    };
  });
  after(() => {
    g.window = had;
  });
  beforeEach(() => {
    store.clear();
    fail = false;
    writeBrowser(BOOK_KEY, JSON.stringify(base));
  });

  test("保存できなかった時は何も変わらない（台帳は前のまま・もう一度押せば変えられる）", () => {
    const mark = markOf(base, "r04");
    fail = true;
    let out: ReturnType<typeof cancelReservation> | null = null;
    const w = updateBook((s) => ((out = cancelReservation(s, ctx, mark)), out.state), "2026-11-04");
    assert.deepEqual(w, { ok: false, why: "full" });
    assert.ok(out);
    const now = parseBook(readBrowser(BOOK_KEY))!;
    assert.equal(now.seedResEdits, undefined);
    assert.ok(resOf(now, "r04"));
    fail = false;
    const w2 = updateBook((s) => cancelReservation(s, ctx, mark).state, "2026-11-04");
    assert.ok(w2.ok);
    assert.equal(resOf(parseBook(readBrowser(BOOK_KEY))!, "r04"), undefined);
    // 画面は ok の時だけ日誌を書く
    const sheet = read("src/app/reservations/ReservationSheet.tsx");
    assert.match(sheet, /if \(o\.ok && !w\.ok\) \{\s*setNote\(SAVE_FAILED_MESSAGE\);/);
  });

  test("「最初に戻す」1回で、最初の予約を直した分・予約サイトの番号・日報・休みの日・予約サイトの止めた時間が全部消え、印 epoch が変わる", () => {
    const s: BookState = { ...base, seedResEdits: { r04: { cancelled: true, at: "x" } }, siteSeq: 5, epoch: "r-old" };
    writeBrowser(BOOK_KEY, JSON.stringify(s));
    writeBrowser(DAILY_KEY, "{}");
    writeBrowser(HOLIDAYS_KEY, JSON.stringify(["2026-11-05"]));
    writeBrowser(SITE_STOPS_KEY, JSON.stringify(["2026-11-05 13:00"]));
    const out = resetAll("2026-11-04");
    assert.ok(out.written);
    assert.deepEqual(out.failed, []);
    for (const k of [DAILY_KEY, HOLIDAYS_KEY, SITE_STOPS_KEY]) assert.equal(readBrowser(k), null, k);
    assert.notEqual(parseBook(readBrowser(BOOK_KEY))!.epoch ?? "", "r-old");
    const back = parseBook(readBrowser(BOOK_KEY))!;
    assert.equal(back.seedResEdits, undefined);
    assert.equal(back.siteSeq, undefined);
    assert.ok(resOf(back, "r04"));
  });
});
