// 「○○（架空）様に別の日時を案内」の ToDo（直しB：「必ず」の11）。AI は呼ばない。
// 1か月分の耐久試験で、同じお客様の同じ文の ToDo が何件も並び、どの予約の分か見分けられなかった。
// 元の頼みの日時とメニューを文に入れ、足す入口（直す・見送り／LINE の見送り／予約サイト／枠が埋まった）はみな reschedule.ts の1か所を通す。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { HoldOffer } from "../../ai/wire";
import { emptyBook, pendingApprovals, withHold, withReleased } from "../../book/state";
import { todoItems } from "../items";
import { reserveKey } from "../keys";
import { rescheduleTitle, rescheduleTodo } from "../reschedule";
import { getShop } from "../../settings";

const root = join(__dirname, "../../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const now = "2026-11-04T01:00:00.000Z";
const today = "2026-11-04";

const hold = (id: string, over: Partial<HoldOffer> = {}): HoldOffer => ({
  id,
  customerId: "c04",
  menuId: "cut",
  date: "2026-11-06",
  start: "15:00",
  heldAt: now,
  expiresAt: "2026-11-05T01:00:00.000Z",
  reason: "お客様が候補から選びました",
  ...over,
});

describe("文：元の頼みの日時とメニューを添える", () => {
  test("「大橋（架空）様に別の日時を案内（11/8（日） 15:00 カットの代わり）」", () => {
    assert.equal(rescheduleTitle("大橋", { date: "2026-11-08", start: "15:00", menuId: "cut" }), "大橋（架空）様に別の日時を案内（11/8（日） 15:00 カットの代わり）");
  });
  test("元の頼みが分からない時は今までの文だけ（id と鍵は付く物だけ）", () => {
    const t = rescheduleTodo({ idPrefix: "td", reservationId: "h9", surname: "大橋", from: null, nowIso: now });
    assert.equal(t.title, "大橋（架空）様に別の日時を案内");
    assert.equal(t.id, "td-h9");
    assert.equal(t.key, undefined);
    assert.equal(t.due, undefined);
  });
  test("鍵は「予約:お客様＠日時」、期限は渡した日（今日中）、出どころは予約", () => {
    const t = rescheduleTodo({ idPrefix: "td-site", reservationId: "h1", surname: "江口", from: { id: "h1", customerId: "c04", menuId: "cut", date: "2026-11-06", start: "15:00" }, nowIso: now, due: today });
    assert.deepEqual(
      { id: t.id, key: t.key, due: t.due, source: t.source, done: t.done },
      { id: "td-site-h1", key: reserveKey("c04", "2026-11-06", "15:00"), due: today, source: "reserve", done: false },
    );
  });
});

describe("耐久試験の形：同じお客様の ToDo が何件あっても、どの予約の分か見分けられる", () => {
  test("同じお客様の3つの仮押さえを見送る → 3件とも文が違う", () => {
    let s = emptyBook(today);
    s = withHold(s, hold("a", { date: "2026-11-06", start: "15:00", menuId: "cut" }));
    s = withHold(s, hold("b", { date: "2026-11-06", start: "17:00", menuId: "cut" }));
    s = withHold(s, hold("c", { date: "2026-11-07", start: "15:00", menuId: "color" }));
    for (const row of pendingApprovals(s, now)) s = withReleased(s, row.approval.id, "skipped", "江口", now, today);
    const titles = todoItems([], s, getShop()).map((t) => t.title);
    assert.equal(titles.length, 3);
    assert.equal(new Set(titles).size, 3, titles.join(" / "));
    assert.ok(titles.every((t) => t.startsWith("江口（架空）様に別の日時を案内（")));
    assert.match(titles[1], /17:00 カットの代わり）$/);
  });
});

describe("足す入口はみな reschedule.ts の1か所を通す", () => {
  test("直す・見送り（LINE のボタンも）・予約サイト・枠が埋まった", () => {
    assert.match(read("src/lib/book/state.ts"), /rescheduleTodo\(\{ idPrefix: "td", reservationId: a\.reservationId, surname, from: r, nowIso, due: today \}\)/);
    assert.match(read("src/lib/book/site.ts"), /rescheduleTodo\(\{ idPrefix: "td-site", reservationId: r\.id, surname, from: r, nowIso, due: clock\.today\.date \}\)/);
    assert.match(read("src/lib/todo/full.ts"), /rescheduleTodo\(\{ idPrefix: "td-full", reservationId: r\.id, surname, from: r, nowIso: ctx\.nowIso, due: ctx\.today \}\)/);
    // LINE のボタンの見送りは withReleased を呼ぶだけ（LINE のファイルは変えていない）
    assert.match(read("src/lib/line/apply.ts"), /withReleased\(book, row\.approval\.id, "skipped", surname, ctx\.nowIso, ctx\.today\)/);
  });
  test("ほかの所で「別の日時を案内」の ToDo を組み立てない（文を作るのは reschedule.ts だけ）", () => {
    for (const p of ["src/lib/book/state.ts", "src/lib/book/site.ts", "src/lib/todo/full.ts", "src/components/ApprovalBox.tsx"])
      assert.doesNotMatch(read(p), /title: `\$\{surname\}（架空）様に別の日時を案内`/, p);
  });
});
