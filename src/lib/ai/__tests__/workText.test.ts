// 直しH：予約チャットの返事に、AI の作業の文（英語など）を出さない。
// 本番で、道具を呼ぶ回に AI が書いた「Tool confirms. Place hold…」がお客様への返事の頭に付いた。
// お客様に出すのは「道具を呼ばずに終わった最後の回の文」だけで、英語の作業の文は返事の門で決まった文に差し替える。
// Claude は呼ばない。回ごとの文と道具を決めて渡す作り物のモデルで試す。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LIMIT_REPLY, PICK_LINE } from "../agent";
import { workTextHit } from "../innerGate";
import type { ModelTurn, ReplyModel } from "../model";
import type { Rule } from "../../rules/types";
import { ai, at, chat, ctxAt } from "./helpers";

const now = at("2026-11-04", "10:00"); // 水曜

type Round = {
  /** その回に AI が書く文（道具を呼ぶ回にも書ける） */
  text?: string | ((labels: string[]) => string);
  /** その回に呼ぶ道具（無ければ、道具を呼ばずに終わる回） */
  call?: { name: string; input: Record<string, unknown> | ((ctx: { candidates: { date: string; start: string; menuId: string }[] }) => Record<string, unknown>) };
  stop?: ModelTurn["stop"];
};

/** 回ごとの文と道具を決めて渡す作り物のモデル。道具の答えの候補（label）は、あとの回の文に使える */
function rounds(list: Round[]): ReplyModel & { seen: number } {
  const labels: string[] = [];
  const m = {
    seen: 0,
    async turn(req: Parameters<ReplyModel["turn"]>[0], onText: (d: string) => void): Promise<ModelTurn> {
      const last = req.messages[req.messages.length - 1];
      if (last && Array.isArray(last.content))
        for (const b of last.content)
          if (b.type === "tool_result" && typeof b.content === "string") {
            const d = JSON.parse(b.content) as { candidates?: { label: string }[]; alternatives?: { label: string }[] };
            for (const c of [...(d.candidates ?? []), ...(d.alternatives ?? [])]) labels.push(c.label);
          }
      const r = list[Math.min(m.seen, list.length - 1)];
      m.seen += 1;
      const text = typeof r.text === "function" ? r.text(labels) : (r.text ?? "");
      // 文は少しずつ流す（Claude と同じ）
      for (const part of text.match(/.{1,5}/gsu) ?? []) onText(part);
      const blocks: ModelTurn["assistant"] = text ? [{ type: "text", text }] : [];
      if (!r.call) return { assistant: blocks.length ? blocks : [{ type: "text", text: "" }], toolCalls: [], stop: r.stop ?? "end" };
      const id = `wt-${m.seen}`;
      const input = typeof r.call.input === "function" ? r.call.input({ candidates: req.candidates }) : r.call.input;
      return { assistant: [...blocks, { type: "tool_use", id, name: r.call.name, input }], toolCalls: [{ id, name: r.call.name, input }], stop: r.stop ?? "tool" };
    },
  };
  return m;
}

const WORK = "Tool confirms. Place hold for the first slot.";

describe("返事の門：英語の作業の文を見つける（workTextHit）", () => {
  test("英字の単語が3つ以上続けば当たる", () => {
    assert.ok(workTextHit("Tool confirms. Place hold…"));
    assert.ok(workTextHit("11/9 15:30 はいかがでしょう。Let me check"));
    assert.ok(workTextHit("ｔｏｏｌ ｃｏｎｆｉｒｍｓ ｉｔ"), "全角の英字も同じに見る");
  });

  test("英字が合わせて20字以上なら、ばらばらでも当たる", () => {
    assert.ok(workTextHit("確認しました。confirmation の結果、availability は alternatives です。"));
  });

  test("時刻・日付・数字・「AI」「LINE」のような短い英字だけなら当たらない", () => {
    assert.equal(workTextHit("11/9（月） 16:00–19:00 縮毛矯正 でお取りできます。"), null);
    assert.equal(workTextHit("LINE でご連絡します。"), null);
    assert.equal(workTextHit("AI の秘書がお答えしています。OK です。"), null);
    assert.equal(workTextHit("1つ目：11/6（金） 14:00–15:00 カット、2つ目：11/7（土） 13:00–14:00 カット はいかがでしょう。"), null);
    assert.equal(workTextHit("LINE と AI でご案内します。"), null, "短い英字が2つ続くだけなら当たらない");
  });
});

