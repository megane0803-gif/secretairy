// 直しQ のテスト。Claude と LINE は呼ばない（決まった返事・置きかえた置き場所）。
// 1. 暦に無い日付（11/32・うるう年でない年の 2/29・4/31・00 月・00 日）を、日付を受け取る所の全部で断る。
//    台帳の行に混ざった時は外さずに相談全体を断る。空でよい欄が空なら通る。うるう年の 2/29・月末は通る。ふつうの日付の判定は今と同じ。
// 2. LINE のボタンで確定した時、ブラウザに書けた時だけ日誌と確定の返事。書けなければ承認待ちのまま・日誌なし・押しなおせる。
//    「最初に戻す」が途中で押されたら確定しない。同じボタン2回で確定が重ならない。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { checkDaily, isRealDate as dailyIsRealDate } from "../accounting/daily";
import { at, bookedAt, ctxAt, customers, menus, shop } from "../ai/__tests__/helpers";
import { parseReserveRequest } from "../ai/request";
import { findSlots, judgeSlot } from "../ai/slots";
import { runTool } from "../ai/tools";
import { parseHoldOffer } from "../ai/wire";
import { pendingAd, withProposal, type AdsState } from "../ads/state";
import { buildTable } from "../ads/report";
import { EMPTY_ADS } from "../ads/state";
import type { BrowserWrite } from "../browser";
import { approveBlocker } from "../book/approve";
import { changeReservation, openedMark, type ChangeContext } from "../book/change";
import { getBookData } from "../book/data";
import { ownerBook } from "../book/owner";
import { ledgerView, siteBook } from "../book/site";
import { parseSiteStops, siteStopsRaw } from "../book/siteStops";
import { emptyBook, parseBook, pendingApprovals, withApproved, withHold, type BookState } from "../book/state";
import { viewKey } from "../book/weekView";
import { addDays, calDay, dateFromMonthDay, isRealDate } from "../calendar";
import { getAds } from "../data/seed";
import { isRealDate as holidaysIsRealDate, readHolidays } from "../holidays";
import { parseLineAskRequest, runLineAsk, LINE_UNREAL_DATE_REASON } from "../line/ask";
import { applyPress } from "../line/apply";
import { commitPress, LINE_PRESS_FAILED, LINE_PRESS_RESET, type PressStore } from "../line/press";
import { readPick, type SortModel } from "../line/sort";
import type { ScreenEvent } from "../line/wire";
import { readList } from "../freee/run";
import { getRules } from "../rules/store";
import { judge } from "../rules/judge";
import { getAdSettings, getAiSettings, getLineSettings } from "../settings";

const ROOT = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const ai = getAiSettings();
const NOW = at("2026-11-04", "09:00");
const nowIso = NOW.toISOString();

/** 暦に無い日付（11/32・うるう年でない年の 2/29・4/31・00 月・00 日） */
const BAD = ["2026-11-32", "2027-02-29", "2026-04-31", "2026-00-10", "2026-11-00"];
/** 暦にある日付（うるう年の 2/29・月末） */
const GOOD = ["2028-02-29", "2027-01-31", "2027-04-30"];

