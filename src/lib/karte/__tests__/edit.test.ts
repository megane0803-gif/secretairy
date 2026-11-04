// カルテを人が直す・お客様一覧のテスト。Claude は呼ばない（決まった返事 scriptKarteWriter）。
// 3. 保存の前に案を見出しごとに直す（印・元に戻す・人の行は門を通さない）
// 追加：保存したカルテも後から直す（印・日時・ToDo の文だけ書きかえ・済みは触らない）・お客様一覧（名字の部分一致・50音の行）

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { emptyBook, parseBook, withTodoDone, type BookState } from "../../book/state";
import { getCustomers, getKarteExamples } from "../../data/seed";
import { getAiSettings, getKarteEditSettings, getKarteHeadings } from "../../settings";
import { getRules } from "../../rules/store";
import { karteKey, todoKey } from "../../todo/keys";
import { filterCustomers, kanaRowOf, toHiragana } from "../customers";
import { editedLabels, humanLines, isEdited, sectionsToSave, withHumanEdit, withReverted, withSavedKarteEdited } from "../edit";
import type { DeskDraft } from "../deskStore";
import { emptySections } from "../format";
import { withKarteSaved, type SavedKarte } from "../record";
import { runKarte } from "../run";
import { scriptKarteWriter } from "../writer";

const headings = getKarteHeadings();
const limits = getKarteEditSettings();
const ai = getAiSettings();
const examples = getKarteExamples();

async function draftOf(memo: string) {
  const d = await runKarte({ memo, mode: "script", writer: scriptKarteWriter(examples, headings), headings, rules: getRules(), maxTokens: ai.karte.maxReplyTokens });
  const draft: DeskDraft = { ...d, memo };
  return draft;
}

describe("3. 保存の前に、人が見出しごとに直す", () => {
  test("上限は config（config/karte.json の edit）。人の文は1行ずつ・頭の「・」を外す", () => {
    assert.ok(limits.maxLines > 0 && limits.maxLineChars > 0);
    assert.deepEqual(humanLines("・一つ目\n\n  ・二つ目  \n", limits), ["一つ目", "二つ目"]);
    assert.equal(humanLines(Array.from({ length: limits.maxLines + 5 }, (_, i) => `行${i}`).join("\n"), limits).length, limits.maxLines);
    assert.equal([...humanLines("あ".repeat(limits.maxLineChars + 10), limits)[0]].length, limits.maxLineChars);
  });

  test("直した見出しに印・AI の案は残す。「元に戻す」で AI の案に戻る。同じ中身に直したら印を外す", async () => {
    const d = await draftOf(examples[0].memo);
    const ai0 = d.sections.treatment;
    const e1 = withHumanEdit(d, "treatment", "根元のリタッチ（人が書いた）", limits);
    assert.ok(isEdited(e1, "treatment"));
    assert.deepEqual(e1.sections.treatment, ["根元のリタッチ（人が書いた）"]);
    assert.deepEqual(e1.aiSections!.treatment, ai0);
    assert.deepEqual(editedLabels(e1, headings), ["施術内容"]);
    const back = withReverted(e1, "treatment");
    assert.ok(!isEdited(back, "treatment"));
    assert.deepEqual(back.sections.treatment, ai0);
    const same = withHumanEdit(e1, "treatment", ai0.join("\n"), limits);
    assert.ok(!isEdited(same, "treatment"));
  });

  test("🔒 人が書いた行は言葉の門を通さない。直していない AI の行は保存の前にもう一度門を通す", async () => {
    const d = await draftOf("カットした。仕上がりに喜んでいた");
    // AI の行に、メモに無い言葉がまぎれた（ブラウザの中で書きかえられた、のつもり）
    const sneaky = { ...d, sections: { ...d.sections, finish: [...d.sections.finish, "頭皮の改善におすすめ"] } };
    const human = withHumanEdit(sneaky, "notes", "頭皮が少し赤い（お客様の言葉）。受診はお客様が決める", limits);
    const out = sectionsToSave(human, human.memo, headings);
    assert.deepEqual(out.sections.notes, ["頭皮が少し赤い（お客様の言葉）。受診はお客様が決める"], "人の行は残る");
    assert.ok(!out.sections.finish.includes("頭皮の改善におすすめ"), "AI の行は門で外す");
    assert.ok(out.removed.some((r) => r.line === "頭皮の改善におすすめ"));
    assert.deepEqual(out.edited, ["notes"]);
  });

  test("直した次回提案で ToDo「次回話すこと」を足す（保存は今までどおり人のボタン）", async () => {
    const d = withHumanEdit(await draftOf(examples[0].memo), "next", "次は暗めのカラー（人が直した）", limits);
    const { sections, edited } = sectionsToSave(d, d.memo, headings);
    const k: SavedKarte = { id: "k-1", customerId: "c01", date: "2026-11-04", menuId: "cut", memo: d.memo, sections, savedAt: "2026-11-04T05:00:00.000Z", edited };
    const out = withKarteSaved(emptyBook("2026-11-04"), k, "青木", headings);
    assert.ok(out.ok && out.todo);
    if (out.ok) assert.equal(out.todo!.title, "青木（架空）様：次は暗めのカラー（人が直した）");
  });
});

