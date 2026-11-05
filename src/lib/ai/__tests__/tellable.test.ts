// 予約チャットで、お客様に「店の中の決まり」を伝えないこと（docs/SPEC.md §1.2.1）。Claude は呼ばない。
// 1. お客様に伝えるかは、ルールごとにオーナーが決める（Rule の tellCustomer。欄が無い・前からのルールは伝えない）
// 2. 伝えないルールで断るときは、AI に文を作らせない。プログラムが「その時間はお受けできません」＋確かめ済みの代わりの候補で返す
// 3. 伝えるルールは、ルールの名前（オーナーの言葉）をそのまま理由にする
// 4. 組み合わせのルールも同じチェックで分ける。伝えないときは「この組み合わせではお受けできません」と、その組み合わせにならない代わり
// 5. 店の設定（定休日・営業時間・過ぎた時刻・メニューの最終受付）は今までどおり伝える
// 6. 返事の門（後ろの守り）：伝えないルールの文と「○分あける」の形だけ止める。ふつうの時間の言い方は止めない
// 7. 言葉で足したルールも、足す時のチェックで同じように分かれる

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import seedRules from "../../../../config/rules.seed.json";
import type { Verdict } from "../../rules/judge";
import { LOCKED_RULES } from "../../rules/locked";
import { parseOverlay } from "../../rules/overlay";
import { COMBO_REFUSAL, INTERNAL_REFUSAL, tellsRule } from "../../rules/tellable";
import type { Rule } from "../../rules/types";
import { validateOwnerRule } from "../../rules/validate";
import { runRuleWords, scriptRuleReader } from "../../rules/words";
import { innerWordsHit } from "../innerGate";
import type { ModelTurn, ReplyModel } from "../model";
import { reserveSystem } from "../reservePrompt";
import { judgeSlot, refusalOf } from "../slots";
import { runTool } from "../tools";
import type { BookedRow } from "../wire";
import { at, chat, ctxAt, menus } from "./helpers";

const now = at("2026-11-04", "10:00"); // 水曜
const DAY = "2026-11-07"; // 土曜（営業日）
const IDS = menus.map((m) => m.id);

/** 「カラーの後は15分あける」（お客様に伝えない） */
const BUFFER: Rule = { id: "own-buf", level: "menu", menuId: "color", label: "カラーの後は15分あける", check: { kind: "bufferAfterMinutes", value: 15 } };
/** 同じルールで、お客様に伝える */
const BUFFER_TOLD: Rule = { ...BUFFER, id: "own-buf-told", tellCustomer: true };
/** 「縮毛矯正とヘッドスパは同じ日に受けない」 */
const PAIR: Rule = { id: "own-pair", level: "menu", menuId: "straight", label: "縮毛矯正とヘッドスパは同じ日に受けない", check: { kind: "notTogether", with: "headspa" } };
const PAIR_TOLD: Rule = { ...PAIR, id: "own-pair-told", tellCustomer: true };

/** 11/7 10:00–11:30 にほかの方のカラー。11:30 からのカットは「間」だけにかかる（同じ時間に受けるのは1人） */
const COLOR_BEFORE: BookedRow = { id: "b-color", customerId: "c01", menuId: "color", date: DAY, start: "10:00", status: "confirmed", newCustomer: false };
const ASK_1130 = "11/7の11:30からカットをお願いします";
const ASK_PAIR = "縮毛矯正とヘッドスパを11/7にお願いします";

function ctxWith(rules: Rule[], booked: BookedRow[] = [COLOR_BEFORE]) {
  const base = ctxAt(now);
  return { ...base, rules: [...base.rules, ...rules], booked };
}

/** 中の決まりの言葉がお客様への文に無いこと */
function noInnerWords(text: string, extra: string[] = []) {
  for (const w of ["15分", "あけ", "空け", "間を", "決まり", "ルール", BUFFER.label, PAIR.label, "同じ時間に受ける", "人まで", ...extra])
    assert.ok(!text.includes(w), `「${w}」がお客様への文にある：${text}`);
}

