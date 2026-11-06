// 予約サイトで、時間ごとにネットの受付を止める・戻す（docs/SPEC.md §1.4）のテスト。Claude は呼ばない。
// - 止めた時間には、施術がかかる予約を入れない（その時刻に始まる物も、重なる物も）。2つのデモ（ここで予約が入る・仮押さえと同じ枠）の両方
// - 予約チャットと、オーナーが台帳から入れる予約には効かせない
// - 止める・戻すたびに日誌に1行。ブラウザに残し、「最初に戻す」で消える

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { at, chat, ctxAt } from "../../ai/__tests__/helpers";
import { judgeSlot } from "../../ai/slots";
import { toMinutes } from "../../calendar";
import { resolveMenu } from "../../combo";
import { resetAllWrites } from "../../reset";
import { getRules } from "../../rules/store";
import { getBookData } from "../data";
import { ownerBook } from "../owner";
import { siteBook } from "../site";
import { isStopped, MAX_SITE_STOPS, parseSiteStops, SITE_STOPS_KEY, siteStep, siteStopJournal, siteStopsRaw, stopHit, stopKey } from "../siteStops";
import { emptyBook, withHold, type BookState } from "../state";

const ROOT = join(__dirname, "../../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const data = getBookData();
const rules = getRules();
const NOW = new Date("2026-11-04T08:30:00+09:00");
const start = emptyBook("2026-11-04");
const step = siteStep(data.shop);

/** その予約が、止めたマスに少しでもかかるか */
const overlaps = (stops: string[], r: { menuId: string; date: string; start: string }) => {
  const m = resolveMenu(data.menus, r.menuId)!;
  const s = toMinutes(r.start);
  return stopHit(stops, step, r.date, s, s + m.minutes) !== null;
};

describe("1. 止めた時間の形（ブラウザに残す）", () => {
  test("1マスは空き表と同じ長さ。読む・書く（形のおかしい物は落とす。0マスなら消す）", () => {
    assert.equal(step, 30);
    assert.deepEqual(parseSiteStops(siteStopsRaw(["2026-11-05 10:00", "2026-11-05 10:00", "x", "2026-11-05 25:00"])), ["2026-11-05 10:00"]);
    assert.equal(siteStopsRaw([]), null);
    assert.deepEqual(parseSiteStops("{"), []);
    assert.ok(MAX_SITE_STOPS >= 7 * 20);
    assert.equal(isStopped(["2026-11-05 10:00"], "2026-11-05", "10:00"), true);
  });

  test("重なりで当たる：10:30 を止めたら、10:00 からのカット（60分）も当たる。11:00 からは当たらない", () => {
    const stops = [stopKey("2026-11-05", "10:30")];
    assert.equal(stopHit(stops, step, "2026-11-05", 600, 660), "10:30");
    assert.equal(stopHit(stops, step, "2026-11-05", 660, 720), null);
    // 10:30 ちょうどで終わる物（9:30–10:30）は当たらない。10:59 まで続く物は当たる
    assert.equal(stopHit(stops, step, "2026-11-05", 570, 630), null);
    assert.equal(stopHit(stops, step, "2026-11-05", 570, 631), "10:30");
  });

  test("日誌の1行・「最初に戻す」で消える", () => {
    assert.match(siteStopJournal("11/5（木）", "10:00", "10:30", true), /11\/5（木） 10:00–10:30 をネットでは受けないにした/);
    assert.match(siteStopJournal("11/5（木）", "10:00", "10:30", false), /ネットの受付を戻した/);
    assert.deepEqual(resetAllWrites("2026-11-04").find((w) => w.key === SITE_STOPS_KEY), { key: SITE_STOPS_KEY, value: null });
  });
});

describe("2. 予約サイトのデモ：止めた時間には入れない", () => {
  test("「ここで予約が入る（デモ）」：止める前に入る枠を止めると、その枠（と重なる枠）には入らない", () => {
    const first = siteBook(start, { data, rules, now: NOW }, "free");
    assert.ok(first.ok);
    if (!first.ok) return;
    const p = first.placed;
    const m = resolveMenu(data.menus, p.menuId)!;
    // 始まりの時刻ではなく、施術の途中のマスだけを止める（重なる予約も入れないことを確かめる）
    const mid = toMinutes(p.start) + Math.max(0, m.minutes - step);
    const stops = [stopKey(p.date, `${String(Math.floor(mid / 60)).padStart(2, "0")}:${String(mid % 60).padStart(2, "0")}`)];
    const again = siteBook(start, { data, rules, now: NOW, stops }, "free");
    assert.ok(again.ok);
    if (!again.ok) return;
    assert.ok(!overlaps(stops, again.placed), JSON.stringify(again.placed));
    assert.notDeepEqual([again.placed.date, again.placed.start, again.placed.menuId], [p.date, p.start, p.menuId]);
  });

  test("その日の営業時間を全部止めると、その日には入らない", () => {
    const first = siteBook(start, { data, rules, now: NOW }, "free");
    assert.ok(first.ok);
    if (!first.ok) return;
    const day = first.placed.date;
    const stops = Array.from({ length: 20 }, (_, i) => stopKey(day, `${String(10 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`));
    const again = siteBook(start, { data, rules, now: NOW, stops }, "free");
    assert.ok(again.ok && again.placed.date !== day);
  });

  test("「仮押さえと同じ枠に入れる（デモ）」：仮押さえの時間にかかるマスを止めたら入らない（仮押さえも外さない）", () => {
    const held: BookState = withHold(start, {
      id: "h-1",
      customerId: "c04",
      menuId: "cut",
      date: "2026-11-05",
      start: "16:00",
      heldAt: NOW.toISOString(),
      expiresAt: "2026-12-31T00:00:00.000Z",
      reason: "テスト",
    });
    const ok = siteBook(held, { data, rules, now: NOW }, "onHold");
    assert.ok(ok.ok, "止めていなければ入る（比べ）");
    const out = siteBook(held, { data, rules, now: NOW, stops: [stopKey("2026-11-05", "16:30")] }, "onHold");
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.note, /ネットでは受けないにしているので、予約サイトからは入りません/);
    assert.equal(out.state, held);
  });

  test("AI の仕事の「予約サイトから予約が入る」も、止めた時間を渡す", () => {
    assert.match(read("src/lib/jobs/run.ts"), /stops: env\.siteStops \?\? \[\]/);
    assert.match(read("src/app/home/AiJobs.tsx"), /siteStops,/);
  });
});

