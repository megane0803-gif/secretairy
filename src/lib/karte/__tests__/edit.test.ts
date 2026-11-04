// カルテを人が直す・お客様一覧のテスト。Claude は呼ばない（決まった返事 scriptKarteWriter）。
// 3. 保存の前に案を見出しごとに直す（印・元に戻す・人の行は門を通さない）
// 追加：保存したカルテも後から直す（印・日時・ToDo の文だけ書きかえ・済みは触らない）・お客様一覧（名字の部分一致・50音の行）

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { emptyBook, parseBook, withTodoDone, type BookState } from "../../book/state";
import { getCustomers, getKarteExamples, getSeedKartes, getTodos } from "../../data/seed";
import { at, menus, shop } from "../../ai/__tests__/helpers";
import { shopToday } from "../../calendar";
import { loadBook } from "../../reservations";
import { resolveSeedTodos, todoItems, withTodoMarked } from "../../todo/items";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAiSettings, getKarteEditSettings, getKarteHeadings } from "../../settings";
import { getRules } from "../../rules/store";
import { karteKey, todoKey } from "../../todo/keys";
import { filterCustomers, kanaRowOf, toHiragana } from "../customers";
import { editedLabels, humanLines, isEdited, sectionsToSave, withHumanEdit, withKarteEdited, withReverted, withSavedKarteEdited } from "../edit";
import type { DeskDraft } from "../deskStore";
import { cleanSections, emptySections, MAX_LINE_CHARS, MAX_LINES_PER_HEADING } from "../format";
import { resolveSeedKartes, withKarteSaved, withSeedKarteEdits, type SavedKarte } from "../record";
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

  test("同じ中身なら何もしない。保存したカルテの入口（withSavedKarteEdited）は、保存していない id を受けない（最初の状態の物は withKarteEdited から）", () => {
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

describe("最初の状態のカルテも、保存したカルテと同じように直す", () => {
  const nowIso = "2026-11-05T03:00:00.000Z";
  const o = { limits, headings, surname: "江口", nowIso };
  const now = at("2026-11-04", "09:00");
  const { today } = shopToday(shop, now);
  const all = loadBook(shop, menus, today).all;
  const seedList = () => resolveSeedKartes(getSeedKartes(), all);
  /** 画面と同じ：最初の状態に、直した分を重ねて読む */
  const view = (s: BookState) => withSeedKarteEdits(seedList(), s.seedKarteEdits);
  const p01 = (s: BookState) => view(s).find((k) => k.id === "k-p01")!;
  const seedTodo = getTodos().find((t) => t.key === "例:カルテ:k-p01")!;
  const items = (s: BookState) => todoItems(resolveSeedTodos(shop, today, getTodos()), s, shop);

  test("直した見出しは差しかわり、印と日時が付く。ほかの見出し・ほかのカルテは最初のまま。門は通さない", () => {
    const s0 = emptyBook(today.date);
    const before = p01(s0);
    assert.equal(before.source, "seed");
    const r = withKarteEdited(s0, before, "notes", "頭皮がしみると話していた（人が書いた）", o);
    assert.ok(r.ok && r.changed && r.todo === null);
    const k = p01(r.state);
    assert.deepEqual(k.sections.notes, ["頭皮がしみると話していた（人が書いた）"]);
    assert.deepEqual(k.sections.condition, before.sections.condition);
    assert.deepEqual(k.edited, ["notes"]);
    assert.equal(k.editedAt!.notes, nowIso);
    // ほかのカルテには付かない
    assert.ok(view(r.state).filter((x) => x.id !== "k-p01").every((x) => !x.edited));
    // 同じ中身なら何もしない
    const same = withKarteEdited(r.state, k, "notes", "頭皮がしみると話していた（人が書いた）", o);
    assert.ok(same.ok && !same.changed);
    // 2つ目の見出しを直しても前の印は残る
    const r2 = withKarteEdited(r.state, k, "talk", "旅行の話", { ...o, nowIso: "2026-11-05T04:00:00.000Z" });
    assert.ok(r2.ok);
    assert.deepEqual(p01(r2.state).edited, ["notes", "talk"]);
    assert.equal(p01(r2.state).editedAt!.notes, nowIso);
  });

  test("ブラウザに残して読みなおしても、直した分・印・日時は消えない（形のおかしい物は落とす）", () => {
    const r = withKarteEdited(emptyBook(today.date), p01(emptyBook(today.date)), "notes", "x", o);
    assert.ok(r.ok);
    const back = parseBook(JSON.stringify(r.state))!;
    assert.deepEqual(p01(back).sections.notes, ["x"]);
    assert.equal(p01(back).editedAt!.notes, nowIso);
    const bad = parseBook(JSON.stringify({ ...r.state, seedKarteEdits: { "k-p01": "おかしい" }, todoTitles: { "ts-08": 3 } }))!;
    assert.equal(bad.seedKarteEdits, undefined);
    assert.equal(bad.todoTitles, undefined);
  });

  test("次回提案を直すと、同じ鍵（例:カルテ:番号）の最初の状態の ToDo の文だけ書きかえる（足さない）", () => {
    const s0 = emptyBook(today.date);
    const countBefore = items(s0).length;
    const r = withKarteEdited(s0, p01(s0), "next", "次は明るめのカラー\n前髪も相談", o);
    assert.ok(r.ok && r.todo === "updated");
    assert.equal(r.title, "江口（架空）様：次は明るめのカラー（ほか1行はカルテに）");
    const list = items(r.state);
    assert.equal(list.length, countBefore, "足さない");
    const t = list.filter((x) => x.key === "例:カルテ:k-p01");
    assert.equal(t.length, 1);
    assert.equal(t[0].id, seedTodo.id);
    assert.equal(t[0].title, "江口（架空）様：次は明るめのカラー（ほか1行はカルテに）");
    assert.equal(r.state.todos.length, 0, "足した ToDo は増えない");
  });

  test("済みの ToDo は触らない（最初から済み・人が済みにした物）", () => {
    const s0 = emptyBook(today.date);
    // 人が済みにした
    const marked = withTodoMarked(s0, { id: seedTodo.id, seed: true }, true, nowIso);
    const r = withKarteEdited(marked, p01(marked), "next", "次はパーマ", o);
    assert.ok(r.ok && r.todo === "done");
    assert.equal(items(r.state).find((x) => x.id === seedTodo.id)!.title, seedTodo.title);
    // 最初から済み（石田様 k-p04 → ts-11）
    const k04 = view(s0).find((k) => k.id === "k-p04")!;
    const r4 = withKarteEdited(s0, k04, "next", "次はパーマ", { ...o, surname: "石田" });
    assert.ok(r4.ok && r4.todo === "done");
    assert.deepEqual(r4.state.todoTitles ?? {}, {});
  });

  test("「最初に戻す」で、直した最初の状態のカルテと ToDo の文は最初の中身に戻る", () => {
    const s0 = emptyBook(today.date);
    const r = withKarteEdited(s0, p01(s0), "next", "次はパーマ", o);
    assert.ok(r.ok);
    // 最初に戻す（reset.ts）は今日を起点に emptyBook を書く
    const reset = emptyBook(today.date);
    assert.equal(reset.seedKarteEdits, undefined);
    assert.equal(reset.todoTitles, undefined);
    assert.deepEqual(p01(reset).sections.next, p01(s0).sections.next);
    assert.equal(p01(reset).edited, undefined);
    assert.equal(items(reset).find((x) => x.id === seedTodo.id)!.title, seedTodo.title);
  });

  test("画面：どのカルテも同じ「直す」（最初の状態のカルテを見るだけにしない）", () => {
    const body = readFileSync(join(__dirname, "../../../app/karte/KarteRecordBody.tsx"), "utf8");
    assert.doesNotMatch(body, /source !== "saved"/);
    assert.match(readFileSync(join(__dirname, "../../../app/karte/KarteDraftEditor.tsx"), "utf8"), /withKarteEdited\(/);
  });
});

describe("レビューの指摘の直し", () => {
  test("人が直す上限は、カルテを出す・保存するときの上限と同じ（打った行が黙って消えない）", () => {
    assert.equal(limits.maxLines, MAX_LINES_PER_HEADING);
    assert.equal(limits.maxLineChars, MAX_LINE_CHARS);
    const text = Array.from({ length: limits.maxLines }, (_, i) => `行${i + 1}`).join("\n");
    const d: DeskDraft = { mode: "script", sections: emptySections(headings), removed: [], cut: false, memo: "x" };
    const out = sectionsToSave(withHumanEdit(d, "talk", text, limits), "x", headings);
    assert.equal(out.sections.talk.length, limits.maxLines);
    assert.equal(cleanSections(out.sections, headings).talk.length, limits.maxLines, "出すときにも消えない");
  });

  test("直す欄はカルテごと（別の方のカルテに切りかえたら、開いた欄・打ちかけの文を持ちこさない）", () => {
    const body = readFileSync(join(__dirname, "../../../app/karte/KarteRecordBody.tsx"), "utf8");
    assert.match(body, /<SavedKarteEditor[\s\S]*?key=\{karte\.id\}/);
    const board = readFileSync(join(__dirname, "../../../app/karte/KarteBoard.tsx"), "utf8");
    assert.match(board, /<KarteDraftEditor\s+key=\{key!\}/);
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
