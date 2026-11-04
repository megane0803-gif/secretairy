// 1. 承認待ちの数（上の帯・朝の要点）は、承認の箱の行の数と必ず同じ。
// どれも approvals.ts の approvalQueue（同じ行）から数える。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { HoldOffer } from "../ai/wire";
import { EMPTY_ADS, type AdsState } from "../ads/state";
import { approvalQueue } from "../approvals";
import { emptyBook, withApproved, withGuestReleased, withHold, withReleased, type BookState } from "../book/state";

const emptyAds = (): AdsState => EMPTY_ADS;

const hold = (id: string, expiresAt = "2026-11-05T01:00:00.000Z"): HoldOffer => ({
  id,
  customerId: "c04",
  menuId: "cut",
  date: "2026-11-06",
  start: "15:00",
  heldAt: "2026-11-04T01:00:00.000Z",
  expiresAt,
  reason: "お客様が候補から選びました",
});
const now = "2026-11-04T02:00:00.000Z";

function rowsOf(book: BookState, ads: AdsState) {
  const q = approvalQueue(book, ads, now);
  return { q, rows: q.reservations.length + (q.ad ? 1 : 0) };
}

describe("1. 承認待ちの数 = 承認の箱の行の数", () => {
  const adPending: AdsState = {
    ...emptyAds(),
    proposals: [
      {
        id: "ad1",
        createdAt: now,
        action: "stop",
        no: 3,
        text: "架空の言葉",
        reason: "予約につながっていません。",
        state: "pending",
        checks: [],
        total: { clicks: 1, cost: 1, bookings: 0 } as AdsState["proposals"][number]["total"],
        fixed: false,
        mode: "script",
      },
    ],
  };

  const cases: [string, BookState, AdsState, number][] = [
    ["何も無い", emptyBook("2026-11-04"), emptyAds(), 0],
    ["仮押さえ1件", withHold(emptyBook("2026-11-04"), hold("h1")), emptyAds(), 1],
    ["仮押さえ2件", withHold(withHold(emptyBook("2026-11-04"), hold("h1")), hold("h2")), emptyAds(), 2],
    ["期限の切れた仮押さえは、箱にも数にも出さない", withHold(emptyBook("2026-11-04"), hold("h1", "2026-11-04T01:30:00.000Z")), emptyAds(), 0],
    ["仮押さえ1件＋広告の案1件", withHold(emptyBook("2026-11-04"), hold("h1")), adPending, 2],
  ];
  for (const [name, book, ads, n] of cases)
    test(name, () => {
      const { q, rows } = rowsOf(book, ads);
      assert.equal(q.count, n);
      assert.equal(q.count, rows);
    });

  test("承認・直す・お客様の取り下げの後も、数と行がそろう", () => {
    const s = withHold(withHold(emptyBook("2026-11-04"), hold("h1")), hold("h2"));
    const approved = withApproved(s, "ap-h1", now);
    assert.equal(approvalQueue(approved, emptyAds(), now).count, 1);
    const fixed = withReleased(approved, "ap-h2", "fixed", "江口", now);
    assert.equal(approvalQueue(fixed, emptyAds(), now).count, 0);
    const withdrawn = withGuestReleased(s, "h2", "c04", now);
    assert.equal(approvalQueue(withdrawn, emptyAds(), now).count, 1);
  });

  test("上の帯・朝の要点・承認の箱は、どれも同じ useApprovals（approvals.ts）から数える", () => {
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
    for (const p of ["../../components/PendingBar.tsx", "../../app/home/HomeSummary.tsx", "../../components/ApprovalBox.tsx"]) {
      const src = read(p);
      assert.match(src, /useApprovals\(\)/, p);
      assert.doesNotMatch(src, /pendingApprovals\(|book\.pending|ads\.pending/, `${p} は自分で数えない`);
    }
  });
});
