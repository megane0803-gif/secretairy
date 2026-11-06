// 承認の箱：承認 = 確定して台帳に入る。直す・見送り = 仮押さえを外し、ToDo に「別の日時を案内」。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { HoldOffer } from "../../ai/wire";
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

describe("承認の箱", () => {
  test("仮押さえで承認の箱に1行入る（同じ物は2回入らない）", () => {
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
      assert.deepEqual(s.todos.map((t) => t.title), ["江口様に別の日時を案内"]);
    });

  test("期限が過ぎた仮押さえは、台帳にも承認の箱にも出ない", () => {
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
