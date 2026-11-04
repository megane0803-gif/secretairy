// 予約サイト（架空）→ 台帳の向き（docs/SPEC.md §1.4）。Claude は呼ばない（AI を使わない流れ）。
// - 「ここで予約が入る（デモ）」：架空のお客様の予約が、空いている枠に1件、確定で台帳に入る（承認の箱は通さない）
// - 入った枠は空きから外れる（予約チャット・朝の要点の空き枠・発信の空き枠・予約サイトの ○△×）
// - 仮押さえと同じ枠に入ったら、仮押さえを外し、ToDo に「○○（架空）様に別の日時を案内」を今日中として足す
// - 同じ時間に受ける人数を守る
// - 「最初に戻す」で戻る

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { judgeSlot, type SlotContext } from "../../ai/slots";
import { TOOL_DEFS } from "../../ai/tools";
import type { HoldOffer } from "../../ai/wire";
import { BOOK_KEY } from "../../browser";
import { calDay, demoClock } from "../../calendar";
import { withSeats } from "../../capacity";
import { getJobSeeds } from "../../data/seed";
import { parseJournal, withEntries } from "../../journal";
import { openRanges } from "../../posts/facts";
import { checkSeats, freeRanges, loadBook, resolveChatReservations, sortReservations } from "../../reservations";
import { resetAllWrites } from "../../reset";
import { getRules } from "../../rules/store";
import { fullSlotTodos } from "../../todo/full";
import { reserveKey } from "../../todo/keys";
import { getBookData, type BookData } from "../data";
import { siteBook, siteCount, SITE_WHO } from "../site";
import { activeChat, emptyBook, parseBook, pendingApprovals, withHold, type BookState } from "../state";

const ROOT = join(__dirname, "../../../..");
const base = getBookData();
const rules = getRules();
// 水曜の朝（開店前）に開いた
const NOW = new Date("2026-11-04T08:30:00+09:00");
const NOW_ISO = NOW.toISOString();
const clock = demoClock(base.shop, NOW, 0);
const TODAY = clock.today.date;

/** 画面（useBook）と同じ組み立て方の台帳 */
function view(data: BookData, s: BookState) {
  const anchor = calDay(data.shop, s.anchor);
  const chat = resolveChatReservations(data.menus, data.customers, activeChat(s, NOW_ISO));
  const book = loadBook(data.shop, data.menus, clock.today, anchor.open ? anchor : clock.today, chat);
  const all = sortReservations(book.all);
  const booked = all.map((r) => ({
    id: r.id,
    customerId: r.customer.id,
    menuId: r.menu.id,
    date: r.date,
    start: r.start,
    status: r.status,
    newCustomer: r.customer.firstVisit,
  }));
  return { book, all, booked };
}

const ctxFor = (data: BookData, s: BookState, customerId: string): SlotContext => {
  const c = data.customers.find((x) => x.id === customerId)!;
  return {
    shop: data.shop,
    menus: data.menus,
    rules,
    booked: view(data, s).booked,
    customer: { id: c.id, surname: c.surname, firstVisit: c.firstVisit },
    now: clock.now,
    today: clock.today,
  };
};

/** 予約チャットで入った仮押さえのつもり（承認待ち） */
const hold = (over: Partial<HoldOffer> = {}): HoldOffer => ({
  id: "h1",
  customerId: "c04",
  menuId: "cut",
  date: "2026-11-06",
  start: "15:00",
  heldAt: "2026-11-04T00:00:00.000Z",
  expiresAt: "2026-11-05T23:00:00.000Z",
  reason: "お客様が候補から選びました",
  ...over,
});

const press = (s: BookState, mode: "free" | "onHold", data: BookData = base) => siteBook(s, { data, rules, now: NOW }, mode);