/** 道具を順に呼び、最後に決めた文を言う（Claude が言いかえたつもり）。返事の番が来なければ文は言わない */
function sayingModel(calls: { name: string; input: Record<string, unknown> }[], finalText: string): ReplyModel & { finals: number } {
  let i = 0;
  const m = {
    finals: 0,
    async turn(_req: unknown, onText: (d: string) => void): Promise<ModelTurn> {
      if (i < calls.length) {
        const c = calls[i++];
        const id = `t-${i}`;
        return { assistant: [{ type: "tool_use", id, name: c.name, input: c.input }], toolCalls: [{ id, name: c.name, input: c.input }], stop: "tool" };
      }
      m.finals += 1;
      onText(finalText);
      return { assistant: [{ type: "text", text: finalText }], toolCalls: [], stop: "end" };
    },
  };
  return m;
}

describe("1. 「お客様に伝える」の欄（ルールごと。オーナーが決める）", () => {
  test("チェックあり（true）だけ残る。欄が無い・ほかの値は「伝えない」", () => {
    const yes = validateOwnerRule({ ...BUFFER, tellCustomer: true }, IDS);
    assert.ok(yes.ok && yes.value.tellCustomer === true && tellsRule(yes.value));
    for (const v of [undefined, false, "true", 1]) {
      const r = validateOwnerRule({ ...BUFFER, tellCustomer: v }, IDS);
      assert.ok(r.ok);
      if (!r.ok) continue;
      assert.equal("tellCustomer" in r.value, false, String(v));
      assert.equal(tellsRule(r.value), false);
    }
  });

  test("欄が無い前からのルール（ブラウザに残っていた物）は伝えない。チェックを入れて残した物は伝える", () => {
    const stored = JSON.stringify({
      added: [
        { id: "old-1", level: "menu", menuId: "color", label: "カラーの後は15分あける", check: { kind: "bufferAfterMinutes", value: 15 } },
        { id: "new-1", level: "menu", menuId: "color", label: "カラーの後は20分あける", check: { kind: "bufferAfterMinutes", value: 20 }, tellCustomer: true },
      ],
      changed: {},
      removed: [],
    });
    const o = parseOverlay(stored, (seedRules as Rule[]).map((r) => r.id));
    assert.equal(tellsRule(o.added.find((x) => x.id === "old-1")!), false);
    assert.equal(tellsRule(o.added.find((x) => x.id === "new-1")!), true);
  });

  test("最初のルール（config/rules.seed.json）は全部チェックが外れている。🔒 は伝える理由にならない", () => {
    for (const r of seedRules as Rule[]) assert.equal(tellsRule(r), false, r.id);
    for (const r of LOCKED_RULES) assert.equal(tellsRule({ ...r, tellCustomer: true }), false, r.id);
  });
});

