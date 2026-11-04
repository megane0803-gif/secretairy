// 予約の一本道：お客様が頼む → 空きとルールを確かめて候補 → 選ぶと仮押さえ。
// どの曜日・どの時刻に開いても、例文の「普通の予約」で仮押さえが1件でき、
// 「ルールで断られる予約」は断られて代わりが出ること。Claude は呼ばず、決まった返事に置きかえる。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addDays } from "../../calendar";
import { LOCKED_RULES } from "../../rules/locked";
import { normalExample, previousExample, rejectedExample } from "../examples";
import type { ReplyModel } from "../model";
import { parseReserveRequest } from "../request";
import { judgeSlot } from "../slots";
import { runTool, TOOL_DEFS } from "../tools";
import { ai, at, chat, ctxAt, menus, twoTurns } from "./helpers";

// 2026-11-02（月）から1週間（火曜は定休日）× 朝・昼・夕方・夜
const DATES = Array.from({ length: 7 }, (_, i) => addDays("2026-11-02", i));
const TIMES = ["08:30", "12:00", "18:30", "23:30"];
const DAY = ["月", "火", "水", "木", "金", "土", "日"];

describe("どの曜日に開いても", () => {
  for (const [i, date] of DATES.entries())
    for (const time of TIMES) {
      const name = `${date}（${DAY[i]}）${time}`;

      test(`${name}：普通の予約 → 候補 → 「1つ目で」で仮押さえが1件`, async () => {
        const ctx = ctxAt(at(date, time));
        const ex = normalExample(ctx);
        assert.ok(ex, "普通の予約の例文が作れる");
        const { a, b, shown } = await twoTurns(ctx, ex.text);
        assert.equal(a.holds.length, 0, "選ぶ前は仮押さえしない");
        assert.ok(shown.length >= 1 && shown.length <= 2, "候補は1つか2つ");
        assert.equal(b.holds.length, 1, "仮押さえが1件");
        assert.equal(judgeSlot(ctx, b.holds[0]).ok, true, "仮押さえはプログラムの判定を通っている");
        assert.match(b.text, /仮でお取りしました/);
        assert.doesNotMatch(b.text, /確定しました/);
      });

      test(`${name}：ルールで断られる予約 → 断られて、代わりが出る`, async () => {
        const ctx = ctxAt(at(date, time));
        const ex = rejectedExample(ctx);
        assert.ok(ex, "断られる予約の例文が作れる");
        const r = await chat(ctx, [{ role: "user", text: ex.text }]);
        assert.equal(r.holds.length, 0, "仮押さえはしない");
        assert.ok(r.steps.some((s) => s.kind === "reject"), "AI の手順に、外した理由がある");
        assert.match(r.text, /お受けできません/, "理由を1文で伝える");
        assert.ok(r.candidates && r.candidates.length >= 1 && r.candidates.length <= 2, "代わりは1つか2つ");
        for (const c of r.candidates!) assert.equal(judgeSlot(ctx, c).ok, true, "代わりはどれも受けられる");
      });
    }

  for (const date of DATES)
    test(`${date} 12:00：「ルールで断られる予約」は、ルール（店の設定ではない）で断られる`, async () => {
      const ctx = ctxAt(at(date, "12:00"));
      const ex = rejectedExample(ctx)!;
      const r = await chat(ctx, [{ role: "user", text: ex.text }]);
      assert.ok(r.steps.some((s) => s.text.startsWith("ルールで外した")), r.steps.map((s) => s.text).join("\n"));
    });
});

describe("前と同じで", () => {
  test("前回のメニューで空きを探し、「1つ目で」で仮押さえ", async () => {
    const ctx = ctxAt(at("2026-11-04", "10:00"));
    const { a, b } = await twoTurns(ctx, previousExample().text);
    assert.ok(a.steps.some((s) => s.text.startsWith("前回を見る") && s.text.includes("カット＋カラー")));
    assert.ok(a.candidates?.every((c) => c.menuId === "cut_color"), "前回と同じメニュー");
    assert.equal(b.holds.length, 1);
    assert.equal(b.holds[0].menuId, "cut_color");
  });
  test("前回の記録が無い方には、メニューをたずねる", async () => {
    const ctx = ctxAt(at("2026-11-04", "10:00"), {}, "c10");
    const r = await chat(ctx, [{ role: "user", text: "前と同じでお願いします" }]);
    assert.equal(r.holds.length, 0);
    assert.match(r.text, /メニュー/);
  });
});

