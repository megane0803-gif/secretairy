// 台帳から予約を入れる（オーナーが入れる＝確定。docs/SPEC.md §1.4.1）のテスト。Claude は呼ばない（AI を使わない流れ）。
// - 予約チャット・承認の箱と同じ判定（judgeSlot）で確かめる
// - 入れられない：過ぎた日時・営業時間の外・最終受付・定休日と休みの日・同じ時間に受ける人数（重なり）
// - もう一度押せば入れられる：オーナーが足したルールに当たる時だけ（どのルールかを出し、日誌にも名前を残す）
// - 保存する直前に、その時の台帳でもう一度確かめる
// - 入れた予約は確定で台帳へ（承認の箱は通さない）。札は「台帳から（オーナー）」。前日のお知らせ・空き表にも入る

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { reservationActor } from "../../actors";
import { comboIdOf } from "../../combo";
import { withHolidays } from "../../holidays";
import { dayBeforeReminders } from "../../reminder";
import { resolveChatReservations, type ChatReservation } from "../../reservations";
import { getRules } from "../../rules/store";
import { getBookData } from "../data";
import { ownerBook, ownerCheck, ownerSlotContext, OWNER_TAG, type OwnerContext } from "../owner";
import { ledgerView } from "../site";
import { emptyBook, parseBook, pendingApprovals, type BookState } from "../state";
import { bandTitle, freeCells, timetable } from "../timetable";

