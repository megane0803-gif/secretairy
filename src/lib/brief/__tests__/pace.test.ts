// 直しY 3：ホームの「今日の注意」（朝の要点の AI の一言）が AI の窓口（/api/ai/brief）を呼ぶのは、決めた秒数（config/ai.json の
// brief.minIntervalSeconds）に1回まで。その間に材料が変わったら、秒数がたった後に、いちばん新しい材料で1回だけ呼ぶ。
// 待っている間は前に出した一言（画面でもう一度門を通した物）を出す。開いた時の1回目と「翌日へ」の後は今どおり。
// AI の窓口は呼ばず、数を数える call に置きかえる。時計とタイマーは作り物（画面と同じ wantBrief を、材料が変わるたびに
// 前の頼みをやめてから呼ぶ＝useEffect の後片付けと同じ順で通す）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import aiJson from "../../../../config/ai.json";
import { getBriefLimits } from "../../settings";
import { briefKey, type BriefMaterial } from "../items";
import { BRIEF_SETTLE_MS, briefShown, briefWaitMs, newBriefPace, shownBriefNotes, wantBrief, type BriefLastShown } from "../pace";
import type { BriefItem, BriefResult } from "../wire";

const ROOT = join(__dirname, "../../../..");
const limits = getBriefLimits();
const SEC = 1000;
const INTERVAL = limits.minIntervalSeconds;
const TODAY = "2026-11-05";

const item = (mark: string, text: string): BriefItem => ({ mark, kind: mark.includes("予約") ? "reservation" : mark.includes("承認") ? "approval" : "todo", text });
/** 材料（承認待ち n 件・済んでいない ToDo）。承認・ToDo の済みで変わる */
const keyOf = (approvals: number, todos: string[]) =>
  briefKey([item("【予約1】", "メニュー：カット。前回の記録なし"), ...Array.from({ length: approvals }, (_, i) => item(`【承認${i + 1}】`, "予約の仮押さえ。メニュー：カラー")), ...todos.map((t, i) => item(`【ToDo${i + 1}】`, t))], []);
const answerOf = (key: string): BriefResult => ({ mode: "ai", notes: [`【予約1】のご希望を聞く（${key.length}）`], dropped: [] });