describe("1-1. 本当の日付の確かめは1か所", () => {
  test("暦に無い日付は false、うるう年の 2/29・月末は true", () => {
    for (const d of BAD) assert.equal(isRealDate(d), false, d);
    for (const d of GOOD) assert.equal(isRealDate(d), true, d);
    for (const x of ["", "2026-11-6", "11/6", 20261106, null, undefined]) assert.equal(isRealDate(x), false, String(x));
  });

  test("経理の日報・休みの日は同じ物を使い、日報の確かめは今と同じ", () => {
    assert.equal(dailyIsRealDate, isRealDate);
    assert.equal(holidaysIsRealDate, isRealDate);
    for (const [d, ok] of [
      ["2026-11-06", true],
      ["2026-02-29", false],
      ["2028-02-29", true],
      ["2026-13-01", false],
      ["1899-12-31", false],
      ["1900-01-01", true],
      ["2026-1-06", false],
    ] as const)
      assert.equal(dailyIsRealDate(d), ok, d);
    const c = checkDaily({ date: "2026-11-31", visits: "1", pay: {}, split: { total: "", tech: "", retail: "" } }, { today: "2026-12-05", methods: [], limits: {} as never, shop });
    assert.equal(c.ok, false);
    assert.ok(c.errors.some((e) => e.field === "date" && e.text === "本当にある日付を選んでください。"));
  });

  test("ほかに本当の日付を確かめる式を作らない（Date.UTC で回した後に比べる書き方は calendar.ts だけ）", () => {
    for (const f of ["src/lib/holidays.ts", "src/lib/accounting/daily.ts", "src/lib/posts/closed.ts", "src/lib/ai/tools.ts", "src/lib/ai/request.ts", "src/lib/ai/wire.ts"])
      assert.doesNotMatch(read(f), /toISOString\(\)\.slice\(0, 10\) ===|getUTCDate\(\) === d/, f);
    assert.equal(dateFromMonthDay("2026-11-04", 2, 30), null);
    assert.equal(dateFromMonthDay("2026-11-04", 11, 30), "2026-11-30");
  });

  test("暦に無い日付は開いていない日（次の月に回した日の営業時間で受けない）", () => {
    for (const d of BAD) assert.equal(calDay(shop, d).open, false, d);
    assert.equal(calDay(shop, "2026-11-05").open, true);
  });
});

describe("1-2. AI の道具の引数", () => {
  const ctx = () => ctxAt(NOW);
  test("date・dates に暦に無い日付が来たら断る", () => {
    for (const d of BAD) {
      for (const name of ["check_rules", "place_hold", "find_openings"]) {
        const o = runTool(ctx(), name, { menu_ids: ["cut"], date: d, start: "15:00" });
        assert.equal(o.isError, true, `${name} ${d}`);
        assert.match(o.content, /date は暦にある日付（YYYY-MM-DD）で入れてください/);
        assert.equal(o.hold, undefined);
      }
      const many = runTool(ctx(), "find_openings", { menu_ids: ["cut"], dates: ["2026-11-05", d] });
      assert.equal(many.isError, true, d);
      assert.match(many.content, /dates は暦にある日付（YYYY-MM-DD）の並びで入れてください/);
    }
  });

  test("同じ日の予約で埋まっていても、次の月に回る日付ですり抜けない（11/5 を 10/36 と書いても断る）", () => {
    const c = ctx();
    const ok = findSlots(c, "cut", { date: "2026-11-05" }).slots[0];
    assert.ok(ok);
    const sneaky = runTool(c, "check_rules", { menu_ids: ["cut"], date: "2026-10-36", start: ok.start });
    assert.equal(sneaky.isError, true);
    assert.equal(judgeSlot(c, { menuId: "cut", date: "2026-10-36", start: ok.start }).ok, false);
  });

  test("空でよい欄が空なら今どおり通る。うるう年の 2/29・月末は形の断りにならない", () => {
    const o = runTool(ctx(), "find_openings", { menu_ids: ["cut"], month: "", weekday: "", after: "" });
    assert.notEqual(o.isError, true, o.content);
    for (const d of GOOD) {
      const g = runTool(ctx(), "find_openings", { menu_ids: ["cut"], date: d });
      assert.doesNotMatch(g.content, /暦にある日付/, d);
    }
  });
});