describe("保存したカルテを後から直す", () => {
  const nowIso = "2026-11-05T03:00:00.000Z";
  function saved(): { state: BookState; k: SavedKarte } {
    const sections = { ...emptySections(headings), next: ["次は暗めのカラー"], treatment: ["カット"] };
    const k: SavedKarte = { id: "k-a", customerId: "c01", date: "2026-11-04", menuId: "cut", memo: "カット", sections, savedAt: "2026-11-04T05:00:00.000Z" };
    const out = withKarteSaved(emptyBook("2026-11-04"), k, "青木", headings);
    assert.ok(out.ok);
    return { state: out.state, k };
  }
  const o = { limits, headings, surname: "青木", nowIso };

  test("直した見出しに印と日時（人が直した）を残す。門は通さない", () => {
    const { state } = saved();
    const r = withSavedKarteEdited(state, "k-a", "notes", "頭皮がしみると話していた", o);
    assert.ok(r.ok && r.changed);
    const k = r.state.kartes[0];
    assert.deepEqual(k.sections.notes, ["頭皮がしみると話していた"]);
    assert.deepEqual(k.edited, ["notes"]);
    assert.equal(k.editedAt!.notes, nowIso);
    // ブラウザに残して読みなおしても印と日時は消えない
    const back = parseBook(JSON.stringify(r.state))!;
    assert.deepEqual(back.kartes[0].edited, ["notes"]);
    assert.equal(back.kartes[0].editedAt!.notes, nowIso);
  });

  test("次回提案を直すと、同じ鍵（カルテ:番号）の ToDo の文だけ書きかえる（足さない）", () => {
    const { state } = saved();
    const before = state.todos.filter((t) => todoKey(t) === karteKey("k-a"));
    assert.equal(before.length, 1);
    const r = withSavedKarteEdited(state, "k-a", "next", "次は明るめのカラー\nトリートメントの話", o);
    assert.ok(r.ok && r.todo === "updated");
    const after = r.state.todos.filter((t) => todoKey(t) === karteKey("k-a"));
    assert.equal(after.length, 1, "足さない");
    assert.equal(after[0].id, before[0].id);
    assert.equal(after[0].title, "青木（架空）様：次は明るめのカラー（ほか1行はカルテに）");
    assert.equal(r.state.todos.length, state.todos.length);
  });

  test("済みの ToDo は触らない。ToDo が無ければ足さない", () => {
    const { state } = saved();
    const t = state.todos[0];
    const done = withTodoDone(state, t.id, true, nowIso);
    const r = withSavedKarteEdited(done, "k-a", "next", "次はパーマ", o);
    assert.ok(r.ok && r.todo === "done");
    assert.equal(r.state.todos[0].title, t.title);
    const none = withSavedKarteEdited({ ...state, todos: [] }, "k-a", "next", "次はパーマ", o);
    assert.ok(none.ok && none.todo === "none");
    assert.equal(none.state.todos.length, 0);
  });

  test("同じ中身なら何もしない。最初の状態のカルテ（保存していない物）は直せない", () => {
    const { state } = saved();
    const same = withSavedKarteEdited(state, "k-a", "treatment", "カット", o);
    assert.ok(same.ok && !same.changed);
    assert.equal(same.state, state);
    const seed = withSavedKarteEdited(state, "k-p01", "treatment", "x", o);
    assert.ok(!seed.ok);
  });

  test("「最初に戻す」（今日を起点に作り直す）で、直したカルテも最初の状態に戻る", () => {
    const { state } = saved();
    const r = withSavedKarteEdited(state, "k-a", "notes", "x", o);
    assert.ok(r.ok);
    const reset = emptyBook("2026-11-05");
    assert.equal(reset.kartes.length, 0);
    assert.equal(reset.todos.length, 0);
  });
});

describe("お客様一覧：名字で探す・50音の行で絞る", () => {
  const customers = getCustomers();
  test("全員にひらがなのよみがあり、みな架空", () => {
    assert.equal(customers.length, 10);
    for (const c of customers) {
      assert.equal(c.fictional, true);
      assert.ok(c.kana && /^[ぁ-ゖー]+$/.test(c.kana), c.surname);
    }
  });

  test("名字の部分一致（よみ・カタカナでも）", () => {
    assert.deepEqual(filterCustomers(customers, "青", null).map((c) => c.surname), ["青木"]);
    assert.deepEqual(filterCustomers(customers, "田", null).map((c) => c.surname), ["石田"]);
    assert.deepEqual(filterCustomers(customers, "コバ", null).map((c) => c.surname), ["小林"]);
    assert.equal(filterCustomers(customers, "", null).length, customers.length);
    assert.equal(filterCustomers(customers, "山", null).length, 0);
    assert.equal(toHiragana("ｱｵｷ"), "あおき");
  });

  test("50音の行：あ行・か行・さ行（よみの1文字目）。名字といっしょにも絞れる", () => {
    assert.deepEqual(filterCustomers(customers, "", "a").map((c) => c.surname), ["青木", "石田", "上野", "江口", "大橋"]);
    assert.deepEqual(filterCustomers(customers, "", "ka").map((c) => c.surname), ["加藤", "木村", "久保", "小林"]);
    assert.deepEqual(filterCustomers(customers, "", "sa").map((c) => c.surname), ["佐野"]);
    assert.equal(filterCustomers(customers, "", "ta").length, 0);
    assert.deepEqual(filterCustomers(customers, "木", "ka").map((c) => c.surname), ["木村"]);
    assert.equal(kanaRowOf("ぱんだ"), "ha");
    assert.equal(kanaRowOf(undefined), null);
  });
});
