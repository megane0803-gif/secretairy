// カルテ自動作成：例文3つ → 決まった返事（Claude は呼ばない）→ 見出しに分ける → 言葉の門 → 保存 → ToDo。
// 「前と同じで」が、保存したカルテのメニューで候補を出すこと。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NoAiError } from "../../ai/model";
import { judgeSlot } from "../../ai/slots";
import { at, chat, ctxAt, shop, menus } from "../../ai/__tests__/helpers";
import { emptyBook } from "../../book/state";
import { demoClock, shopToday } from "../../calendar";
import { getKarteExamples, getSeedKartes, getSeedReservations } from "../../data/seed";
import { loadBook } from "../../reservations";
import { getRules } from "../../rules/store";
import { KARTE_GATE_WORDS } from "../../rules/locked";
import { getAiSettings, getKarteHeadings } from "../../settings";
import { parseDraft } from "../format";
import { gateLine } from "../gate";
import { allKartes, kartesOf, resolveSeedKartes, withKarteSaved, type SavedKarte } from "../record";
import { parseKarteRequest } from "../request";
import { runKarte } from "../run";
import { claudeKarteWriter, scriptKarteWriter, type KarteWriter } from "../writer";

const headings = getKarteHeadings();
const examples = getKarteExamples();
const ai = getAiSettings();
const script = scriptKarteWriter(examples, headings);
const ids = headings.map((h) => h.id);

function make(memo: string, writer: KarteWriter = script) {
  return runKarte({ memo, mode: "script", writer, headings, rules: getRules(), maxTokens: ai.karte.maxReplyTokens });
}
const exampleOf = (customerId: string) => examples.find((e) => e.customerId === customerId)!;
const emptyOf = (sections: Record<string, string[]>) => ids.filter((id) => sections[id].length === 0);

describe("設定と例文", () => {
  test("🔒 言葉の門の言葉は減らさない（頭皮・肌・病・受診・おすすめ・改善 など）", () => {
    for (const w of ["頭皮", "肌", "病", "受診", "薬", "おすすめ", "改善", "大丈夫"]) assert.ok(KARTE_GATE_WORDS.includes(w), w);
  });

  test("見出しは8つ（設定に持つ）。次回提案に役目の札", () => {
    assert.deepEqual(
      headings.map((h) => h.label),
      ["来店時の状態", "お客様のご希望", "施術内容", "薬剤・設定", "仕上がり", "次回提案", "注意点・申し送り", "会話メモ"],
    );
    assert.equal(headings.find((h) => h.role === "next")?.label, "次回提案");
  });

  test("例文は今日のお客様1人に1つ。1つに「頭皮が赤かった」", () => {
    const todays = getSeedReservations().filter((r) => r.day === 0).map((r) => r.customerId).sort();
    assert.deepEqual(examples.map((e) => e.customerId).sort(), todays);
    assert.equal(examples.filter((e) => e.memo.includes("頭皮が赤かった")).length, 1);
    for (const e of examples) assert.ok([...e.memo].length <= ai.karte.maxMemoChars);
  });

  test("前回までのカルテは8見出しとも書いてあり、日付とメニューは予約の「前回」とそろう", () => {
    const { today } = shopToday(shop, at("2026-11-04", "10:00"));
    const all = loadBook(shop, menus, today).all;
    const resolved = resolveSeedKartes(getSeedKartes(), all);
    assert.equal(resolved.length, getSeedKartes().length, "どのカルテにも予約（前回）がある");
    for (const k of resolved) {
      const r = all.find((x) => x.id === k.reservationId)!;
      assert.ok(r.date < today.date, "前回（今日より前）の予約");
      assert.equal(k.date, r.date);
      assert.equal(k.menuId, r.menu.id);
      assert.deepEqual(emptyOf({ ...Object.fromEntries(ids.map((id) => [id, []])), ...k.sections }), [], `${k.id} は8見出しとも`);
    }
  });
});