describe("2. チェックなし：間をあけるルール → 返事に分数やルールの文が入らない", () => {
  test("11/7 11:30 のカット（前のカラーの後の15分にかかる）→「その時間はお受けできません」と確かめ済みの代わり", async () => {
    const ctx = ctxWith([BUFFER]);
    const v = judgeSlot(ctx, { menuId: "cut", date: DAY, start: "11:30" });
    assert.equal(v.ok, false);
    assert.deepEqual(v.results.filter((r) => !r.ok).map((r) => r.rule.id), ["own-buf"], "間のルールだけで断られる");
    assert.ok(v.base.every((b) => b.ok));

    const r = await chat(ctx, [{ role: "user", text: ASK_1130 }]);
    assert.equal(r.holds.length, 0);
    assert.match(r.text, /^その時間はお受けできません。代わりに、1つ目：/);
    noInnerWords(r.text);
    assert.ok(r.candidates && r.candidates.length >= 1);
    for (const c of r.candidates!) assert.equal(judgeSlot(ctx, c).ok, true, "代わりはどれもプログラムが確かめ済み");
    assert.ok(r.steps.some((s) => s.text.includes(BUFFER.label)), "AI の手順（オーナー向け）には理由を出す");
  });

  test("AI に渡す道具の答えにも、指示にも、間のルールの中身は入らない", () => {
    const ctx = ctxWith([BUFFER]);
    const out = runTool(ctx, "check_rules", { menu_ids: ["cut"], date: DAY, start: "11:30" });
    assert.equal(out.hidden, true);
    assert.equal(JSON.parse(out.content).reason, INTERNAL_REFUSAL);
    noInnerWords(out.content.replace(/"label":"[^"]*"/g, ""));
    assert.ok(!reserveSystem(ctx, []).includes(BUFFER.label), "指示に間のルールの文を入れない");
  });

  test("言いかえ（「少し時間をあけています」など）は出ない：伝えないルールで断ったら、AI に返事の番を渡さない", async () => {
    const ctx = ctxWith([BUFFER]);
    for (const leak of ["カラーの後は少し時間をあけています。", "準備や片付けの時間があるので、その時間は難しいです。", "前の方の施術の後に間をとっているためです。"]) {
      const model = sayingModel([{ name: "check_rules", input: { menu_ids: ["cut"], date: DAY, start: "11:30" } }], leak);
      const r = await chat(ctx, [{ role: "user", text: ASK_1130 }], model);
      assert.equal(model.finals, 0, "AI は断りの文を作っていない");
      assert.ok(!r.text.includes(leak));
      assert.match(r.text, /^その時間はお受けできません。/);
      noInnerWords(r.text, ["準備", "片付け", "少し時間"]);
    }
  });

  test("仮押さえの時にもう一度確かめて間にかかったら、同じく決まった文", async () => {
    const ctx = { ...ctxWith([BUFFER]), shown: [{ menuId: "cut", date: DAY, start: "11:30" }] };
    const model = sayingModel([{ name: "place_hold", input: { menu_ids: ["cut"], date: DAY, start: "11:30" } }], "カラーの後は15分あけるので取れませんでした。");
    const r = await chat(ctx, [{ role: "user", text: "1つ目で" }], model);
    assert.equal(r.holds.length, 0);
    assert.equal(model.finals, 0);
    assert.match(r.text, /^その時間はお受けできません。/);
    noInnerWords(r.text);
  });

  test("同じ時間に受ける人数（店の中の都合）で断るときも、人数は言わない", async () => {
    const r = await chat(ctxWith([]), [{ role: "user", text: "11/7の10:30からカットをお願いします" }]);
    assert.equal(r.holds.length, 0);
    assert.match(r.text, /^その時間はお受けできません。/);
    noInnerWords(r.text, ["埋まって", "席", "1人"]);
  });
});

describe("3. チェックあり：ルールの名前をそのまま理由にする", () => {
  test("間をあけるルールでも、伝えるにしたらルールの名前を伝える（返事の門にも当たらない）", async () => {
    const ctx = ctxWith([BUFFER_TOLD]);
    const out = runTool(ctx, "check_rules", { menu_ids: ["cut"], date: DAY, start: "11:30" });
    assert.equal(out.hidden, undefined);
    assert.equal(JSON.parse(out.content).reason, "「カラーの後は15分あける」のため、お受けできません。");
    const r = await chat(ctx, [{ role: "user", text: ASK_1130 }]);
    assert.match(r.text, /^「カラーの後は15分あける」のため、お受けできません。代わりに、1つ目：/);
    assert.ok(!r.steps.some((s) => s.text.includes("差し替えた")), "門で差し替えていない");
  });

  test("例：「縮毛矯正は15:00まで」（ルールの最終受付）を伝える／外すと伝えない", async () => {
    const own: Rule = { id: "own-ls", level: "menu", menuId: "straight", label: "縮毛矯正は15:00まで", check: { kind: "lastStart", time: "15:00" }, tellCustomer: true };
    const ask = "11/7の15:30から縮毛矯正をお願いします";
    const r = await chat(ctxWith([own], []), [{ role: "user", text: ask }]);
    assert.match(r.text, /^「縮毛矯正は15:00まで」のため、お受けできません。/);
    const { tellCustomer: _drop, ...off } = own;
    const hidden = await chat(ctxWith([off], []), [{ role: "user", text: ask }]);
    assert.match(hidden.text, /^その時間はお受けできません。/);
    assert.ok(!hidden.text.includes("15:00まで"));
  });
});

describe("4. 足した組み合わせのルール（伝える・伝えない）", () => {
  test("伝える：ルールの名前で「この組み合わせではお受けできません」（候補は出さない）", async () => {
    const r = await chat(ctxWith([PAIR_TOLD], []), [{ role: "user", text: ASK_PAIR }]);
    assert.equal(r.text, "「縮毛矯正とヘッドスパは同じ日に受けない」のため、この組み合わせではお受けできません。");
    assert.deepEqual(r.candidates, []);
    assert.equal(r.holds.length, 0);
  });

  test("伝えない：「この組み合わせではお受けできません」と、その組み合わせにならない代わり（縮毛矯正だけ・ヘッドスパだけ）", async () => {
    const ctx = ctxWith([PAIR], []);
    const cases: { text: string; model?: ReturnType<typeof sayingModel> }[] = [
      { text: ASK_PAIR },
      {
        text: "縮毛矯正とヘッドスパを11/7の10時に",
        model: sayingModel([{ name: "check_rules", input: { menu_ids: ["straight", "headspa"], date: DAY, start: "10:00" } }], "縮毛矯正とヘッドスパは同じ日に受けない決まりです。"),
      },
    ];
    for (const c of cases) {
      const r = await chat(ctx, [{ role: "user", text: c.text }], c.model);
      if (c.model) assert.equal(c.model.finals, 0, "AI は断りの文を作っていない");
      assert.ok(r.text.startsWith(`${COMBO_REFUSAL}代わりに、1つ目：`), r.text);
      noInnerWords(r.text);
      assert.ok(r.candidates && r.candidates.length >= 1);
      for (const x of r.candidates!) {
        assert.ok(x.menuId === "straight" || x.menuId === "headspa", `その組み合わせにならない代わり：${x.menuId}`);
        assert.equal(judgeSlot(ctx, x).ok, true);
      }
      assert.equal(r.holds.length, 0);
    }
  });

  test("伝えない組み合わせの代わりを選ぶと、そのメニューで仮押さえ", async () => {
    const ctx = ctxWith([PAIR], []);
    const a = await chat(ctx, [{ role: "user", text: ASK_PAIR }]);
    const shown = a.candidates!;
    const b = await chat({ ...ctx, shown }, [
      { role: "user", text: ASK_PAIR },
      { role: "assistant", text: a.text },
      { role: "user", text: "1つ目で" },
    ]);
    assert.equal(b.holds.length, 1);
    assert.equal(b.holds[0].menuId, shown[0].menuId);
  });
});

describe("5. 伝える・伝えないのルールが混ざった時も正しく分かれる", () => {
  const verdict = (base: Verdict["base"], results: Verdict["results"]): Verdict => ({
    ok: false,
    base,
    results,
    texts: [],
    situation: { tab: "reservations", menuIds: [] },
  });
  const ok = (id: string) => ({ id, label: id, ok: true, reason: "" });
  const ng = (id: string, reason = "x") => ({ id, label: id, ok: false, reason });
  const told: Rule = { id: "t1", level: "global", label: "予約は来店の3時間前まで", check: { kind: "minLeadMinutes", value: 180 }, tellCustomer: true };
  const { tellCustomer: _drop, ...toldOff } = told;

  test("人数＋伝えない間＋伝えるルール → 伝えるルールの名前だけ（間や人数の中身は入らない）", () => {
    const r = refusalOf({ menus }, verdict([ok("future"), ok("hours"), ng("seats")], [
      { rule: BUFFER, ok: false, reason: "カラーの後の15分を入れると、席が足りません" },
      { rule: told, ok: false, reason: "来店まで2時間しかありません" },
    ]));
    assert.deepEqual(r, { text: "「予約は来店の3時間前まで」のため、お受けできません。", tell: true });
  });

  test("過ぎた時刻（店の設定）＋伝えないルール → 過ぎた時刻の文", () => {
    const r = refusalOf({ menus }, verdict([ng("future")], [{ rule: toldOff, ok: false, reason: "来店まで0分" }]));
    assert.deepEqual(r, { text: "もう過ぎた時刻なので、お受けできません。", tell: true });
  });

  test("人数＋伝えないルールだけ → 「その時間はお受けできません。」だけ", () => {
    const r = refusalOf({ menus }, verdict([ng("seats")], [{ rule: BUFFER, ok: false, reason: "x" }, { rule: PAIR, ok: false, reason: "x" }]));
    assert.deepEqual(r, { text: INTERNAL_REFUSAL, tell: false });
  });

  test("会話で：伝える組み合わせと伝えない間が両方ある時、組み合わせは理由を伝え、間にかかる頼みは決まった文", async () => {
    const ctx = ctxWith([BUFFER, PAIR_TOLD]);
    const a = await chat(ctx, [{ role: "user", text: ASK_PAIR }]);
    assert.equal(a.text, "「縮毛矯正とヘッドスパは同じ日に受けない」のため、この組み合わせではお受けできません。");
    const b = await chat(ctx, [{ role: "user", text: ASK_1130 }]);
    assert.match(b.text, /^その時間はお受けできません。代わりに、/);
    noInnerWords(b.text);
  });

  test("会話で：伝える間と伝えない組み合わせ → 間は名前を伝え、組み合わせは決まった文と代わり", async () => {
    const ctx = ctxWith([BUFFER_TOLD, PAIR]);
    const a = await chat(ctx, [{ role: "user", text: ASK_1130 }]);
    assert.match(a.text, /^「カラーの後は15分あける」のため、お受けできません。/);
    const b = await chat(ctx, [{ role: "user", text: ASK_PAIR }]);
    assert.ok(b.text.startsWith(COMBO_REFUSAL), b.text);
    assert.ok(!b.text.includes(PAIR.label));
  });
});

describe("6. 店の設定の理由は今までどおり伝える（定休日・営業時間・過ぎた時刻・メニューの最終受付）", () => {
  test("定休日（火曜）", async () => {
    const r = await chat(ctxAt(now), [{ role: "user", text: "11/10の14:00からカットをお願いします" }]);
    assert.match(r.text, /^その日はお休み（定休日）なので、お受けできません。代わりに、/);
    assert.ok(r.candidates && r.candidates.length >= 1);
  });

  test("過ぎた時刻（きのう）", async () => {
    const r = await chat(ctxAt(now), [{ role: "user", text: "11/3の15:00からカットをお願いします" }]);
    assert.match(r.text, /^もう過ぎた時刻なので、お受けできません。代わりに、/);
    assert.ok(r.candidates && r.candidates.length >= 1);
  });

  test("営業時間に収まらない（閉店までに終わらない）", async () => {
    const r = await chat(ctxAt(now), [{ role: "user", text: "11/7の19:30からカットをお願いします" }]);
    assert.match(r.text, /^営業時間に収まらないので、お受けできません（閉店（20:00）までに終わりません）。/);
  });

  test("メニューの最終受付", async () => {
    const r = await chat(ctxAt(now), [{ role: "user", text: "11/7の16:30から縮毛矯正をお願いします" }]);
    assert.match(r.text, /^最終受付を過ぎるので、お受けできません（縮毛矯正の最終受付（16:00）を過ぎています）。/);
  });
});

describe("7. 返事の門（後ろの守り）", () => {
  const rules = [...ctxAt(now).rules, BUFFER, PAIR];

  test("止める：伝えないルールの文・「○分あける」の形", () => {
    for (const t of [
      "カラーの後は15分あける、という決まりがあるので難しいです。",
      "「カラーの後は 15分 あける」ため、お受けできません。",
      "前の方の後に15分の間をあけています。",
      "施術の間を15分とっています。",
      "カラーの後に１５分空けるので、その時間は難しいです。",
      "予約は来店の3時間前まで、となっております。",
      "縮毛矯正とヘッドスパは同じ日に受けないので、ご了承ください。",
    ])
      assert.ok(innerWordsHit(t, rules), t);
  });

  test("止めない：ふつうの時間の言い方・候補・店の設定の理由・伝えるルールの文", () => {
    for (const t of [
      "カットは60分です。",
      "カットとヘッドスパで90分ほどかかります。",
      "1つ目：11/7（土） 11:30–12:30 カット、2つ目：11/7（土） 14:00–15:00 カット が空いています。",
      "その日はお休み（定休日）なので、お受けできません。",
      "11/7（土） 15:00–16:00 カット を仮でお取りしました。お店から確定のご連絡をします。",
      "30分ほどお待ちいただくかもしれません。",
    ])
      assert.equal(innerWordsHit(t, rules), null, t);
    assert.equal(innerWordsHit("「カラーの後は15分あける」のため、お受けできません。", [...ctxAt(now).rules, BUFFER_TOLD]), null);
  });

  test("AI の文に当たったら、決まった文に差し替える（当たらなければそのまま）", async () => {
    const ctx = ctxWith([BUFFER], []);
    const leak = sayingModel([{ name: "find_openings", input: { menu_ids: ["cut"], date: DAY } }], "カラーの後は15分あけるので、1つ目は少し遅めです。");
    const r = await chat(ctx, [{ role: "user", text: "11/7にカット" }], leak);
    assert.ok(!r.text.includes("15分"));
    assert.match(r.text, /^1つ目：.* でお取りできます。/);
    assert.ok(r.candidates && r.candidates.length >= 1, "候補のボタンは残る");
    assert.ok(r.steps.some((s) => s.kind === "reject" && s.text.includes("差し替えた")));

    const plain = sayingModel([], "カットは60分です。ご希望の日時を教えてください。");
    const p = await chat(ctx, [{ role: "user", text: "カットは何分くらいですか" }], plain);
    assert.equal(p.text, "カットは60分です。ご希望の日時を教えてください。");
  });
});

describe("8. 言葉で足したルールも、足す時のチェックで分かれる", () => {
  const MENUS = menus.map((m) => ({ id: m.id, name: m.name }));
  /** 言葉で足す入口が埋めた欄を、足す時のチェックとともに確かめる（画面の「足す」と同じ確かめ） */
  async function fromWords(text: string, tellCustomer: boolean): Promise<Rule> {
    const out = await runRuleWords({ text, reader: scriptRuleReader(MENUS), menus: MENUS, maxTokens: 100 });
    assert.equal(out.result.status, "filled", text);
    if (out.result.status !== "filled") throw new Error(text);
    const d = out.result.draft;
    const check =
      d.kind === "notTogether" ? { kind: d.kind, with: d.with } : d.kind === "lastStart" ? { kind: d.kind, time: d.time } : { kind: d.kind, value: d.minutes ?? d.count };
    const v = validateOwnerRule({ ...d.scope, id: `w-${d.kind}-${tellCustomer}`, label: out.result.label, check, ...(tellCustomer ? { tellCustomer } : {}) }, IDS);
    if (!v.ok) throw new Error(`${text}：${v.reason}`);
    return v.value;
  }

  test("「カラーの後は15分あける」：チェックなし → 分数もルールの文も出ない／チェックあり → ルールの名前を伝える", async () => {
    const off = await fromWords("カラーの後は15分あける", false);
    const r = await chat(ctxWith([off]), [{ role: "user", text: ASK_1130 }]);
    assert.match(r.text, /^その時間はお受けできません。/);
    noInnerWords(r.text);
    const on = await fromWords("カラーの後は15分あける", true);
    const t = await chat(ctxWith([on]), [{ role: "user", text: ASK_1130 }]);
    assert.match(t.text, /^「カラーの後は15分あける」のため、お受けできません。/);
  });

  test("「縮毛矯正とヘッドスパは同じ日に受けない」：チェックなし → 決まった文と代わり／チェックあり → ルールの名前", async () => {
    const off = await fromWords("縮毛矯正とヘッドスパは同じ日に受けない", false);
    const a = await chat(ctxWith([off], []), [{ role: "user", text: ASK_PAIR }]);
    assert.ok(a.text.startsWith(COMBO_REFUSAL), a.text);
    const on = await fromWords("縮毛矯正とヘッドスパは同じ日に受けない", true);
    const b = await chat(ctxWith([on], []), [{ role: "user", text: ASK_PAIR }]);
    assert.equal(b.text, `「${on.label}」のため、この組み合わせではお受けできません。`);
  });
});