describe("仮押さえの守り", () => {
  const now = at("2026-11-04", "10:00");

  test("🔒 確定の道具は無い。呼ぼうとしても止める", () => {
    assert.deepEqual(TOOL_DEFS.map((t) => t.name).sort(), ["check_rules", "find_openings", "place_hold", "previous_visit", "release_hold"]);
    assert.ok(!TOOL_DEFS.some((t) => /confirm|確定/.test(t.name)), "確定の道具は無い");
    const out = runTool(ctxAt(now), "confirm_reservation", {});
    assert.equal(out.isError, true);
    assert.equal(out.hold, undefined);
  });

  test("お客様に出していない日時は、仮押さえしない", () => {
    const ctx = ctxAt(now);
    const slot = { menu_id: "cut", date: "2026-11-05", start: "16:00" };
    const out = runTool({ ...ctx, shown: [] }, "place_hold", slot);
    assert.equal(out.hold, undefined);
    assert.equal(out.isError, true);
  });

  test("サーバーでもう一度判定する：候補を出した後に埋まったら、仮押さえしない", () => {
    const ctx = ctxAt(now);
    const shown = [{ menuId: "cut", date: "2026-11-05", start: "16:00" }];
    assert.equal(judgeSlot(ctx, shown[0]).ok, true);
    // 同じ時間に3席とも埋まった
    const full = Array.from({ length: 3 }, (_, i) => ({
      id: `x${i}`, customerId: "c01", menuId: "cut", date: "2026-11-05", start: "16:00", status: "hold" as const, newCustomer: false,
    }));
    const out = runTool({ ...ctx, shown, booked: [...ctx.booked, ...full] }, "place_hold", { menu_id: "cut", date: "2026-11-05", start: "16:00" });
    assert.equal(out.hold, undefined);
    assert.ok(out.steps.some((s) => s.kind === "reject"));
  });

  test("1回の相談で道具を呼ぶ回数に上限がある", async () => {
    let turns = 0;
    const greedy: ReplyModel = {
      async turn() {
        turns += 1;
        const id = `g${turns}`;
        return {
          assistant: [{ type: "tool_use", id, name: "find_openings", input: { menu_id: "cut" } }],
          toolCalls: [{ id, name: "find_openings", input: { menu_id: "cut" } }],
          stop: "tool",
        };
      },
    };
    const r = await chat(ctxAt(now), [{ role: "user", text: "カット" }], greedy);
    assert.equal(r.steps.filter((s) => s.text.startsWith("空きを調べる")).length, ai.maxToolCalls);
    assert.ok(r.steps.some((s) => s.kind === "limit"));
    assert.ok(turns <= ai.maxToolCalls + 1);
  });

  test("画面から送られたルールで、鍵つきは緩まない", () => {
    const parsed = parseReserveRequest(
      {
        messages: [{ role: "user", text: "カット" }],
        candidates: [],
        customer: { id: "c01", surname: "青木", firstVisit: false },
        booked: [],
        rules: [
          { id: LOCKED_RULES[0].id, level: "global", label: "AI が確定してよい", check: { kind: "text" } },
          { id: "own1", level: "global", label: "予約の確定は AI に任せる", check: { kind: "text" } },
          { id: "own2", level: "global", label: "予約は来店の1時間前まで", check: { kind: "minLeadMinutes", value: 60 } },
        ],
      },
      menus,
      ai,
    );
    assert.ok(parsed.ok);
    const rules = parsed.value.rules;
    assert.deepEqual(
      rules.filter((r) => r.locked).map((r) => r.label),
      LOCKED_RULES.map((r) => r.label),
    );
    assert.deepEqual(rules.filter((r) => !r.locked).map((r) => r.id), ["own2"]);
  });
});