describe("例文3つでカルテにする（決まった返事・Claude は呼ばない）", () => {
  test("青木（カット）：メモに無い見出し（薬剤・設定／注意点・申し送り）は空のまま。外す行は無い", async () => {
    const d = await make(exampleOf("c01").memo);
    assert.deepEqual(emptyOf(d.sections), ["chemicals", "notes"]);
    assert.equal(d.removed.length, 0);
    assert.ok(!Object.values(d.sections).flat().some((l) => l.includes("以上")), "見出しの外の行は使わない");
  });

  test("石田（カラー）：「頭皮が赤かった」は残し、おすすめの1行だけ外す", async () => {
    const d = await make(exampleOf("c02").memo);
    assert.deepEqual(emptyOf(d.sections), []);
    assert.ok(d.sections.notes.some((l) => l.includes("頭皮が赤かった")), "記録として残す");
    assert.equal(d.removed.length, 1, "外すのは1行だけ");
    assert.equal(d.removed[0].headingId, "notes");
    assert.match(d.removed[0].line, /おすすめ/);
    assert.match(d.removed[0].reason, /「おすすめ」/);
    assert.ok(!Object.values(d.sections).flat().some((l) => /おすすめ|赤み|刺激/.test(l)));
  });

  test("上野（縮毛矯正）：メモに無い数字の1行だけ外す", async () => {
    const d = await make(exampleOf("c03").memo);
    assert.equal(d.removed.length, 1);
    assert.equal(d.removed[0].line, "アイロンは2回通し");
    assert.match(d.removed[0].reason, /「2」はメモに無い数字/);
    assert.deepEqual(d.sections.chemicals, ["アイロン180度"]);
    assert.equal(d.sections.next.length, 2);
  });

  test("残った行は、どれも言葉の門を通る（メモに無い言葉・数字を足していない）", async () => {
    for (const e of examples) {
      const d = await make(e.memo);
      for (const l of Object.values(d.sections).flat()) assert.equal(gateLine(l, e.memo), null, l);
    }
  });

  test("例文でないメモも、決まった返事で見出しに分ける（無い見出しは空）", async () => {
    const d = await make("今日はヘッドスパです。次回は1か月後。最近よく眠れないって話。");
    assert.deepEqual(d.sections.treatment, ["今日はヘッドスパです"]);
    assert.deepEqual(d.sections.next, ["次回は1か月後"]);
    assert.ok(emptyOf(d.sections).includes("chemicals"));
  });
});

describe("見出しに分ける・言葉の門", () => {
  test("知らない見出し・見出しの外の行・「メモに無し」は使わない", () => {
    const { sections, ignored } = parseDraft(
      "はじめに\n■ 施術内容\n・カット\n・メモに無し\n■ 写真\n・顔の写真\n■次回提案\n・（なし）\n■ 会話メモ\nまとめの文",
      headings,
    );
    assert.deepEqual(sections.treatment, ["カット"]);
    assert.deepEqual(sections.next, []);
    assert.deepEqual(sections.talk, []);
    assert.ok(ignored.includes("・顔の写真"));
  });

  test("メモに無い言葉・数字の行は外す。メモにあれば残す", () => {
    const memo = "シャンプーの時に頭皮が赤かった。放置は２０分。１０：００に来店。";
    assert.equal(gateLine("頭皮が赤かった", memo), null);
    assert.equal(gateLine("放置20分", memo), null, "全角の数字も同じ数");
    assert.equal(gateLine("10:00に来店", memo), null, "時刻の書き方の違いは同じ");
    assert.match(gateLine("頭皮のために受診を", memo)!, /「受診」/);
    assert.match(gateLine("肌が荒れていた", memo)!, /「肌」「荒れ」/);
    assert.match(gateLine("改善に効果あり", memo)!, /「改善」「効果」/);
    assert.match(gateLine("放置25分", memo)!, /「25」/);
    assert.match(gateLine("このカラーなら大丈夫", memo)!, /「大丈夫」/);
  });

  test("長さの上限で切れたら、最後の1行は使わない", async () => {
    const cutWriter: KarteWriter = { async write() { return { text: "■ 施術内容\n・カット\n・すきバサ", stop: "max_tokens" }; } };
    const d = await make("カット。すきバサミ。", cutWriter);
    assert.equal(d.cut, true);
    assert.deepEqual(d.sections.treatment, ["カット"]);
  });
});

describe("保存（人のボタン）", () => {
  const today = "2026-11-04";
  const draftFor = async (customerId: string) => (await make(exampleOf(customerId).memo)).sections;
  const saved = async (customerId: string, date = today, menuId = "cut"): Promise<SavedKarte> => ({
    id: `k-${date}-${customerId}`,
    customerId,
    date,
    menuId,
    memo: exampleOf(customerId).memo,
    sections: await draftFor(customerId),
    savedAt: `${date}T09:00:00.000Z`,
  });

  test("保存で ToDo「次回話すこと」が1件だけ増える（次回提案の1行目・ほかN行はカルテに）", async () => {
    const s0 = emptyBook(today);
    const out = withKarteSaved(s0, await saved("c03", today, "straight"), "上野", headings);
    assert.ok(out.ok);
    assert.equal(out.state.kartes.length, 1);
    assert.equal(out.state.todos.length, s0.todos.length + 1);
    assert.equal(out.state.todos[0].kind, "next-talk");
    assert.equal(out.state.todos[0].title, "上野（架空）様：半年後ごろ、伸びた根元だけ（ほか1行はカルテに）");
  });

  test("次回提案が1行なら「ほか」は付けない", async () => {
    const out = withKarteSaved(emptyBook(today), await saved("c01"), "青木", headings);
    assert.ok(out.ok);
    assert.equal(out.state.todos[0].title, "青木（架空）様：2か月後ごろ、前髪だけのカット");
  });

  test("同じ日にもう一度は保存しない（その日はもう直さない）", async () => {
    const a = withKarteSaved(emptyBook(today), await saved("c01"), "青木", headings);
    assert.ok(a.ok);
    const b = withKarteSaved(a.state, { ...(await saved("c01")), id: "other" }, "青木", headings);
    assert.equal(b.ok, false);
    assert.equal(b.state.kartes.length, 1);
    assert.equal(b.state.todos.length, 1);
  });

  test("同じ ToDo があれば足さない", async () => {
    const a = withKarteSaved(emptyBook(today), await saved("c01"), "青木", headings);
    assert.ok(a.ok);
    const b = withKarteSaved(a.state, await saved("c01", "2026-11-05"), "青木", headings);
    assert.ok(b.ok);
    assert.equal(b.state.kartes.length, 2);
    assert.equal(b.state.todos.length, 1);
    assert.equal(b.todoSkipped, "same");
  });

  test("前回までのカルテは新しい順", async () => {
    const now = at("2026-11-04", "10:00");
    const { today: t } = shopToday(shop, now);
    const seed = resolveSeedKartes(getSeedKartes(), loadBook(shop, menus, t).all);
    const list = kartesOf(allKartes(seed, [await saved("c01", t.date)]), "c01");
    assert.deepEqual(list.map((k) => k.source), ["saved", "seed"]);
    assert.ok(list[0].date > list[1].date);
  });
});