describe("1-3. 画面から送られる相談の中身", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    mode: "script",
    messages: [{ role: "user", text: "カット" }],
    candidates: [],
    customer: { id: "c04", surname: "江口", firstVisit: false },
    booked: bookedAt(NOW),
    rules: [],
    visits: [],
    dayOffset: 0,
    ...over,
  });

  test("台帳の行に暦に無い日付が混ざったら、その行を外さずに相談全体を断る", () => {
    const rows = bookedAt(NOW);
    for (const d of BAD) {
      const p = parseReserveRequest(body({ booked: [...rows, { ...rows[0], id: "x-1", date: d }] }), menus, ai);
      assert.equal(p.ok, false, d);
      if (!p.ok) assert.match(p.reason, /台帳の日付は暦にある日付（YYYY-MM-DD）で入れてください/);
    }
  });

  test("ふつうの台帳は今どおり受け取る（行の数も同じ）", () => {
    const p = parseReserveRequest(body(), menus, ai);
    assert.ok(p.ok);
    if (p.ok) assert.equal(p.value.booked.length, bookedAt(NOW).length);
  });

  test("候補・前回の来店の暦に無い日付は受け取らない。休みの日も断る", () => {
    for (const d of BAD) {
      const p = parseReserveRequest(body({ candidates: [{ menuId: "cut", date: d, start: "15:00" }], visits: [{ customerId: "c04", menuId: "cut", date: d }] }), menus, ai);
      assert.ok(p.ok);
      if (p.ok) {
        assert.equal(p.value.candidates.length, 0, d);
        assert.equal(p.value.visits.length, 0, d);
      }
      assert.equal(parseReserveRequest(body({ holidays: [d] }), menus, ai).ok, false, d);
      assert.equal(readHolidays([d], shop).ok, false, d);
    }
    const ok = parseReserveRequest(body({ candidates: [{ menuId: "cut", date: "2027-01-31", start: "15:00" }] }), menus, ai);
    assert.ok(ok.ok && ok.value.candidates.length === 1);
  });

  test("サーバーから来た仮押さえも、暦に無い日付なら受け取らない", () => {
    const h = { id: "h1", customerId: "c01", menuId: "cut", date: "2026-11-05", start: "15:00", heldAt: nowIso, expiresAt: nowIso, reason: "r" };
    assert.ok(parseHoldOffer(h));
    for (const d of BAD) assert.equal(parseHoldOffer({ ...h, date: d }), null, d);
  });
});

describe("1-4. ルールの判定と承認の箱", () => {
  test("判定の入口で、暦に無い日付は受けない（店の設定の確かめ・ルールに進まない）", () => {
    const c = ctxAt(NOW);
    for (const d of BAD) {
      const v = judgeSlot(c, { menuId: "cut", date: d, start: "15:00" });
      assert.equal(v.ok, false, d);
      assert.deepEqual(v.base.map((b) => b.id), ["real-date"]);
    }
    // 入っている予約の側に暦に無い日付があっても受けない（数え落とさない）
    const v = judge({
      rules: getRules(),
      booking: { date: "2026-11-05", start: "15:00", menuIds: ["cut"], newCustomer: false },
      now: { date: "2026-11-04", time: "09:00" },
      hours: calDay(shop, "2026-11-05").hours,
      seats: shop.seats,
      menus,
      existing: [{ date: "2026-11-35", start: "15:00", menuIds: ["cut"], newCustomer: false }],
    });
    assert.equal(v.ok, false);
  });

  test("ふつうの日付の判定は今と同じ（確かめる項目と答え）", () => {
    const c = ctxAt(NOW);
    const slot = findSlots(c, "cut", { date: "2026-11-05" }).slots[0];
    const v = judgeSlot(c, slot);
    assert.equal(v.ok, true);
    assert.deepEqual(v.base.map((b) => b.id), ["future", "hours", "menu-last", "seats"]);
    const past = judgeSlot(c, { menuId: "cut", date: "2026-11-03", start: "15:00" });
    assert.equal(past.base.find((b) => b.id === "future")?.ok, false);
  });

  test("承認の箱：暦に無い日付の仮押さえは確定しない。ふつうの日付は今どおり", () => {
    const now = { date: "2026-11-04", time: "09:00" };
    for (const d of BAD) assert.match(approveBlocker(shop, now, { date: d, start: "15:00" }) ?? "", /日付が暦にないので確定できません/, d);
    assert.equal(approveBlocker(shop, now, { date: "2026-11-05", start: "15:00" }), null);
  });

  test("LINE の承認のボタンも、暦に無い日付の仮押さえは確定しない", () => {
    const book = withHold(emptyBook("2026-11-04"), { id: "h1", customerId: "c01", menuId: "cut", date: "2026-11-32", start: "15:00", heldAt: nowIso, expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(), reason: "r" });
    const ev: ScreenEvent = { id: "e1", at: nowIso, kind: "press", approvalId: "ap-h1", target: "reservation", how: "approve" };
    const out = applyPress(ev, book, EMPTY_ADS, { shop, menus, customers, nowIso, today: "2026-11-04", now: { date: "2026-11-04", time: "09:00" }, adSettings: getAdSettings() });
    assert.equal(out.book, book);
    assert.match(out.reply, /^✗ 確定しませんでした/);
  });
});