describe("お客様に出すのは、道具を呼ばずに終わった最後の回の文だけ", () => {
  test("道具を呼ぶ回に英語の文、最後の回に日本語の文 → 返事は最後の回の日本語だけ（手順の欄にも英語は出さない）", async () => {
    const model = rounds([
      { text: WORK, call: { name: "find_openings", input: { menu_ids: ["cut"], date: "2026-11-06" } } },
      { text: (l) => `${l[0]} はいかがでしょう。${PICK_LINE}` },
    ]);
    const r = await chat(ctxAt(now), [{ role: "user", text: "11/6にカット" }], model);
    assert.ok(r.text.startsWith("11/6（金）"), r.text);
    assert.equal(workTextHit(r.text), null);
    assert.ok(!r.text.includes("Tool"));
    assert.ok(!r.steps.some((s) => /Tool|Place hold/.test(s.text)), "AI の手順の欄にも作業の文は出さない");
    assert.ok(!r.steps.some((s) => s.text.includes("英語")), "最後の回の文が日本語なら差し替えない");
    assert.equal(r.candidates?.length, 1);
  });

  test("日本語の作業の文でも、道具を呼んだ回の文はお客様に出さない", async () => {
    const model = rounds([
      { text: "空きを調べます。", call: { name: "find_openings", input: { menu_ids: ["cut"], date: "2026-11-06" } } },
      { text: (l) => `${l[0]} でお取りできます。` },
    ]);
    const r = await chat(ctxAt(now), [{ role: "user", text: "11/6にカット" }], model);
    assert.ok(!r.text.includes("空きを調べます"), r.text);
    assert.ok(r.text.startsWith("11/6（金）"));
  });

  test("最後の回が英語の文だけ → 決まった文に差し替わり、手順の欄に1行", async () => {
    const model = rounds([
      { text: WORK, call: { name: "find_openings", input: { menu_ids: ["cut"], date: "2026-11-06" } } },
      { text: "The first slot is available. Shall I place a hold?" },
    ]);
    const r = await chat(ctxAt(now), [{ role: "user", text: "11/6にカット" }], model);
    assert.equal(workTextHit(r.text), null, r.text);
    assert.ok(r.text.includes("でお取りできます。"), r.text);
    assert.ok(r.text.endsWith(PICK_LINE));
    const lines = r.steps.filter((s) => s.text === "返事に英語の作業の文があったので、決まった文に差し替えた");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].kind, "reject");
    assert.ok((r.candidates?.length ?? 0) > 0, "差し替えた決まった文の候補にはボタンが出る");
  });

  test("最後の回の文が空 → 黙って終わらず、決まった文（代わりの候補）で返す", async () => {
    const model = rounds([{ text: WORK, call: { name: "find_openings", input: { menu_ids: ["cut"], date: "2026-11-06" } } }, { text: "" }]);
    const r = await chat(ctxAt(now), [{ role: "user", text: "11/6にカット" }], model);
    assert.ok(r.text.length > 0);
    assert.ok(r.text.includes("でお取りできます。"), r.text);
    assert.ok(!r.text.includes("Tool"));
  });

  test("道具を呼ばず、最後の回の文も空 → 決まった文（お店に確かめてご連絡します）", async () => {
    const r = await chat(ctxAt(now), [{ role: "user", text: "こんにちは" }], rounds([{ text: "" }]));
    assert.equal(r.text, "お店に確かめてご連絡します。");
  });

  test("時刻や「LINE」だけの英字は差し替えない", async () => {
    const say = "11/6（金）の14:00からカットでお取りできます。ご連絡は LINE でもかまいません。";
    const r = await chat(ctxAt(now), [{ role: "user", text: "11/6にカット" }], rounds([{ text: say }]));
    assert.equal(r.text, say);
    assert.ok(!r.steps.some((s) => s.kind === "reject"));
  });
});

