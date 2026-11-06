// 1. 承認待ちの数（上の帯・朝の要点）は、承認の箱の行の数と必ず同じ。
// どれも approvals.ts の approvalQueue（同じ行）から数える。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { HoldOffer } from "../ai/wire";
import { EMPTY_ADS, type AdsState } from "../ads/state";
import { approvalQueue, approvalRowsView, holdLeft, sameDayOthers, soonFirst } from "../approvals";
import { activeChat, emptyBook, withApproved, withGuestReleased, withHold, withReleased, type BookState } from "../book/state";

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

// 9. 仮押さえが自動で外れるまでの残り（本当の時計で「期限 − 今」）
describe("承認の箱：仮押さえが外れるまでの残り", () => {
  const nowMs = Date.parse(now);
  const at = (min: number) => new Date(nowMs + min * 60_000).toISOString();

  test("「あと2時間10分で外れます」。ちょうどの時間・分だけ・まもなく", () => {
    assert.deepEqual(holdLeft(at(130), nowMs), { minutes: 130, text: "あと2時間10分で外れます", soon: false });
    assert.equal(holdLeft(at(120), nowMs).text, "あと2時間で外れます");
    assert.equal(holdLeft(at(45), nowMs).text, "あと45分で外れます");
    assert.equal(holdLeft(new Date(nowMs + 30_000).toISOString(), nowMs).text, "まもなく外れます");
  });

  test("1時間を切ったら soon（60分ちょうどはまだ）", () => {
    assert.equal(holdLeft(at(60), nowMs).soon, false);
    assert.equal(holdLeft(at(59), nowMs).soon, true);
  });

  test("期限（expiresAt）と本当の時計だけで決まる：「翌日へ」で台帳の今日を進めても残りは変わらない", () => {
    const s = withHold(emptyBook("2026-11-04"), hold("h1", at(130)));
    const row = approvalQueue(s, emptyAds(), now).reservations[0];
    const next = { ...s, dayOffset: 3 };
    const row2 = approvalQueue(next, emptyAds(), now).reservations[0];
    assert.equal(holdLeft(row.reservation.expiresAt, nowMs).text, holdLeft(row2.reservation.expiresAt, nowMs).text);
    // 1分ごとの描き直しで、残りが1分ずつ減る
    assert.equal(holdLeft(row.reservation.expiresAt, nowMs + 60_000).minutes, 129);
  });

  test("表示と外れる時がずれない：残りが0になる時、台帳と承認の箱からも外れる", () => {
    const s = withHold(emptyBook("2026-11-04"), hold("h1", at(10)));
    const end = nowMs + 10 * 60_000;
    assert.equal(holdLeft(at(10), end - 60_000).text, "あと1分で外れます");
    assert.equal(approvalQueue(s, emptyAds(), new Date(end - 60_000).toISOString()).reservations.length, 1);
    assert.equal(approvalQueue(s, emptyAds(), new Date(end).toISOString()).reservations.length, 0);
  });

  test("残りが1時間を切った行を上に（ほかは古い順のまま）", () => {
    let s = emptyBook("2026-11-04");
    s = withHold(s, hold("a", at(300)));
    s = withHold(s, hold("b", at(30)));
    s = withHold(s, hold("c", at(200)));
    s = withHold(s, hold("d", at(50)));
    const rows = approvalQueue(s, emptyAds(), now).reservations;
    assert.deepEqual(rows.map((r) => r.reservation.id), ["a", "b", "c", "d"], "数の元の行はそのまま");
    assert.deepEqual(soonFirst(rows, nowMs).map((r) => r.reservation.id), ["b", "d", "a", "c"]);
    assert.equal(soonFirst(rows, nowMs).length, approvalQueue(s, emptyAds(), now).count, "並べ替えても数は同じ");
  });

  test("画面は1分ごとの描き直し（useMinute）の今を使い、行の順と足す物は approvalRowsView の1か所", () => {
    const box = readFileSync(new URL("../../components/ApprovalBox.tsx", import.meta.url), "utf8");
    assert.match(box, /const nowMs = useMinute\(\) \* 60_000;/);
    assert.match(box, /approvalRowsView\(queue\.reservations, \{ nowMs, booked: book\.booked \}\)/);
    assert.match(box, /<ApprovalRowNotes notes=\{notes\} \/>/);
    assert.doesNotMatch(box, /holdLeft|sameDayOthers|soonFirst/, "画面では直に呼ばない（足す物は approvals.ts に）");
    const lib = readFileSync(new URL("../approvals.ts", import.meta.url), "utf8");
    assert.match(lib, /holdLeft\(r\.expiresAt, ctx\.nowMs\)/, "残りは期限と本当の時計だけ（「翌日へ」の日付では数えない）");
  });
});