describe("3. 予約チャットと、台帳から入れる予約には効かせない", () => {
  const stops = [stopKey("2026-11-06", "15:00"), stopKey("2026-11-06", "15:30")];

  test("予約チャット：止めた時間でも候補に出す（止めた時間は送らない・判定に入れない）", async () => {
    const now = at("2026-11-04", "08:30");
    const ctx = ctxAt(now);
    assert.equal(judgeSlot(ctx, { menuId: "cut", date: "2026-11-06", start: "15:00" }).ok, true);
    const r = await chat(ctx, [{ role: "user", text: "11/6の15時にカット" }]);
    assert.ok(r.candidates?.some((c) => c.date === "2026-11-06" && c.start === "15:00"), JSON.stringify(r.candidates));
    // 予約チャットの送る中身・道具の形に、止めた時間は無い
    assert.doesNotMatch(read("src/app/reservations/ReserveChat.tsx"), /siteStops|useSiteStops/);
    assert.doesNotMatch(read("src/lib/ai/request.ts"), /siteStops|stopHit/);
    assert.ok(overlaps(stops, { menuId: "cut", date: "2026-11-06", start: "15:00" }));
  });

  test("台帳から入れる予約：止めた時間でも入れられる", () => {
    const out = ownerBook(start, { data, rules, now: NOW, newId: () => "own-x" }, { customerId: "c01", menuId: "cut", date: "2026-11-06", start: "15:00" });
    assert.ok(out.ok);
    assert.doesNotMatch(read("src/lib/book/owner.ts"), /stopHit|siteStops"/);
  });

  test("空き表：オーナーがマスを押すと止める・戻す（人が押した時だけ・日誌に1行）。印は「止」、下の説明にも", () => {
    const site = read("src/app/reservations/BookingSite.tsx");
    assert.match(site, /const mark = stopped \? "止"/);
    assert.match(site, /if \(!e\.nativeEvent\.isTrusted\) return;\s*const start = toHHMM\(t\);/);
    assert.match(site, /writeJournal\(\{ who: "オーナー", text: siteStopJournal/);
    assert.match(site, /止 ネットでは受けない/);
  });
});
