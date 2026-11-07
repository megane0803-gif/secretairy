// 承認BOX：承認 = 確定して台帳に入る。直す・見送り = 仮押さえを外し、ToDo に「別の日時を案内」。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HoldOffer } from "../../ai/wire";
import { rescheduleTitle as releasedTodoTitle } from "../../todo/reschedule";
import { activeChat, emptyBook, parseBook, pendingApprovals, withApproved, withHold, withReleased } from "../state";

const hold: HoldOffer = {
  id: "h1",
  customerId: "c04",
  menuId: "cut",
  date: "2026-11-05",
  start: "15:00",
  heldAt: "2026-11-04T01:00:00.000Z",
  expiresAt: "2026-11-05T01:00:00.000Z",
  reason: "お客様が候補から選びました",
};
const now = "2026-11-04T02:00:00.000Z";

describe("承認BOX", () => {
  test("仮押さえで承認BOXに1行入る（同じ物は2回入らない）", () => {
    const s = withHold(withHold(emptyBook("2026-11-04"), hold), hold);
    assert.equal(pendingApprovals(s, now).length, 1);
    assert.equal(s.chat[0].status, "hold");
  });

  test("承認：確定して台帳に入る", () => {
    const s0 = withHold(emptyBook("2026-11-04"), hold);
    const s = withApproved(s0, pendingApprovals(s0, now)[0].approval.id, now);
    assert.equal(s.chat[0].status, "confirmed");
    assert.equal(pendingApprovals(s, now).length, 0);
    assert.equal(activeChat(s, "2030-01-01T00:00:00.000Z").length, 1, "確定した物は期限で外れない");
  });

  for (const how of ["fixed", "skipped"] as const)
    test(`${how === "fixed" ? "直す" : "見送り"}：仮押さえを外し、ToDo に「別の日時を案内」を足す`, () => {
      const s0 = withHold(emptyBook("2026-11-04"), hold);
      const s = withReleased(s0, pendingApprovals(s0, now)[0].approval.id, how, "江口", now);
      assert.equal(s.chat.length, 0, "時間は変えずに外す");
      assert.equal(s.approvals[0].state, how);
      // 元の頼みの日時とメニューを添える（何の代わりを案内するのか分かるように）
      assert.deepEqual(s.todos.map((t) => t.title), ["江口様に別の日時を案内（11/5（木） 15:00 カットの代わり）"]);
    });

  test("「別の日時を案内」の文：元の頼みが分からない時は今までの文だけ。組み合わせのメニューも名前で", () => {
    assert.equal(releasedTodoTitle("大橋"), "大橋様に別の日時を案内");
    assert.equal(releasedTodoTitle("大橋", null), "大橋様に別の日時を案内");
    assert.equal(
      releasedTodoTitle("大橋", { date: "2026-11-08", start: "15:00", menuId: "cut" }),
      "大橋様に別の日時を案内（11/8（日） 15:00 カットの代わり）",
    );
    assert.match(releasedTodoTitle("大橋", { date: "2026-11-08", start: "15:00", menuId: "cut+color" }), /（11\/8（日） 15:00 カット＋カラーの代わり）$/);
  });

  test("LINE のボタンの見送りも同じ withReleased を通るので、同じ文になる", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const apply = readFileSync(join(__dirname, "../../line/apply.ts"), "utf8");
    assert.match(apply, /withReleased\(book, row\.approval\.id, "skipped", surname, ctx\.nowIso, ctx\.today\)/);
  });

  test("期限が過ぎた仮押さえは、台帳にも承認BOXにも出ない", () => {
    const s = withHold(emptyBook("2026-11-04"), hold);
    const later = "2026-11-05T01:00:00.000Z";
    assert.equal(activeChat(s, later).length, 0);
    assert.equal(pendingApprovals(s, later).length, 0);
  });

  test("ブラウザの中の形がおかしければ落とす", () => {
    assert.equal(parseBook("{"), null);
    assert.equal(parseBook(JSON.stringify({ anchor: "x" })), null);
    const s = parseBook(JSON.stringify({ anchor: "2026-11-04", chat: [{ id: 1 }], approvals: [{}], todos: "x" }));
    assert.deepEqual(s, emptyBook("2026-11-04"));
  });
});