// 10. 同じお客様の、同じ日のほかの予約
describe("承認の箱：同じ日のほかの予約", () => {
  const row = { id: "h1", customerId: "c04", date: "2026-11-06" };
  const b = (id: string, customerId: string, date: string, start: string) => ({ id, customerId, date, start });

  test("同じお客様・同じ日のほかの予約の時刻（早い順）。その行自身は数えない", () => {
    const booked = [b("h1", "c04", "2026-11-06", "15:00"), b("s2", "c04", "2026-11-06", "13:00"), b("s3", "c04", "2026-11-06", "10:00")];
    assert.deepEqual(sameDayOthers(row, booked), ["10:00", "13:00"]);
  });

  test("ほかのお客様・ほかの日の予約は数えない", () => {
    const booked = [b("x", "c05", "2026-11-06", "13:00"), b("y", "c04", "2026-11-07", "13:00")];
    assert.deepEqual(sameDayOthers(row, booked), []);
  });

  test("台帳の今ある予約から：期限の切れた仮押さえ・外した仮押さえは入らない", () => {
    let s = emptyBook("2026-11-04");
    s = withHold(s, hold("h1", "2026-11-05T01:00:00.000Z"));
    s = withHold(s, { ...hold("old", "2026-11-04T01:30:00.000Z"), start: "11:00" });
    s = withHold(s, { ...hold("gone", "2026-11-05T01:00:00.000Z"), start: "17:00" });
    s = withHold(s, { ...hold("keep", "2026-11-05T01:00:00.000Z"), start: "13:00" });
    const gone = approvalQueue(s, emptyAds(), now).reservations.find((r) => r.reservation.id === "gone")!;
    s = withReleased(s, gone.approval.id, "skipped", "江口", now);
    // 台帳の今ある予約（useBook の booked と同じ：期限の切れていない物）
    const booked = activeChat(s, now).map((r) => ({ id: r.id, customerId: r.customerId, date: r.date, start: r.start }));
    assert.deepEqual(sameDayOthers({ id: "h1", customerId: "c04", date: "2026-11-06" }, booked), ["13:00"]);
  });

  test("画面は「! 同じ日の13:00にも予約があります」の1行（止めはしない：ボタンはそのまま）", () => {
    const box = readFileSync(new URL("../../components/ApprovalBox.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(box, /disabled=\{[^}]*(notes|soon)/);
  });
});

// 行に足す物は1か所（approvals.ts の approvalRowNotes / approvalRowsView。直しC などはここに足す）
describe("承認の箱：行に足す物の1か所", () => {
  const nowMs = Date.parse(now);
  const at = (min: number) => new Date(nowMs + min * 60_000).toISOString();
  const rowsOfState = (s: BookState) => approvalQueue(s, emptyAds(), now).reservations;

  test("残りの1行はいつも、同じ日のほかの予約は有る時だけ。順は残り → 同じ日", () => {
    let s = withHold(emptyBook("2026-11-04"), hold("h1", at(130)));
    s = withHold(s, { ...hold("h2", at(300)), customerId: "c05" });
    const booked = [
      { id: "h1", customerId: "c04", date: "2026-11-06", start: "15:00" },
      { id: "s1", customerId: "c04", date: "2026-11-06", start: "13:00" },
      { id: "h2", customerId: "c05", date: "2026-11-06", start: "15:00" },
    ];
    const view = approvalRowsView(rowsOfState(s), { nowMs, booked });
    assert.deepEqual(view[0].notes, [
      { kind: "left", text: "あと2時間10分で外れます", strong: false },
      { kind: "sameDay", text: "! 同じ日の13:00にも予約があります", strong: false },
    ]);
    assert.deepEqual(view[1].notes, [{ kind: "left", text: "あと5時間で外れます", strong: false }]);
  });

  test("残りが1時間を切った行は上・soon・残りが太字。数は変えない", () => {
    let s = withHold(emptyBook("2026-11-04"), hold("late", at(300)));
    s = withHold(s, hold("soon", at(20)));
    const view = approvalRowsView(rowsOfState(s), { nowMs, booked: [] });
    assert.deepEqual(view.map((v) => [v.row.reservation.id, v.soon]), [["soon", true], ["late", false]]);
    assert.equal(view[0].notes[0].strong, true);
    assert.equal(view.length, approvalQueue(s, emptyAds(), now).count);
  });

  test("見た目は ApprovalRowNotes が種類ごとに持つだけ（中身は作らない）", () => {
    const notes = readFileSync(new URL("../../components/ApprovalRowNotes.tsx", import.meta.url), "utf8");
    assert.match(notes, /left: "approval-left"/);
    assert.match(notes, /sameDay: "approval-same"/);
    assert.doesNotMatch(notes, /holdLeft|sameDayOthers|にも予約があります|で外れます/);
  });
});