describe("1. ここで予約が入る（デモ）：空いている枠に1件", () => {
  test("架空のお客様の予約が、確定で台帳に入る（札は「予約サイトから」・承認の箱は通さない）", () => {
    const s0 = emptyBook(TODAY);
    const o = press(s0, "free");
    assert.ok(o.ok, o.ok ? "" : o.note);
    if (!o.ok) return;
    assert.equal(o.placed.status, "confirmed");
    assert.equal(o.placed.via, "site");
    assert.equal(siteCount(o.state), 1);
    assert.equal(o.state.approvals.length, 0, "承認の箱に行は入らない");
    assert.equal(pendingApprovals(o.state, NOW_ISO).length, 0);
    const r = view(base, o.state).all.find((x) => x.id === o.placed.id);
    assert.equal(r?.source, "site", "台帳では「予約サイトから」");
    assert.ok(r?.customer.fictional, "架空のお客様");
    // 日誌に1行（だれ = 予約サイト。札は「外 予約サイト」）
    assert.equal(o.journal.length, 1);
    assert.equal(o.journal[0].who, SITE_WHO);
    assert.match(o.journal[0].text, /^予約サイト（架空）から1件入った：.+（架空）様 /);
    assert.equal(parseJournal(JSON.stringify(withEntries([], o.journal)))[0].who, "予約サイト", "日誌に残せる形");
  });

  test("入った枠は、店の設定とルール（judge.ts）で受けられる枠。今より後で、台帳の予約とも重ならない（1人）", () => {
    const o = press(emptyBook(TODAY), "free");
    assert.ok(o.ok);
    if (!o.ok) return;
    const before = ctxFor(base, emptyBook(TODAY), o.placed.customerId);
    assert.ok(judgeSlot(before, o.placed).ok, "入る前の台帳で受けられた枠");
    assert.ok(`${o.placed.date} ${o.placed.start}` > `${clock.now.date} ${clock.now.time}`);
    assert.ok(view(base, o.state).book.checks.seats.ok, "同じ時間に受ける人数をこえない");
  });

  test("その枠は埋まりとして扱う：予約チャットの判定・朝の要点の空き枠・発信の空き枠から外れる", () => {
    const s0 = emptyBook(TODAY);
    const o = press(s0, "free");
    assert.ok(o.ok);
    if (!o.ok) return;
    const p = o.placed;
    // 予約チャット：同じ枠を別の方が頼んでも受けない（台帳に送る booked に入る）
    const other = base.customers.find((c) => c.id !== p.customerId && c.id !== "c09" && c.id !== "c10")!.id;
    assert.ok(judgeSlot(ctxFor(base, s0, other), p).ok, "入る前は受けられた");
    assert.equal(judgeSlot(ctxFor(base, o.state, other), p).ok, false, "入った後は受けない");
    assert.ok(view(base, o.state).booked.some((b) => b.id === p.id && b.status === "confirmed"), "AI に送る台帳にも確定で入る");

    // 朝の要点の空き枠・発信の空き枠（30分ごと。最初は1人なので、入った時間は空きと言わない）
    const day = calDay(base.shop, p.date);
    const covered = (ranges: { start: string; end: string }[]) => ranges.some((f) => f.start <= p.start && p.start < f.end);
    assert.ok(covered(freeRanges(base.shop, day, view(base, s0).all).ranges), "入る前は空き");
    assert.equal(covered(freeRanges(base.shop, day, view(base, o.state).all).ranges), false, "朝の要点の空き枠から外れる");
    assert.ok(covered(openRanges(base.shop, day, view(base, s0).all)));
    assert.equal(covered(openRanges(base.shop, day, view(base, o.state).all)), false, "発信の空き枠から外れる");
  });

  test("何回押しても、同じ時間に受ける人数（1人・2人）をこえない。ブラウザに残す形でも「予約サイトから」が残る", () => {
    for (const seats of [1, 2]) {
      const data = { ...base, shop: withSeats(base.shop, seats) };
      let s = emptyBook(TODAY);
      for (let i = 0; i < 12; i++) {
        const o = press(s, "free", data);
        assert.ok(o.ok, `${seats}人・${i + 1}回目`);
        if (!o.ok) break;
        s = o.state;
      }
      assert.equal(siteCount(s), 12);
      assert.ok(checkSeats(data.shop, view(data, s).all).ok, `${seats}人`);
      assert.equal(new Set(s.chat.map((r) => r.id)).size, 12, "id は1つずつ違う");
      const back = parseBook(JSON.stringify(s))!;
      assert.equal(siteCount(back), 12, "読みなおしても予約サイトの印が残る");
    }
  });
});