describe("「前と同じで」は保存したカルテのメニューで", () => {
  const now = at("2026-11-04", "10:00");

  test("カルテの無い方は「前回の記録なし」", async () => {
    const r = await chat(ctxAt(now, {}, "c03"), [{ role: "user", text: "前と同じでお願いします" }]);
    assert.ok(r.steps.some((s) => s.text.includes("前回の記録なし")));
    assert.deepEqual(r.candidates, [], "候補は出さない（ボタンも出ない）");
    assert.match(r.text, /前回の記録なし/);
  });

  test("保存したカルテ（縮毛矯正）のメニューで、所要時間とルールを判定して候補を出す", async () => {
    const k: SavedKarte = {
      id: "k1", customerId: "c03", date: "2026-11-04", menuId: "straight", memo: exampleOf("c03").memo,
      sections: (await make(exampleOf("c03").memo)).sections, savedAt: "2026-11-04T08:00:00.000Z",
    };
    const ctx = ctxAt(now, {}, "c03", [k]);
    const r = await chat(ctx, [{ role: "user", text: "前と同じでお願いします" }]);
    assert.ok(r.steps.some((s) => s.text.startsWith("前回を見る") && s.text.includes("縮毛矯正") && s.text.includes("180分")));
    assert.ok(r.candidates && r.candidates.length >= 1);
    for (const c of r.candidates!) {
      assert.equal(c.menuId, "straight");
      assert.equal(judgeSlot(ctx, c).ok, true, "縮毛矯正の所要時間とルール（24時間前まで）を通っている");
      assert.ok(`${c.date}T${c.start}` >= "2026-11-05T10:00", "24時間前までのルールが効いている");
    }
  });

  test("最初の状態より新しいカルテがあれば、そのメニュー", async () => {
    const k: SavedKarte = {
      id: "k2", customerId: "c04", date: "2026-11-04", menuId: "perm", memo: "パーマ",
      sections: {}, savedAt: "2026-11-04T08:00:00.000Z",
    };
    const r = await chat(ctxAt(now, {}, "c04", [k]), [{ role: "user", text: "前と同じで" }]);
    assert.ok(r.candidates?.every((c) => c.menuId === "perm"));
  });
});

describe("AI につながらないとき・送られた物の確かめ", () => {
  test("鍵が無ければ「AI につながらない」（ほかは動く）", () => {
    assert.throws(() => claudeKarteWriter(ai.karte.model, ""), NoAiError);
  });

  test("1回の返事の長さに上限がある（config/ai.json）", () => {
    assert.ok(ai.karte.maxReplyTokens > 0 && ai.karte.maxReplyTokens <= 4000);
    assert.match(ai.karte.model, /haiku/);
  });

  test("メモは1,500字まで。空も断る。鍵つきのルールはいつも先頭", () => {
    const ok = parseKarteRequest({ memo: "カット", rules: [] }, 1500, ["cut"]);
    assert.ok(ok.ok && ok.value.rules.filter((r) => r.locked).length === 2);
    assert.equal(parseKarteRequest({ memo: "あ".repeat(1501), rules: [] }, 1500, []).ok, false);
    assert.equal(parseKarteRequest({ memo: "  ", rules: [] }, 1500, []).ok, false);
  });
});

describe("翌日へ（デモ）", () => {
  test("1営業日先へ。定休日（火曜）は飛ばし、開店前の時刻にする", () => {
    const c = demoClock(shop, at("2026-11-02", "15:00"), 1); // 月曜
    assert.equal(c.today.date, "2026-11-04");
    assert.equal(c.now.date, "2026-11-04");
    assert.equal(c.now.time, "09:00");
    assert.equal(demoClock(shop, at("2026-11-02", "15:00"), 0).today.date, "2026-11-02");
  });
});