describe("止めた時の決まった文は今のまま", () => {
  test("道具を呼ぶ回数の上限で止めた → 「お店に確かめてから、ご連絡します。」だけ（作業の文は付かない）", async () => {
    const model = rounds([{ text: WORK, call: { name: "find_openings", input: { menu_ids: ["cut"], date: "2026-11-06" } } }]);
    const r = await chat(ctxAt(now), [{ role: "user", text: "11/6にカット" }], model);
    assert.equal(r.text, LIMIT_REPLY);
    assert.ok(r.steps.some((s) => s.kind === "limit" && s.text.includes(`${ai.maxToolCalls}回`)));
    assert.ok(!r.steps.some((s) => s.text.includes("英語")));
  });

  test("長すぎて止めた → 最後の回の文＋「（長くなったので、ここで止めました）」", async () => {
    const model = rounds([
      { text: WORK, call: { name: "find_openings", input: { menu_ids: ["cut"], date: "2026-11-06" } } },
      { text: "11/6（金）の14:00からカットでお取りできます。ご希望", stop: "max_tokens" },
    ]);
    const r = await chat(ctxAt(now), [{ role: "user", text: "11/6にカット" }], model);
    assert.equal(r.text, "11/6（金）の14:00からカットでお取りできます。ご希望（長くなったので、ここで止めました）");
  });

  test("断られた → 「お店に確かめてから、ご連絡します。」（断られた回の文は付かない）", async () => {
    const model = rounds([
      { text: WORK, call: { name: "find_openings", input: { menu_ids: ["cut"], date: "2026-11-06" } } },
      { text: "I cannot", stop: "refusal" },
    ]);
    const r = await chat(ctxAt(now), [{ role: "user", text: "11/6にカット" }], model);
    assert.equal(r.text, LIMIT_REPLY);
  });
});

describe("本番で出た流れ：「縮毛矯正の最終受付は15時」→ 青木様「11/9の15時半に縮毛矯正」→「1つ目で」", () => {
  const own: Rule = { id: "own-ls", level: "menu", menuId: "straight", label: "縮毛矯正の最終受付は15時", check: { kind: "lastStart", time: "15:00" } };
  const withRule = (tell: boolean) => {
    const c = ctxAt(now, {}, "c01");
    return { ...c, rules: [...c.rules, { ...own, ...(tell ? { tellCustomer: true } : {}) }] };
  };
  const ASK = "11/9の15時半に縮毛矯正できますか？";

  for (const tell of [false, true]) {
    test(`ルールを${tell ? "伝える" : "伝えない"}時も、どちらの返事にも英語の作業の文が出ない`, async () => {
      const c = withRule(tell);
      // 1回目：ルールを確かめる回に英語の文 → 代わりの候補
      const first = await chat(c, [{ role: "user", text: ASK }], rounds([
        { text: "Tool says it is refused. Offer alternatives.", call: { name: "check_rules", input: { menu_ids: ["straight"], date: "2026-11-09", start: "15:30" } } },
        { text: (l) => `その時間はお受けできません。代わりに、1つ目：${l[0]} はいかがでしょう。${PICK_LINE}` },
      ]));
      assert.equal(workTextHit(first.text), null, first.text);
      assert.ok((first.candidates?.length ?? 0) > 0, first.text);
      // 2回目：「1つ目で」→ 仮押さえの回に英語の文 → 最後の回は英語だけ（決まった文に差し替わる）
      const shown = first.candidates!;
      const second = await chat({ ...c, shown }, [
        { role: "user", text: ASK },
        { role: "assistant", text: first.text },
        { role: "user", text: "1つ目で" },
      ], rounds([
        { text: WORK, call: { name: "place_hold", input: ({ candidates }) => ({ menu_ids: [candidates[0].menuId], date: candidates[0].date, start: candidates[0].start }) } },
        { text: "Hold placed. Tell the customer." },
      ]));
      assert.equal(second.holds.length, 1);
      assert.equal(workTextHit(second.text), null, second.text);
      assert.match(second.text, /を仮でお取りしました。お店から確定のご連絡をします。$/);
      assert.ok(second.steps.some((s) => s.text === "返事に英語の作業の文があったので、決まった文に差し替えた"));
    });
  }
});