const ROOT = join(__dirname, "../../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const data = getBookData();
const rules = getRules();
// 水曜の朝（開店前）に開いた
const NOW = new Date("2026-11-04T08:30:00+09:00");
const ctx: OwnerContext = { data, rules, now: NOW, newId: () => "own-t1" };
const start = emptyBook("2026-11-04");

const check = (s: BookState, customerId: string, menuId: string, date: string, time: string, c: OwnerContext = ctx) =>
  ownerCheck(ownerSlotContext(s, c, customerId)!, { menuId, date, start: time });

describe("1. 入れられない（店の基礎の判定。もう一度押しても入れない）", () => {
  const cases: [string, string, string, string, string][] = [
    ["過ぎた日時", "cut", "2026-11-02", "15:00", "base:future"],
    ["営業時間の外（開店より前）", "cut", "2026-11-05", "09:00", "base:hours"],
    ["最終受付を過ぎる（カラーは18:00まで）", "color", "2026-11-05", "18:30", "base:menu-last"],
    ["定休日（火曜）", "cut", "2026-11-10", "15:00", "base:open-day"],
    ["同じ時間に受ける人数を超える（江口様の 13:00 に重なる）", "cut", "2026-11-05", "14:00", "base:seats"],
  ];
  for (const [what, menuId, date, time, key] of cases)
    test(what, () => {
      const c = check(start, "c01", menuId, date, time);
      assert.ok(c.blocked.some((l) => l.key === key), JSON.stringify(c.blocked));
      const out = ownerBook(start, ctx, { customerId: "c01", menuId, date, start: time }, c.rules.map((r) => r.key));
      assert.equal(out.ok, false);
      assert.equal(out.state, start);
    });

  test("休みの日（予約のページで決めた日）", () => {
    const hol: OwnerContext = { ...ctx, data: { ...data, shop: withHolidays(data.shop, ["2026-11-05"]) } };
    const c = check(start, "c01", "cut", "2026-11-05", "10:00", hol);
    assert.ok(c.blocked.some((l) => l.key === "base:open-day"));
    assert.equal(ownerBook(start, hol, { customerId: "c01", menuId: "cut", date: "2026-11-05", start: "10:00" }).ok, false);
  });
});

describe("2. オーナーが足したルールに当たる時だけ、もう一度押せば入れられる", () => {
  test("来店の3時間前まで（今日 11:00 は 2時間半前）：1回目は入れず、ルールの名前を出す", () => {
    const c = check(start, "c01", "cut", "2026-11-04", "11:00");
    assert.equal(c.blocked.length, 0);
    assert.deepEqual(c.rules.map((r) => r.key), ["rule:seed-lead-time"]);
    assert.equal(c.rules[0].name, "予約は来店の3時間前まで");
    assert.equal(c.rules[0].scope, "全体");
    const first = ownerBook(start, ctx, { customerId: "c01", menuId: "cut", date: "2026-11-04", start: "11:00" });
    assert.equal(first.ok, false);
    if (!first.ok) assert.match(first.note, /もう一度押すと入れられます/);
  });

  test("2回目（当たるルールを見て押した）：入る。日誌にルールの名前も残す", () => {
    const out = ownerBook(start, ctx, { customerId: "c01", menuId: "cut", date: "2026-11-04", start: "11:00" }, ["rule:seed-lead-time"]);
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.equal(out.journal[0].who, "オーナー");
    assert.equal(out.journal[0].text, "台帳から予約を入れた（青木（架空）様 11/4（水） 11:00–12:00 カット）。ルール「予約は来店の3時間前まで」に当たったが、オーナーが確かめて入れた");
  });

  test("メニューごとのルール（縮毛矯正は24時間前まで）も、もう一度押せば入れられる", () => {
    // お昼に開いて、明日 10:00 の縮毛矯正（22時間前）
    const noon: OwnerContext = { ...ctx, now: new Date("2026-11-04T12:00:00+09:00") };
    const c = check(start, "c02", "straight", "2026-11-05", "10:00", noon);
    assert.equal(c.blocked.length, 0);
    assert.ok(c.rules.some((r) => r.key === "rule:seed-straight-lead" && r.scope === "メニュー：縮毛矯正"));
  });

  test("見たルールと別のルールに当たるようになったら、もう一度見せる（入れない）", () => {
    const out = ownerBook(start, ctx, { customerId: "c01", menuId: "cut", date: "2026-11-04", start: "11:00" }, ["rule:seed-new-per-day"]);
    assert.equal(out.ok, false);
  });

  test("何も当たらなければ1回で入る（日誌にルールの名前は無い）", () => {
    const out = ownerBook(start, ctx, { customerId: "c01", menuId: "cut", date: "2026-11-05", start: "10:00" });
    assert.ok(out.ok);
    if (out.ok) assert.equal(out.journal[0].text, "台帳から予約を入れた（青木（架空）様 11/5（木） 10:00–11:00 カット）");
  });
});

describe("3. 保存する直前に、その時の台帳でもう一度確かめる", () => {
  test("画面で確かめた後に、別の窓（予約サイト）で同じ枠が埋まったら入れない", () => {
    const input = { customerId: "c01", menuId: "cut", date: "2026-11-05", start: "10:00" };
    assert.equal(check(start, "c01", "cut", "2026-11-05", "10:00").ok, true);
    const taken: ChatReservation = { id: "site-1", customerId: "c02", menuId: "cut", date: "2026-11-05", start: "10:00", status: "confirmed", heldAt: NOW.toISOString(), expiresAt: NOW.toISOString(), via: "site" };
    const later: BookState = { ...start, chat: [taken] };
    const out = ownerBook(later, ctx, input);
    assert.equal(out.ok, false);
    if (!out.ok) assert.ok(out.check?.blocked.some((l) => l.key === "base:seats"));
    assert.equal(out.state, later);
  });

  test("画面は book.update の中（書く直前に読みなおした台帳）で ownerBook を呼ぶ。人が押した時だけ", () => {
    const sheet = read("src/app/reservations/OwnerBookSheet.tsx");
    assert.match(sheet, /const w = book\.update\(\(s\) => \{\s*out = ownerBook\(s, \{ \.\.\.ctx, startedEpoch/);
    // 書けなかった時は「入れました」と言わない（直しA の形）
    assert.match(sheet, /if \(o\.ok && !w\.ok\) return setNote\(SAVE_FAILED_MESSAGE\);/);
    assert.match(sheet, /if \(!e\.nativeEvent\.isTrusted/);
    // 入れられない時は押せない
    assert.match(sheet, /disabled=\{!check \|\| check\.blocked\.length > 0\}/);
  });
});

describe("4. 入れた後：確定・札・承認の箱は通らない・ほかの所にも入る", () => {
  const out = ownerBook(start, ctx, { customerId: "c04", menuId: comboIdOf(data.menus, ["cut", "headspa"])!, date: "2026-11-05", start: "10:00" });
  assert.ok(out.ok);
  const s = out.ok ? out.state : start;

  test("確定で台帳に入る（承認の箱の行は増えない）。組み合わせは時間を足す", () => {
    assert.equal(s.chat.length, 1);
    assert.equal(s.chat[0].status, "confirmed");
    assert.equal(s.chat[0].via, "owner");
    assert.equal(s.chat[0].menuId, "cut+headspa");
    assert.equal(s.approvals.length, 0);
    assert.equal(pendingApprovals(s, NOW.toISOString()).length, 0);
    const r = resolveChatReservations(data.menus, data.customers, s.chat)[0];
    assert.equal(r.end, "11:30");
  });

  test("札は「台帳から（オーナー）」（人がした事）。ブラウザに残しても読み戻せる", () => {
    const r = resolveChatReservations(data.menus, data.customers, s.chat)[0];
    assert.equal(r.source, "owner");
    assert.equal(reservationActor(r), "human");
    assert.equal(OWNER_TAG, "台帳から（オーナー）");
    const back = parseBook(JSON.stringify(s))!;
    assert.equal(back.chat[0].via, "owner");
    const view = ledgerView(data, back, NOW);
    const week = timetable(
      view.all.length ? [{ ...view.clock.today, isToday: true, reservations: view.all.filter((x) => x.date === "2026-11-05"), usedMinutes: 0, capacityMinutes: 0 }] : [],
    );
    const band = week.columns[0].bands.find((b) => b.id === s.chat[0].id)!;
    assert.equal(band.owner, true);
    assert.match(bandTitle(band), /確定（台帳から（オーナー））/);
  });

  test("前日のお知らせ・予約サイトの空き（確定の予約）にも入る", () => {
    const view = ledgerView(data, s, NOW);
    const list = dayBeforeReminders(view.all, "2026-11-05", "{time} {menu}", "omochi");
    assert.ok(list.some((x) => x.reservationId === s.chat[0].id && x.start === "10:00"));
    assert.ok(view.all.some((r) => r.id === s.chat[0].id && r.status === "confirmed"));
  });

  test("台帳の時間割・日ごとのカードに「入れる」入口。時間割は空いたマスだけ押せる", () => {
    assert.match(read("src/app/reservations/TimetableGrid.tsx"), /className="tt-pick"/);
    assert.match(read("src/app/reservations/Ledger.tsx"), /<FreeTimes book=\{book\} day=\{d\} onPick=\{onPick\} \/>/);
    const day = { date: "2026-11-05", label: "11/5（木）", key: "thu" as const, hours: { open: "10:00", close: "20:00" }, open: true, isToday: false, reservations: ledgerView(data, start, NOW).all.filter((r) => r.date === "2026-11-05"), usedMinutes: 0, capacityMinutes: 0 };
    const cells = freeCells(day, 1, 30, { date: "2026-11-04", time: "08:30" }).map((c) => c.from);
    // 江口様の 13:00–15:00 は押せない
    assert.ok(!cells.includes(13 * 60) && !cells.includes(14 * 60 + 30));
    assert.ok(cells.includes(10 * 60) && cells.includes(15 * 60));
  });
});

describe("5. 「最初に戻す」より前に開いた入力は使わない（直しA の形）", () => {
  test("開いた時の印と書く時の台帳の印が違えば入れない。同じなら入る", () => {
    const before: BookState = { ...start, epoch: "e1" };
    const after: BookState = { ...start, epoch: "e2" };
    const input = { customerId: "c01", menuId: "cut", date: "2026-11-05", start: "10:00" };
    const stale = ownerBook(after, { ...ctx, startedEpoch: { epoch: "e1" } }, input);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.match(stale.note, /最初に戻したので/);
    assert.equal(stale.state, after);
    assert.ok(ownerBook(before, { ...ctx, startedEpoch: { epoch: "e1" } }, input).ok);
  });
});