describe("1-5. 台帳から入れる・予約を直す・予約サイト・LINE の一言", () => {
  const data = getBookData();
  const rules = getRules();
  const OWN_NOW = new Date("2026-11-04T08:30:00+09:00");
  const base = emptyBook("2026-11-04");

  test("台帳から入れる：暦に無い日付は入れない。ふつうの日付は今どおり", () => {
    for (const d of BAD) {
      const out = ownerBook(base, { data, rules, now: OWN_NOW, newId: () => "own-x" }, { customerId: "c01", menuId: "cut", date: d, start: "15:00" });
      assert.equal(out.ok, false, d);
      if (!out.ok) assert.ok(out.check?.blocked.some((l) => l.key === "base:real-date"), d);
    }
    assert.ok(ownerBook(base, { data, rules, now: OWN_NOW, newId: () => "own-x" }, { customerId: "c01", menuId: "cut", date: "2026-11-06", start: "15:00" }).ok);
  });

  test("予約を直す：暦に無い日付には変えない", () => {
    const ctx: ChangeContext = { data, rules, now: OWN_NOW, kartes: [] };
    const v = ledgerView(data, base, OWN_NOW);
    const mark = openedMark(viewKey(base.epoch, v.clock.dayOffset), v.all.find((r) => r.id === "r04")!);
    for (const d of BAD) {
      const out = changeReservation(base, ctx, mark, { date: d, start: "14:00", menuId: "cut_color" });
      assert.equal(out.ok, false, d);
    }
    assert.ok(changeReservation(base, ctx, mark, { date: "2026-11-05", start: "14:00", menuId: "cut_color" }).ok);
  });

  test("予約サイト：暦に無い日付の仮押さえと同じ枠には入れない。止めた時間の暦に無い日付は落とす", () => {
    for (const d of BAD) {
      const held: BookState = withHold(base, { id: "h-1", customerId: "c04", menuId: "cut", date: d, start: "16:00", heldAt: OWN_NOW.toISOString(), expiresAt: "2026-12-31T00:00:00.000Z", reason: "r" });
      const out = siteBook(held, { data, rules, now: OWN_NOW }, "onHold");
      assert.equal(out.ok, false, d);
      assert.deepEqual(parseSiteStops(siteStopsRaw([`${d} 10:00`, "2026-11-05 10:00"])), ["2026-11-05 10:00"]);
    }
  });

  test("経理の freee から読んだ一覧：暦に無い日付の行は落とし、ふつうの行は今どおり", () => {
    const row = { id: 1, account: "card", side: "expense", date: "2026-11-05", amount: 1000, description: "テスト" };
    const list = readList({ range: { from: "2026-10-01", to: "2026-11-30" }, rows: [row, { ...row, id: 2, date: "2026-11-31" }] }, nowIso);
    assert.deepEqual(list?.rows.map((r) => r.id), [1]);
  });

  test("ブラウザに残った台帳：暦に無い日付の予約は読まない（形のおかしい物と同じ）", () => {
    const raw = JSON.stringify({ ...base, chat: [{ id: "h1", customerId: "c01", menuId: "cut", date: "2026-11-31", start: "15:00", status: "hold", heldAt: nowIso, expiresAt: nowIso }] });
    assert.equal(parseBook(raw)?.chat.length, 0);
  });

  test("LINE の一言：暦に無い日にちは仮押さえしない。日にちが空なら今どおり聞き返す", async () => {
    const parsed = parseLineAskRequest(
      { mode: "script", text: "〔お客様〕さんカットで仮押さえ", customer: { id: "c01", surname: "青木", firstVisit: false }, booked: bookedAt(NOW), rules: [], dayOffset: 0 },
      menus,
      ai,
      getLineSettings().maxTextChars,
    );
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    const fixed = (date: string): SortModel => ({ pick: async () => ({ name: "hold_request", input: { menu_id: "cut", date, start: "15:00" } }) });
    for (const d of BAD) {
      const res = await runLineAsk({ req: parsed.value, shop, menus, model: fixed(d), maxTokens: 300, now: NOW });
      assert.ok(res.ok);
      if (res.ok) assert.equal(res.kind, "hold-no", d);
      if (res.ok && res.kind === "hold-no") assert.equal(res.reason, LINE_UNREAL_DATE_REASON);
    }
    const empty = await runLineAsk({ req: parsed.value, shop, menus, model: fixed(""), maxTokens: 300, now: NOW });
    assert.ok(empty.ok && empty.kind === "hold-missing");
    const good = await runLineAsk({ req: parsed.value, shop, menus, model: fixed(findSlots(ctxAt(NOW, {}, "c01"), "cut", { date: "2026-11-05" }).slots[0].date), maxTokens: 300, now: NOW });
    assert.ok(good.ok && good.kind !== "hold-missing");
    assert.deepEqual(readPick({ name: "hold_request", input: { menu_id: "cut", date: "", start: "15:00" } }, menus), { kind: "hold", menuId: "cut", date: "", start: "15:00" });
  });
});

