// 「AI の手順」の印のテスト（見た目だけ。行の中身・日誌の文は変えない）。
// 各行の頭に：✓ 通った／! 断った・気をつける／→ 次にしたこと。お客様の文には「外」、AI には「AI」の札。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsultationSteps, StepLine } from "../../../components/AiSteps";
import { runTool } from "../tools";
import type { Step } from "../wire";
import { STEP_MARK, stepMark } from "../stepMarks";
import { ctxAt } from "./helpers";

const line = (step: Step) => renderToStaticMarkup(createElement(StepLine, { step }));

describe("1. どの行にどの印か（stepMarks.ts）", () => {
  test("印は3つだけ：✓ 通った／! 断った・気をつける／→ 次にしたこと", () => {
    assert.deepEqual(
      Object.values(STEP_MARK).map((m) => `${m.mark} ${m.label}`),
      ["✓ 通った", "! 断った・気をつける", "→ 次にしたこと"],
    );
  });

  test("道具で受けられた・見つかった行は ✓", () => {
    assert.equal(stepMark({ kind: "tool", text: "ルールを確かめる：11/12（木）10:00 カット → ✓ 受けられます" }), "ok");
    assert.equal(stepMark({ kind: "tool", text: "空きを調べる：カットを 11/12（木） から → 11/12（木）10:00・11/12（木）13:00" }), "ok");
    assert.equal(stepMark({ kind: "tool", text: "前回を見る：久保様 → 10/20（火）カット（60分。保存したカルテから）" }), "ok");
  });

  test("断った・外した・受けられない・見つからない・上限は !", () => {
    for (const s of [
      { kind: "reject", text: "ルールで外した：[全体] 縮毛矯正は24時間前まで（…）" },
      { kind: "reject", text: "仮押さえ：お客様が選んだ候補ではないので押さえない（…）" },
      { kind: "limit", text: "道具を呼ぶ回数の上限（6回）に来たので止めた" },
      { kind: "tool", text: "ルールを確かめる：11/12（木）19:30 カット → ✗ 受けられません" },
      { kind: "tool", text: "空きを調べる：カットを 11/12（木） から → 見つかりませんでした" },
      { kind: "tool", text: "前回を見る：大橋様 → 前回の記録なし（カルテがありません）" },
      { kind: "tool", text: "代わりを調べる：→ 見つかりませんでした" },
    ] as Step[])
      assert.equal(stepMark(s), "warn", s.text);
  });

  test("仮押さえ・外す・聞き返す・代わりを調べる・ToDo・料金は →", () => {
    for (const s of [
      { kind: "hold", text: "仮押さえ：11/12（木）10:00 カット（承認の箱へ。期限は24時間）" },
      { kind: "release", text: "仮押さえを外す：…" },
      { kind: "ask", text: "日付の確かめ：「20日」と「来週」が食い違うので、決めずに聞き返した" },
      { kind: "todo", text: "ToDo に足した：…" },
      { kind: "price", text: "料金を答えた：カット 4,800円" },
      { kind: "tool", text: "代わりを調べる：→ 11/13（金）10:00・11/13（金）13:00" },
    ] as Step[])
      assert.equal(stepMark(s), "next", s.text);
  });

  test("本物の道具の行（tools.ts）にも、どれか1つの印が付く", () => {
    const ctx = ctxAt(new Date("2026-11-09T00:00:00Z"));
    const out = runTool(ctx, "find_openings", { menu_id: "cut" });
    assert.ok(out.steps.length > 0);
    for (const s of out.steps) assert.ok(["ok", "warn", "next"].includes(stepMark(s)));
    assert.equal(stepMark(out.steps[0]), out.candidates?.length ? "ok" : "warn");
  });
});

describe("2. 出し方（AiSteps の StepLine・ConsultationSteps）", () => {
  test("行の頭に印（読み上げは言葉で）、そのあとに今までの文をそのまま", () => {
    const html = line({ kind: "reject", text: "ルールで外した：例" });
    assert.match(html, /^<li class="step reject mark-warn"><span class="step-mark" title="断った・気をつける" aria-label="断った・気をつける">!<\/span><span class="step-text">ルールで外した：例<\/span><\/li>$/);
    assert.match(line({ kind: "tool", text: "ルールを確かめる：x → ✓ 受けられます" }), /class="step-mark"[^>]*>✓</);
    assert.match(line({ kind: "hold", text: "仮押さえ：x" }), /class="step hold mark-next"[^>]*>.*>→</);
  });

  test("相談：お客様の文に「外」、AI の相談に「AI」、決まった返事は「決まった返事（AI なし）」", () => {
    const base = { id: 1, at: "2026-11-09T00:00:00Z", question: "金曜にカット", steps: [{ kind: "tool", text: "ルールを確かめる：x → ✓ 受けられます" }] as Step[] };
    const ai = renderToStaticMarkup(createElement(ConsultationSteps, { c: { ...base, mode: "ai" } }));
    assert.match(ai, /class="tag actor actor-outside"[^>]*><b class="actor-mark">外<\/b> お客様<\/span>/);
    assert.match(ai, /「金曜にカット」/);
    assert.match(ai, /class="tag actor actor-ai"[^>]*><b class="actor-mark">AI<\/b><\/span>/);
    assert.equal((ai.match(/class="step-mark"/g) ?? []).length, 1);
    const script = renderToStaticMarkup(createElement(ConsultationSteps, { c: { ...base, mode: "script" } }));
    assert.match(script, /決まった返事（AI なし）/);
    assert.doesNotMatch(script, /actor-ai/);
  });
});