describe("2. 二重予約を防ぐ：仮押さえと同じ枠に入れる（デモ）", () => {
  test("仮押さえを外し、ToDo に「○○（架空）様に別の日時を案内」を今日中として足す（AI は使わない）", () => {
    const s0 = withHold(emptyBook(TODAY), hold());
    assert.equal(pendingApprovals(s0, NOW_ISO).length, 1);
    const o = press(s0, "onHold");
    assert.ok(o.ok, o.ok ? "" : o.note);
    if (!o.ok) return;
    assert.deepEqual([o.placed.date, o.placed.start, o.placed.menuId], ["2026-11-06", "15:00", "cut"], "仮押さえと同じ枠");
    assert.notEqual(o.placed.customerId, "c04", "別の架空のお客様");
    assert.equal(o.state.chat.some((r) => r.id === "h1"), false, "仮押さえは外れる");
    assert.equal(pendingApprovals(o.state, NOW_ISO).length, 0, "承認の箱から消える");
    assert.equal(o.state.approvals.find((a) => a.reservationId === "h1")?.state, "taken");
    const t = o.state.todos.find((x) => x.title === "江口（架空）様に別の日時を案内");
    assert.ok(t, "ToDo に足す");
    assert.equal(t!.due, TODAY, "今日中");
    assert.equal(t!.source, "reserve");
    assert.equal(t!.key, reserveKey("c04", "2026-11-06", "15:00"), "直す・見送り・枠が埋まった時と同じ鍵");
    assert.equal(o.released.length, 1);
    assert.ok(o.journal.some((j) => j.who === "プログラム" && /江口（架空）様の仮押さえ.*を外し、ToDo に「江口（架空）様に別の日時を案内」（今日中）を足した/.test(j.text)));
    assert.ok(view(base, o.state).book.checks.seats.ok, "二重予約にならない");
    // 予約サイトで枠が埋まった時の ToDo（TodoFeeds）は、もう仮押さえが無いので2回は足さない
    assert.deepEqual(fullSlotTodos(view(base, o.state).all, pendingApprovals(o.state, NOW_ISO), { seats: 1, customers: base.customers, today: TODAY, nowIso: NOW_ISO }), []);
  });

  test("同じ時間に受ける人数が2人なら、仮押さえと並んで入れる（外さない・ToDo も足さない）", () => {
    const data = { ...base, shop: withSeats(base.shop, 2) };
    const s0 = withHold(emptyBook(TODAY), hold());
    const o = press(s0, "onHold", data);
    assert.ok(o.ok);
    if (!o.ok) return;
    assert.equal(o.released.length, 0);
    assert.equal(pendingApprovals(o.state, NOW_ISO).length, 1, "仮押さえはそのまま");
    assert.equal(o.state.todos.length, 0);
    assert.ok(checkSeats(data.shop, view(data, o.state).all).ok);
    // もう1件同じ枠に入れると、2人をこえるので仮押さえを外す
    const o2 = press(o.state, "onHold", data);
    assert.ok(o2.ok);
    if (!o2.ok) return;
    assert.equal(o2.released.length, 1);
    assert.equal(pendingApprovals(o2.state, NOW_ISO).length, 0);
    assert.ok(checkSeats(data.shop, view(data, o2.state).all).ok, "2人をこえない");
  });

  test("空いている枠に入れる時は、仮押さえの枠を選ばない（外さない）", () => {
    const s0 = withHold(emptyBook(TODAY), hold());
    let s = s0;
    for (let i = 0; i < 6; i++) {
      const o = press(s, "free");
      assert.ok(o.ok);
      if (!o.ok) break;
      assert.equal(o.released.length, 0);
      s = o.state;
    }
    assert.equal(pendingApprovals(s, NOW_ISO).length, 1, "仮押さえは残る");
  });

  test("承認待ちの仮押さえが無い時は、何も変えずに理由を返す", () => {
    const s0 = emptyBook(TODAY);
    const o = press(s0, "onHold");
    assert.equal(o.ok, false);
    assert.equal(o.state, s0);
  });
});

describe("3. 最初に戻す・決まり", () => {
  test("「最初に戻す」で、予約サイトから入った予約も、外した仮押さえの ToDo も消える", () => {
    let s = withHold(emptyBook(TODAY), hold());
    const a = press(s, "onHold");
    assert.ok(a.ok);
    if (!a.ok) return;
    const b = press(a.state, "free");
    assert.ok(b.ok);
    if (!b.ok) return;
    s = b.state;
    assert.equal(siteCount(s), 2);
    const w = resetAllWrites(TODAY).find((x) => x.key === BOOK_KEY)!;
    const back = parseBook(w.value)!;
    assert.equal(siteCount(back), 0);
    assert.equal(back.todos.length, 0);
    assert.deepEqual(back, emptyBook(TODAY));
    // 戻した後も、また入れられる（番号も1から）
    const again = press(back, "free");
    assert.ok(again.ok);
    if (again.ok) assert.equal(again.placed.id, "site-1");
  });

  test("ブラウザの中の形：仮押さえに付いた「予約サイトから」の印は読まない（予約サイトの予約は確定だけ）", () => {
    const raw = JSON.stringify({
      ...emptyBook(TODAY),
      chat: [{ id: "x", customerId: "c01", menuId: "cut", date: "2026-11-06", start: "10:00", status: "hold", heldAt: NOW_ISO, expiresAt: NOW_ISO, via: "site" }],
    });
    assert.equal(parseBook(raw)!.chat[0].via, undefined);
  });

  test("AI は使わない：予約サイトの道具は無く（道具は5つのまま）、承認（withApproved）も呼ばない", () => {
    assert.equal(TOOL_DEFS.length, 5);
    const src = readFileSync(join(ROOT, "src/lib/book/site.ts"), "utf8");
    assert.doesNotMatch(src, /withApproved|\/claude|anthropic|fetch\(/);
  });

  test("ホームの「AI の仕事」に「予約サイトから予約が入る」の1行（seed/jobs.json）", () => {
    assert.ok(getJobSeeds().some((j) => j.id === "site"));
  });
});