describe("2. LINE のボタンで確定した時に、書けたかを見る", () => {
  const ctx = () => ({ shop, menus, customers, nowIso, today: "2026-11-04", now: { date: "2026-11-04", time: "09:00" }, adSettings: getAdSettings() });
  const held = (): BookState => {
    const slot = findSlots(ctxAt(NOW), "cut", { date: addDays("2026-11-04", 1) }).slots[0];
    return withHold({ ...emptyBook("2026-11-04"), epoch: "r-1" }, { id: "h1", customerId: "c01", ...slot, heldAt: nowIso, expiresAt: new Date(NOW.getTime() + 24 * 3600_000).toISOString(), reason: "テスト" });
  };
  const press = (over: Partial<Extract<ScreenEvent, { kind: "press" }>> = {}): Extract<ScreenEvent, { kind: "press" }> => ({
    id: "e1",
    at: nowIso,
    kind: "press",
    approvalId: "ap-h1",
    target: "reservation",
    how: "approve",
    ...over,
  });

  /** このプロセスの中の置き場所。fail = 書く時の答え（"ok"・"full"・"throw"） */
  function memory(book: BookState, ads: AdsState = EMPTY_ADS) {
    const m = { book, ads, bookFail: "ok" as "ok" | "full" | "throw", adsFail: "ok" as "ok" | "full" | "throw", writes: 0 };
    const write = (how: "ok" | "full" | "throw", set: () => void): BrowserWrite => {
      m.writes += 1;
      if (how === "throw") throw new Error("書けない");
      if (how === "full") return { ok: false, why: "full" };
      set();
      return { ok: true };
    };
    const store: PressStore = {
      readBook: () => m.book,
      writeBook: (next) => write(m.bookFail, () => (m.book = next)),
      readAds: () => m.ads,
      writeAds: (next) => write(m.adsFail, () => (m.ads = next)),
    };
    return { m, store };
  }

  test("書けた時だけ、日誌と確定の返事", () => {
    const { m, store } = memory(held());
    const out = commitPress(press(), store, ctx(), "r-1");
    assert.equal(out.written, true);
    assert.equal(m.book.chat[0].status, "confirmed");
    assert.match(out.journal[0].text, /^承認（LINE のボタン）：/);
    assert.match(out.reply, /^✓ 確定しました：/);
  });

  for (const fail of ["full", "throw"] as const)
    test(`書けなかった時（${fail === "throw" ? "例外" : "いっぱい"}）は確定せず、承認待ちが残り、もう一度押せば確定できる`, () => {
      const { m, store } = memory(held());
      m.bookFail = fail;
      const out = commitPress(press(), store, ctx(), "r-1");
      assert.equal(out.written, false);
      assert.equal(out.failed, true);
      assert.deepEqual(out.journal, []);
      assert.equal(out.reply, LINE_PRESS_FAILED.approve);
      assert.equal(m.book.chat[0].status, "hold");
      assert.equal(pendingApprovals(m.book, nowIso).length, 1);
      m.bookFail = "ok";
      const again = commitPress(press({ id: "e2" }), store, ctx(), "r-1");
      assert.equal(again.written, true);
      assert.equal(m.book.chat[0].status, "confirmed");
      // 画面の承認の箱で押しなおしても同じ変え方で確定できる
      assert.equal(withApproved(held(), "ap-h1", nowIso).chat[0].status, "confirmed");
    });

  test("見送りも、書けなかった時は仮押さえを外さない", () => {
    const { m, store } = memory(held());
    m.bookFail = "full";
    const out = commitPress(press({ how: "skip" }), store, ctx(), "r-1");
    assert.equal(out.reply, LINE_PRESS_FAILED.skip);
    assert.deepEqual(out.journal, []);
    assert.equal(pendingApprovals(m.book, nowIso).length, 1);
  });

  test("「最初に戻す」の印が受け取り始めた時と違えば、確定しない（何も書かない）", () => {
    const { m, store } = memory(held());
    const out = commitPress(press(), store, ctx(), "r-0");
    assert.equal(out.written, false);
    assert.equal(out.reply, LINE_PRESS_RESET);
    assert.deepEqual(out.journal, []);
    assert.equal(m.writes, 0);
    assert.equal(m.book.chat[0].status, "hold");
  });

  test("同じボタンが2回届いても確定は重ならない。書けた後に返事が失敗しても確定は1回", () => {
    const { m, store } = memory(held());
    const first = commitPress(press(), store, ctx(), "r-1");
    assert.equal(first.written, true);
    const confirmed = m.book;
    // 返事が失敗した（LINE に届かなかった）としても、同じ知らせがもう一度来た時は何も変えない
    const again = commitPress(press(), store, ctx(), "r-1");
    assert.equal(again.written, false);
    assert.deepEqual(again.journal, []);
    assert.equal(m.book, confirmed);
    assert.equal(m.book.chat.filter((r) => r.status === "confirmed").length, 1);
    assert.equal(m.writes, 1);
  });

  test("広告の案：広告が書けなければ台帳（ToDo）も前に戻し、案は承認待ちのまま", () => {
    const table = buildTable(getAds(), getAdSettings());
    const row = table.keywords[0];
    const ads = withProposal(EMPTY_ADS, { action: "stop", no: row.no, text: row.text, reason: "予約につながっていません。" }, table, { id: "ad1", checks: [], nowIso, mode: "script" }, getAdSettings());
    const book0: BookState = { ...emptyBook("2026-11-04"), epoch: "r-1" };
    const { m, store } = memory(book0, ads);
    m.adsFail = "full";
    const out = commitPress(press({ approvalId: "ad1", target: "ad" }), store, ctx(), "r-1");
    assert.equal(out.written, false);
    assert.equal(out.reply, LINE_PRESS_FAILED.approve);
    assert.deepEqual(out.journal, []);
    assert.equal(m.book, book0);
    assert.equal(pendingAd(m.ads)?.id, "ad1");
    m.adsFail = "ok";
    const again = commitPress(press({ id: "e2", approvalId: "ad1", target: "ad" }), store, ctx(), "r-1");
    assert.equal(again.written, true);
    assert.equal(pendingAd(m.ads), null);
    assert.equal(m.book.todos.length, 1);
  });

  test("画面は LINE のボタンを commitPress に通し、受け取り始めた時の印を渡す", () => {
    const src = read("src/components/LineBridge.tsx");
    assert.match(src, /commitPress\(ev, pressStore\(\), applyCtx\(\), epoch\)/);
    assert.match(src, /const epoch = currentEpoch\(\);\s*const res = await lineApi\.poll\(token\);/);
    assert.doesNotMatch(src, /applyPress\(/);
    assert.match(read("src/lib/ads/useAds.ts"), /=> writeAdsState\(f\(readAdsState\(\)\)\)/);
  });
});