/** 作り物の時計とタイマー。advance で時刻を進め、その間に来たタイマーを順に動かす */
function fakeClock() {
  let now = 1_000_000;
  let id = 0;
  const timers = new Map<number, { at: number; f: () => void }>();
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return {
    now: () => now,
    setTimer: (f: () => void, ms: number) => {
      timers.set(++id, { at: now + ms, f });
      return id;
    },
    clearTimer: (t: number) => void timers.delete(t),
    pending: () => timers.size,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].f();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

/** ホームの画面と同じ形：材料が変わるたびに前の頼みをやめ（後片付け）、今の材料で頼む。窓口を呼んだ材料と、出した答えを数える */
function homeScreen(clock = fakeClock(), opts: { reply?: (key: string) => BriefResult | null } = {}) {
  const pace = newBriefPace();
  const memory = new Map<string, BriefResult | null>();
  const calls: { key: string; at: number }[] = [];
  const shown: { key: string; value: BriefResult | null; fresh: boolean }[] = [];
  let cleanup: (() => void) | null = null;
  const open = (key: string, today = TODAY) => {
    cleanup?.();
    cleanup = wantBrief(
      key,
      today,
      {
        pace,
        memory,
        max: limits.maxCachedAnswers,
        call: async () => {
          calls.push({ key, at: clock.now() });
          return (opts.reply ?? answerOf)(key);
        },
        minIntervalSeconds: INTERVAL,
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
      (r) => void shown.push({ key, ...r }),
    );
  };
  const close = () => {
    cleanup?.();
    cleanup = null;
  };
  return { clock, open, close, calls, shown, memory, pace };
}

describe("直しY 3：朝の一言が AI の窓口を呼ぶのは、決めた秒数に1回まで", () => {
  test("秒数は config/ai.json の brief.minIntervalSeconds（60秒）。画面はこの部品を通し、待ちを自分で持たない", () => {
    assert.equal((aiJson as { brief: { minIntervalSeconds: number } }).brief.minIntervalSeconds, 60);
    assert.equal(INTERVAL, 60);
    const ui = readFileSync(join(ROOT, "src/app/home/BriefNotes.tsx"), "utf8");
    assert.match(ui, /return wantBrief\(\n\s+key,\n\s+today,/);
    assert.match(ui, /minIntervalSeconds: limits\.minIntervalSeconds/);
    assert.match(ui, /memory: cache,\n\s+max: limits\.maxCachedAnswers/);
    assert.doesNotMatch(ui, /1200|briefAnswer\(|briefKnown\(/, "待つ秒数と覚えの読み方は pace.ts の1か所");
    assert.match(ui, /\/api\/ai\/brief/);
  });

  test("開いた時は呼ぶ（今どおり、材料が少しずつ変わる間の短い待ちだけ）", async () => {
    const s = homeScreen();
    const k = keyOf(2, ["カラー剤を発注"]);
    s.open(k);
    await s.clock.advance(BRIEF_SETTLE_MS - 1);
    assert.equal(s.calls.length, 0, "短い待ちの間は呼ばない");
    await s.clock.advance(1);
    assert.deepEqual(s.calls.map((c) => c.key), [k]);
    assert.equal(s.shown.length, 1);
    assert.equal(s.shown[0].fresh, true);
  });

  test("決めた秒数の中で材料が何回変わっても、呼ぶのは1回（承認・ToDo の済みを続けた）", async () => {
    const s = homeScreen();
    s.open(keyOf(3, ["カラー剤を発注", "シャンプーを発注"]));
    await s.clock.advance(2 * SEC);
    assert.equal(s.calls.length, 1, "開いた時の1回");
    const first = s.calls[0].at;
    // 承認を3回・ToDo の済みを2回（5秒おき）。どれも決めた秒数の中
    const changes = [keyOf(2, ["カラー剤を発注", "シャンプーを発注"]), keyOf(1, ["カラー剤を発注", "シャンプーを発注"]), keyOf(0, ["カラー剤を発注", "シャンプーを発注"]), keyOf(0, ["シャンプーを発注"]), keyOf(0, [])];
    for (const k of changes) {
      s.open(k);
      await s.clock.advance(5 * SEC);
    }
    assert.ok(s.clock.now() - first < INTERVAL * SEC);
    assert.equal(s.calls.length, 1, "秒数の中では呼ばない");
    // 秒数がたつまで進めても、呼ぶのは1回だけ（いちばん新しい材料で）
    await s.clock.advance(INTERVAL * SEC);
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[1].key, changes[changes.length - 1], "いちばん新しい材料");
    assert.ok(s.calls[1].at - first >= INTERVAL * SEC, "前に呼んでから決めた秒数がたった後");
    assert.equal(s.clock.pending(), 0, "待っている物は残らない");
  });

  test("秒数がたつと、いちばん新しい材料で呼ぶ（間の材料では呼ばない）・その後も秒数に1回まで", async () => {
    const s = homeScreen();
    const a = keyOf(2, ["ToDo の一"]);
    const b = keyOf(1, ["ToDo の一"]);
    const c = keyOf(1, []);
    const d = keyOf(0, []);
    s.open(a);
    await s.clock.advance(2 * SEC);
    s.open(b);
    await s.clock.advance(10 * SEC);
    s.open(c);
    await s.clock.advance(INTERVAL * SEC);
    assert.deepEqual(s.calls.map((x) => x.key), [a, c], "b では呼ばない");
    // 続けてすぐ変わっても、前に呼んでから決めた秒数は待つ
    const at = s.calls[1].at;
    s.open(d);
    await s.clock.advance(5 * SEC);
    assert.equal(s.calls.length, 2);
    await s.clock.advance(INTERVAL * SEC);
    assert.deepEqual(s.calls.map((x) => x.key), [a, c, d]);
    assert.ok(s.calls[2].at - at >= INTERVAL * SEC);
    // 出した答えは、呼んだ材料の物だけ（やめた頼みの答えは出さない）
    assert.deepEqual(s.shown.map((x) => x.key), [a, c, d]);
  });

  test("「翌日へ」で今日が変わった後は、待たずに呼ぶ（今どおり）", async () => {
    const s = homeScreen();
    s.open(keyOf(2, ["カラー剤を発注"]));
    await s.clock.advance(2 * SEC);
    const next = keyOf(0, ["翌日の ToDo"]);
    s.open(next, "2026-11-06");
    await s.clock.advance(BRIEF_SETTLE_MS);
    assert.deepEqual(s.calls.map((c) => c.key).slice(1), [next], "前に呼んでから秒数がたっていなくても呼ぶ");
    // その日の中では、また秒数に1回まで
    s.open(keyOf(1, ["翌日の ToDo"]), "2026-11-06");
    await s.clock.advance(10 * SEC);
    assert.equal(s.calls.length, 2);
  });

  test("答えがもうある材料は、待たずに出し、窓口を呼ばない（呼んだ数にも入れない）", async () => {
    const s = homeScreen();
    const a = keyOf(1, ["カラー剤を発注"]);
    const b = keyOf(0, ["カラー剤を発注"]);
    s.open(a);
    await s.clock.advance(2 * SEC);
    s.open(b);
    await s.clock.advance(INTERVAL * SEC);
    assert.equal(s.calls.length, 2);
    // 前の材料に戻した（済みを戻した）：覚えた答えをすぐ出す
    s.open(a);
    await s.clock.advance(0);
    assert.equal(s.calls.length, 2);
    assert.deepEqual(s.shown.at(-1), { key: a, value: answerOf(a), fresh: false });
    // 窓口を呼んでいないので、間合いは変わらない（最後に呼んだのは b の時）
    assert.equal(s.pace.lastAt, s.calls[1].at);
  });

  test("ほかのタブへ移って戻っても（画面を閉じて開き直しても）、間合いは同じ物で数える。閉じた後に答えは出さない", async () => {
    const s = homeScreen();
    s.open(keyOf(2, []));
    await s.clock.advance(2 * SEC);
    s.open(keyOf(1, []));
    await s.clock.advance(1 * SEC);
    s.close();
    await s.clock.advance(5 * SEC);
    s.open(keyOf(0, []));
    await s.clock.advance(5 * SEC);
    assert.equal(s.calls.length, 1, "戻った時も、前に呼んでから秒数がたつまで待つ");
    await s.clock.advance(INTERVAL * SEC);
    assert.equal(s.calls.length, 2);
    assert.equal(s.shown.length, 2);
  });

  test("つながらない・混んでいた（答え無し）も、呼んだ数に入れる（続けて呼ばない）", async () => {
    const s = homeScreen(fakeClock(), { reply: () => null });
    s.open(keyOf(2, []));
    await s.clock.advance(2 * SEC);
    s.open(keyOf(1, []));
    await s.clock.advance(10 * SEC);
    assert.equal(s.calls.length, 1);
    assert.equal(s.shown[0].value, null);
  });

  test("待つ秒数の決め方（1回目・今日が変わった後は短い待ちだけ）", () => {
    const p = newBriefPace();
    assert.equal(briefWaitMs(p, TODAY, 0, INTERVAL), BRIEF_SETTLE_MS);
    p.lastAt = 0;
    p.lastDay = TODAY;
    assert.equal(briefWaitMs(p, TODAY, 10 * SEC, INTERVAL), (INTERVAL - 10) * SEC);
    assert.equal(briefWaitMs(p, TODAY, (INTERVAL - 0.5) * SEC, INTERVAL), BRIEF_SETTLE_MS, "残りが短くても、短い待ちはする");
    assert.equal(briefWaitMs(p, TODAY, 2 * INTERVAL * SEC, INTERVAL), BRIEF_SETTLE_MS);
    assert.equal(briefWaitMs(p, "2026-11-06", 10 * SEC, INTERVAL), BRIEF_SETTLE_MS, "翌日へ");
  });
});

describe("直しY 3：待っている間は、前に出した一言（画面でもう一度門を通した物）を出す", () => {
  const material = (approvalLabel: string): BriefMaterial => ({
    items: [item("【予約1】", "メニュー：カット。前回の記録なし"), item("【承認1】", "予約の仮押さえ。メニュー：カラー")],
    labels: { "【予約1】": "10:00 青木様 カット", "【承認1】": approvalLabel },
  });
  const value: BriefResult = { mode: "ai", notes: ["【予約1】のご希望を聞く", "【予約1】は大丈夫", "【承認1】を確かめる", "【予約2】の前回"], dropped: [] };

  test("出す行は、画面でもう一度門を通し（判断の言葉・知らない印は外す）、印を日時・お名前に置きかえた物", () => {
    const lines = shownBriefNotes(value, material("承認待ち（佐藤様 11月6日 14:00 カラー）"), limits);
    assert.deepEqual(lines, ["10:00 青木様 カットのご希望を聞く", "承認待ち（佐藤様 11月6日 14:00 カラー）を確かめる"]);
    assert.deepEqual(shownBriefNotes(null, material("x"), limits), [], "答え無しは出さない");
  });

  test("答えが届いた材料はその行。待っている間は前に出した行（同じ今日だけ）。答え無し・今日が変わった後は出さない", () => {
    const before = shownBriefNotes(value, material("承認待ち（佐藤様 11月6日 14:00 カラー）"), limits);
    const last: BriefLastShown = { today: TODAY, lines: before };
    // 承認した後、次の答えを待つ間：前に出した行（印は前の材料の札で置きかえた物のまま。今の材料の札では置きかえない）
    assert.deepEqual(briefShown({ today: TODAY, resolved: false, lines: [] }, last), before);
    // 次の答えが届いた
    const after = shownBriefNotes({ mode: "ai", notes: ["【予約1】のご希望を聞く"], dropped: [] }, material("承認待ち（鈴木様 11月7日 11:00 カラー）"), limits);
    assert.deepEqual(briefShown({ today: TODAY, resolved: true, lines: after }, last), ["10:00 青木様 カットのご希望を聞く"]);
    // AI につながらなかった（答え無し）：欄ごと出さない（前の行も出さない）
    assert.deepEqual(briefShown({ today: TODAY, resolved: true, lines: [] }, last), []);
    // 「翌日へ」の後は、前の日の一言を出さない（今どおり、答えが届くまで出さない）
    assert.deepEqual(briefShown({ today: "2026-11-06", resolved: false, lines: [] }, last), []);
    // 前に出した一言が無い（開いた時）
    assert.deepEqual(briefShown({ today: TODAY, resolved: false, lines: [] }, null), []);
  });

  test("画面は、いま出している行を覚え、出していない時は消す（答え無し・材料が無い時は、待つ間にも出さない）", () => {
    const ui = readFileSync(join(ROOT, "src/app/home/BriefNotes.tsx"), "utf8");
    assert.match(ui, /const lines = key \? briefShown\(\{ today, resolved, lines: shownBriefNotes\(value, material, limits\) \}, lastShown\) : \[\];/);
    assert.match(ui, /lastShown = lines\.length \? \{ today, lines \} : null;/);
    assert.match(ui, /if \(!key \|\| lines\.length === 0\) return null;/);
  });
});
