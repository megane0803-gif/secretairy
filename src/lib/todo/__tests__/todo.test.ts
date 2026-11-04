// ToDo のテスト（docs/SPEC.md §1.10）。Claude は呼ばず、決まった返事（scriptTodoWriter）か、決まった文を返す書き手に置きかえる。
// 1. 並べ方  2. 同じ鍵を足さない  3. 今やる3件  4. 済みと戻す  5. 最初に戻す  6. メモを投げる（門・上限）  7. 架空の例

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import aiJson from "../../../../config/ai.json";
import todoJson from "../../../../config/todo.json";
import { EMPTY_ADS } from "../../ads/state";
import { approveAd, withProposal } from "../../ads/state";
import type { HoldOffer } from "../../ai/wire";
import { emptyBook, parseBook, pendingApprovals, withApproved, withChatTodo, withHold, withReleased, withTodo, type AddedTodo, type BookState } from "../../book/state";
import { BOOK_KEY, readBrowser, writeBrowser } from "../../browser";
import { calDay } from "../../calendar";
import { getCustomers, getTodos } from "../../data/seed";
import { withKarteSaved, type SavedKarte } from "../../karte/record";
import { applyAsk } from "../../line/apply";
import { resetAll, resetAllWrites } from "../../reset";
import { getAdSettings, getKarteHeadings, getShop, getTodoAiSettings, getTodoLimits } from "../../settings";
import type { Reservation } from "../../reservations";
import { fullSlotTodos, slotFull } from "../full";
import {
  doneTodos,
  dueLabel,
  nextMemoNo,
  resolveSeedTodos,
  sortTodos,
  todayTodoCount,
  todoGroup,
  todoItems,
  todoTabs,
  topTodos,
  weekEnd,
  withMemoTodo,
  withTodoMarked,
  type TodoItem,
} from "../items";
import { adKey, karteKey, lineKey, memoKey, reserveKey, SEED_TODO_KEYS, todoKey } from "../keys";
import { restoreNames, maskNames } from "../names";
import { cleanTitle, gateTitle, runTodo, TodoRefusedError } from "../run";
import { parseTodoRequest } from "../wire";
import { programTitle, scriptTodoWriter, type TodoWriter } from "../writer";

const shop = getShop();
const today = "2026-11-04"; // 水曜
const anchor = calDay(shop, today);
const now = "2026-11-04T01:00:00.000Z";
const seedItems = resolveSeedTodos(shop, anchor, getTodos());
const limits = getTodoAiSettings();

const item = (id: string, over: Partial<TodoItem>): TodoItem => ({
  id,
  key: `k-${id}`,
  title: id,
  source: "line",
  createdAt: "2026-11-01T00:00:00.000Z",
  done: false,
  seed: false,
  ...over,
});

const hold = (id: string, over: Partial<HoldOffer> = {}): HoldOffer => ({
  id,
  customerId: "c04",
  menuId: "cut",
  date: "2026-11-06",
  start: "15:00",
  heldAt: "2026-11-04T00:00:00.000Z",
  expiresAt: "2026-11-05T01:00:00.000Z",
  reason: "お客様が候補から選びました",
  ...over,
});

/** 決まった文を返す書き手（Claude の代わり） */
const fixedWriter = (text: string, stop: "end" | "max_tokens" | "refusal" = "end"): TodoWriter => ({ write: async () => ({ text, stop }) });

describe("1. 並べ方（プログラムが並べる）", () => {
  const list = [
    item("none", { source: "line" }),
    item("memo", { source: "memo", memo: "元" }),
    item("next", { source: "karte" }),
    item("later", { source: "ad", due: "2026-11-16" }),
    item("week", { source: "ad", due: "2026-11-08" }),
    item("today", { source: "ad", due: today }),
    item("overdue", { source: "ad", due: "2026-11-02" }),
    item("contact", { source: "reserve", due: today }),
    item("contact-chat", { source: "chat", due: today, createdAt: "2026-11-03T00:00:00.000Z" }),
    item("done", { source: "memo", done: true, doneAt: now }),
  ];

  test("上から：お客様への連絡（今日中）→ 過ぎている → 今日 → 今週（日曜まで）→ 来週から → 次回話すこと → 投げたメモ → 期限なし", () => {
    assert.deepEqual(
      sortTodos(list, today).map((t) => t.id),
      ["contact", "contact-chat", "overdue", "today", "week", "later", "next", "memo", "none"],
    );
  });

  test("済んだ物は並べず「済み」に分ける", () => {
    assert.ok(!sortTodos(list, today).some((t) => t.id === "done"));
    assert.deepEqual(doneTodos(list).map((t) => t.id), ["done"]);
  });

  test("週は月曜から日曜まで（今週＝日曜まで、月曜からは来週）", () => {
    assert.equal(weekEnd("2026-11-04"), "2026-11-08");
    assert.equal(weekEnd("2026-11-08"), "2026-11-08");
    assert.equal(weekEnd("2026-11-09"), "2026-11-15");
    assert.equal(todoGroup(item("a", { source: "ad", due: "2026-11-08" }), today), "week");
    assert.equal(todoGroup(item("b", { source: "ad", due: "2026-11-09" }), today), "later");
  });

  test("同じ組の中は期限の早い順、そのあと足した古い順", () => {
    const l = [item("b", { source: "ad", due: "2026-11-20" }), item("a", { source: "ad", due: "2026-11-18" }), item("m2", { source: "memo", createdAt: "2026-11-03T00:00:00.000Z" }), item("m1", { source: "memo" })];
    assert.deepEqual(sortTodos(l, today).map((t) => t.id), ["a", "b", "m1", "m2"]);
  });

  test("過ぎた物の札は灰色（overdue。赤で急がせない）。お客様への連絡は「今日中」", () => {
    assert.deepEqual(dueLabel(item("o", { source: "ad", due: "2026-11-02" }), today, shop), { text: "11/2（月） 過ぎた", tone: "overdue" });
    assert.deepEqual(dueLabel(item("c", { source: "reserve", due: today }), today, shop), { text: "今日中", tone: "contact" });
    assert.deepEqual(dueLabel(item("c2", { source: "reserve", due: "2026-11-03" }), today, shop)?.tone, "overdue", "過ぎたお客様への連絡も先頭のまま、札は灰色");
    assert.equal(todoGroup(item("c2", { source: "reserve", due: "2026-11-03" }), today), "contact");
    assert.equal(dueLabel(item("t", { source: "ad", due: today }), today, shop)?.text, "今日");
    assert.equal(dueLabel(item("n", { source: "line" }), today, shop), null);
    // 画面の札の色に赤を使わない
    const css = readFileSync(join(__dirname, "../../../app/globals.css"), "utf8");
    const overdue = css.match(/\.todo-due\.overdue \{[^}]*\}/)?.[0] ?? "";
    assert.match(overdue, /var\(--muted\)/);
    assert.doesNotMatch(overdue, /red|#[cdef][0-9a-f]0{2}|--warn|--accent/);
  });

  test("タブ：期限あり／メモ・次回／期限なし／済み（並べ方は同じ）", () => {
    const tabs = todoTabs(list, today);
    assert.deepEqual(tabs.due.map((t) => t.id), ["contact", "contact-chat", "overdue", "today", "week", "later"]);
    assert.deepEqual(tabs.talk.map((t) => t.id), ["next", "memo"]);
    assert.deepEqual(tabs.none.map((t) => t.id), ["none"]);
    assert.deepEqual(tabs.done.map((t) => t.id), ["done"]);
  });

  test("足した ToDo の出どころは id の頭からも出す（前からブラウザに残っていた物）", () => {
    const old: AddedTodo[] = [
      { id: "td-h1", title: "江口（架空）様に別の日時を案内", createdAt: now, done: false },
      { id: "td-ad-p1", title: "3週間後に効いたか見る（3番）", createdAt: now, done: false, due: "2026-11-25" },
      { id: "td-next-k1", title: "青木（架空）様：前髪", createdAt: now, done: false, kind: "next-talk" },
      { id: "td-line-e1", title: "シャンプー発注", createdAt: now, done: false },
      { id: "td-chat-x", title: "江口（架空）様：傘", createdAt: now, done: false },
    ];
    const items = todoItems([], { ...emptyBook(today), todos: old }, shop);
    assert.deepEqual(items.map((t) => t.source), ["reserve", "ad", "karte", "line", "chat"]);
    assert.deepEqual(items.map((t) => t.key), ["予約:h1", adKey(3), karteKey("k1"), lineKey("e1"), "チャット:x"]);
    assert.equal(items[0].due, today, "期限の無いお客様への連絡は、足した日（店の時間帯）を期限にする");
  });
});

describe("2. 同じ鍵がもうあれば足さない", () => {
  test("同じ鍵なら id が違っても足さない", () => {
    const a = withTodo(emptyBook(today), { id: "x1", title: "A", createdAt: now, done: false, key: "メモ:99" });
    const b = withTodo(a, { id: "x2", title: "B", createdAt: now, done: false, key: "メモ:99" });
    assert.equal(b, a);
    assert.equal(b.todos.length, 1);
  });

  test("済んだ物と同じ鍵でも足さない（最初の状態の鍵も数える）", () => {
    const seedKey = [...SEED_TODO_KEYS][0];
    const s = withTodo(emptyBook(today), { id: "y", title: "例と同じ", createdAt: now, done: false, key: seedKey });
    assert.equal(s.todos.length, 0);
  });

  test("予約：「直す」と、予約サイト（架空）で枠が埋まった時は同じ鍵（予約:お客様＠日時）なので1つだけ", () => {
    const s0 = withHold(emptyBook(today), hold("h1"));
    const row = pendingApprovals(s0, now)[0];
    const full = fullSlotTodos(
      [
        { id: "h1", date: "2026-11-06", startMin: 900, endMin: 960, status: "hold" },
        ...[1, 2, 3].map((n) => ({ id: `r${n}`, date: "2026-11-06", startMin: 900, endMin: 990, status: "confirmed" })),
      ] as Reservation[],
      [row],
      { seats: shop.seats, customers: getCustomers(), today, nowIso: now },
    );
    assert.equal(full.length, 1);
    assert.equal(full[0].title, "江口（架空）様に別の日時を案内");
    assert.equal(full[0].due, today, "今日中");
    assert.equal(todoKey(full[0]), reserveKey("c04", "2026-11-06", "15:00"));
    const s1 = withTodo(s0, full[0]);
    const s2 = withReleased(s1, row.approval.id, "fixed", "江口", now, today);
    assert.equal(s2.todos.length, 1, "同じ鍵はもうあるので足さない");
    assert.equal(s2.chat.length, 0, "仮押さえは外れる（いつもの「直す」）");
  });

  test("「直す」「見送り」の ToDo は今日中・出どころは予約", () => {
    const s0 = withHold(emptyBook(today), hold("h1"));
    const s = withReleased(s0, pendingApprovals(s0, now)[0].approval.id, "skipped", "江口", now, "2026-11-05");
    const t = todoItems([], s, shop)[0];
    assert.equal(t.source, "reserve");
    assert.equal(t.due, "2026-11-05", "「翌日へ」で進めた今日");
    assert.equal(t.key, reserveKey("c04", "2026-11-06", "15:00"));
    assert.equal(todoGroup(t, "2026-11-05"), "contact");
  });

  test("予約チャットの「お店に確かめてご連絡します」もお客様への連絡（今日中）。同じ鍵は足さない", () => {
    const a = withChatTodo(emptyBook(today), { id: "td-chat-1", title: "江口（架空）様：傘を忘れました" }, "江口", now, today);
    assert.equal(a.state.todos[0].source, "chat");
    assert.equal(a.state.todos[0].due, today);
    const b = withChatTodo(a.state, { id: "td-chat-1", title: "江口（架空）様：傘を忘れました" }, "江口", now, today);
    assert.equal(b.journal, null);
    assert.equal(b.state.todos.length, 1);
  });

  test("カルテの「次回話すこと」：鍵は「カルテ:番号」", () => {
    const k: SavedKarte = { id: "k-test", customerId: "c01", date: today, menuId: "cut", memo: "m", sections: { next: ["前髪だけ"] }, savedAt: now };
    const out = withKarteSaved(emptyBook(today), k, "青木", getKarteHeadings());
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.equal(todoKey(out.state.todos[0]), karteKey("k-test"));
    assert.equal(todoItems([], out.state, shop)[0].source, "karte");
  });

  test("広告の判定日：鍵は「語句:番号」。同じ言葉の ToDo は2回入らない", () => {
    const ads = withProposal(
      EMPTY_ADS,
      { action: "stop", no: 3, text: "美容院 安い", reason: "予約が少ないので止めます" },
      { keywords: [{ no: 3, text: "美容院 安い", weeks: [], total: { clicks: 0, cost: 0, bookings: 0 }, off: false, featured: false }], searchTerms: [] } as never,
      { id: "p1", checks: [], nowIso: now, mode: "script" },
      getAdSettings(),
    );
    const out = approveAd(ads, emptyBook(today), "p1", { nowIso: now, today, shop, settings: getAdSettings() });
    assert.equal(out.book.todos.length, 1);
    assert.equal(todoKey(out.book.todos[0]), adKey(3));
    assert.ok(out.book.todos[0].due, "期限あり");
    const again = withTodo(out.book, { ...out.book.todos[0], id: "td-ad-other" });
    assert.equal(again.todos.length, 1);
  });

  test("LINE の一言で ToDo に振り分けた物も同じ所（鍵は LINE:番号）", () => {
    const out = applyAsk(
      { kind: "text", id: "e9", text: "ドライヤーのフィルター掃除", at: now } as never,
      { ok: true, via: "script", kind: "todo" },
      emptyBook(today),
      EMPTY_ADS,
      { shop, menus: [], customers: getCustomers(), nowIso: now, today, adSettings: getAdSettings(), found: [], karte: null, memoMax: 100 } as never,
    );
    const items = todoItems(seedItems, out.book, shop);
    const t = items.find((x) => x.key === lineKey("e9"));
    assert.ok(t);
    assert.equal(t!.source, "line");
    assert.equal(todoGroup(t!, today), "none");
  });

  test("投げたメモ：鍵は「メモ:番号」で、最初の状態の続きの番号", () => {
    const seedMemoMax = Math.max(...getTodos().filter((t) => t.source === "memo").map((t) => Number(t.key!.split(":")[1])));
    const a = withMemoTodo(emptyBook(today), seedItems, { title: "シャンプーを発注", memo: "シャンプーがもう無い" }, now, shop);
    assert.equal(a.todo?.key, memoKey(seedMemoMax + 1));
    assert.equal(a.todo?.memo, "シャンプーがもう無い", "元のメモはプログラムがそのまましまう");
    const b = withMemoTodo(a.state, seedItems, { title: "ほうきを買う", memo: "ほうき" }, now, shop);
    assert.equal(b.todo?.key, memoKey(seedMemoMax + 2));
    assert.equal(nextMemoNo(todoItems(seedItems, b.state, shop)), seedMemoMax + 3);
    assert.equal(todoGroup(todoItems([], b.state, shop)[0], today), "memo");
  });
});

describe("3. 今やる3件（同じ並べ方の上から3つ・済んだ物は出さない）", () => {
  test("最初の状態：並べ方の上から3つ", () => {
    const items = todoItems(seedItems, emptyBook(today), shop);
    const top = topTodos(items, today, todoJson.topCount);
    assert.equal(todoJson.topCount, 3);
    assert.deepEqual(top, sortTodos(items, today).slice(0, 3));
    assert.ok(top.every((t) => !t.done));
    assert.equal(todoGroup(top[0], today), "contact", "先頭はお客様への連絡（今日中）");
  });

  test("済みにすると今やる3件から消え、次の物が上がる", () => {
    const s0 = emptyBook(today);
    const items0 = todoItems(seedItems, s0, shop);
    const [first, , , fourth] = sortTodos(items0, today);
    const s1 = withTodoMarked(s0, first, true, now);
    const top = topTodos(todoItems(seedItems, s1, shop), today, 3);
    assert.ok(!top.some((t) => t.id === first.id));
    assert.equal(top[2].id, fourth.id);
  });
});

describe("4. 済みと戻す", () => {
  test("最初の状態の物：チェックで「済み」へ移り、戻すで元の場所へ", () => {
    const s0 = emptyBook(today);
    const target = todoTabs(todoItems(seedItems, s0, shop), today).due[0];
    const s1 = withTodoMarked(s0, target, true, now);
    const tabs1 = todoTabs(todoItems(seedItems, s1, shop), today);
    assert.ok(!tabs1.due.some((t) => t.id === target.id), "行が消える");
    assert.equal(tabs1.done[0].id, target.id, "「済み」のいちばん上");
    const s2 = withTodoMarked(s1, target, false, "2026-11-04T01:00:05.000Z");
    const tabs2 = todoTabs(todoItems(seedItems, s2, shop), today);
    assert.equal(tabs2.due[0].id, target.id, "戻すと元の場所");
    assert.ok(!tabs2.done.some((t) => t.id === target.id));
  });

  test("足した物：チェックで済み（済みにした時を持つ）・戻すでまだ", () => {
    const a = withMemoTodo(emptyBook(today), [], { title: "床を拭く", memo: "床" }, now, shop);
    const t = todoItems([], a.state, shop)[0];
    const s1 = withTodoMarked(a.state, t, true, "2026-11-04T02:00:00.000Z");
    assert.equal(s1.todos[0].done, true);
    assert.equal(s1.todos[0].doneAt, "2026-11-04T02:00:00.000Z");
    const s2 = withTodoMarked(s1, t, false, "2026-11-04T02:00:03.000Z");
    assert.equal(s2.todos[0].done, false);
    assert.equal(s2.todos[0].doneAt, undefined);
  });

  test("済みと戻すの印はブラウザに残り、読みなおしても同じ", () => {
    const s1 = withTodoMarked(emptyBook(today), seedItems[0], true, now);
    const back = parseBook(JSON.stringify(s1))!;
    assert.deepEqual(back.todoMarks, { [seedItems[0].id]: { done: true, at: now } });
    assert.equal(todoItems(seedItems, back, shop)[0].done, true);
  });

  test("「戻す」を出す秒数は config（8秒）", () => {
    assert.equal(getTodoLimits().undoSeconds, 8);
  });

  test("済んだ物は今日の ToDo の数に入れない。期限の先の物も、その日まで入れない", () => {
    const l = [item("a", {}), item("b", { done: true }), item("c", { source: "ad", due: "2026-11-25" }), item("d", { source: "ad", due: today })];
    assert.equal(todayTodoCount(l, today), 2);
  });
});

describe("5. 最初に戻す", () => {
  const store = new Map<string, string>();
  const g = globalThis as { window?: unknown };
  let had: unknown;
  before(() => {
    had = g.window;
    g.window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
      addEventListener() {},
      removeEventListener() {},
    };
  });
  after(() => {
    g.window = had;
  });

  test("足したメモ・済みの印・予約の ToDo が消え、最初の状態（架空の例）に戻る", () => {
    let s: BookState = withMemoTodo(emptyBook("2026-10-01"), seedItems, { title: "カーテンを洗う", memo: "カーテン" }, now, shop).state;
    s = withTodoMarked(s, seedItems[0], true, now);
    s = withTodoMarked(s, seedItems[seedItems.length - 1], false, now);
    const s0 = withHold(s, hold("h1"));
    s = withReleased(s0, pendingApprovals(s0, now)[0].approval.id, "fixed", "江口", now, today);
    writeBrowser(BOOK_KEY, JSON.stringify(s));
    assert.notDeepEqual(todoItems(seedItems, parseBook(readBrowser(BOOK_KEY))!, shop), seedItems);

    resetAll(today);

    const back = parseBook(readBrowser(BOOK_KEY))!;
    assert.deepEqual(back.todos, []);
    assert.deepEqual(back.todoMarks, {});
    const fresh = resolveSeedTodos(shop, calDay(shop, back.anchor), getTodos());
    assert.deepEqual(todoItems(fresh, back, shop), fresh, "ToDo は最初の状態だけ");
    assert.equal(nextMemoNo(todoItems(fresh, back, shop)), nextMemoNo(fresh), "メモの番号も最初から");
  });

  test("ToDo は台帳と同じ置き場所（secretairy:book）なので、最初に戻すの1回で戻る", () => {
    const w = resetAllWrites(today);
    const book = w.find((x) => x.key === BOOK_KEY)!;
    assert.deepEqual(parseBook(book.value), emptyBook(today));
    assert.deepEqual(emptyBook(today).todoMarks, {});
  });
});

describe("6. メモを投げる（Claude は文だけ。門と上限はプログラム）", () => {
  const run = (writer: TodoWriter, memo: string, mode: "ai" | "script" = "ai") =>
    runTodo({ memo, mode, writer, rules: [], maxTokens: limits.maxReplyTokens, maxTitleChars: limits.maxTitleChars });

  test("AI の文が門を通れば、その文を使う", async () => {
    const out = await run(fixedWriter("・「カラー剤の7番を2本発注」"), "カラー剤の7番が少ないから2本頼む");
    assert.deepEqual(out, { mode: "ai", title: "カラー剤の7番を2本発注", via: "ai" });
  });

  test("メモに無い体や判断の言葉・数字を足した文は使わず、プログラムがメモから作る", async () => {
    const a = await run(fixedWriter("頭皮に優しいシャンプーをおすすめする"), "シャンプーの在庫を見る");
    assert.equal(a.via, "program");
    assert.equal(a.title, "シャンプーの在庫を見る");
    assert.match(a.note ?? "", /メモに無い言葉/);
    const b = await run(fixedWriter("カラー剤を5本発注"), "カラー剤を頼む");
    assert.equal(b.via, "program");
    assert.match(b.note ?? "", /メモに無い数字/);
  });

  test("長すぎる文・空の文・上限で切れた文は使わない。断られたら知らせる", async () => {
    assert.equal((await run(fixedWriter("あ".repeat(limits.maxTitleChars + 1)), "床を拭く")).via, "program");
    assert.equal((await run(fixedWriter("   "), "床を拭く")).title, "床を拭く");
    assert.equal((await run(fixedWriter("床を拭", "max_tokens"), "床を拭く")).via, "program");
    await assert.rejects(run(fixedWriter("", "refusal"), "床を拭く"), TodoRefusedError);
  });

  test("決まった返事（AI なし）：メモの最初の文から「えーと」と終わりの「かな」を外す", async () => {
    const out = await run(scriptTodoWriter(), "えーと、タオルを追加で頼むかな。あと床も", "script");
    assert.deepEqual(out, { mode: "script", title: "タオルを追加で頼む", via: "program" });
    assert.equal([...programTitle("あ".repeat(80), 40)].length, 40);
    assert.equal(cleanTitle("ToDo：床を拭く\n2行目"), "床を拭く");
    assert.equal(gateTitle("床を拭く", "床を拭く", 40), null);
  });

  test("メモは100字まで（config/ai.json の todo.maxMemoChars）。上限は config にある", () => {
    const ai = aiJson as Record<string, any>;
    for (const k of ["maxReplyTokens", "maxMemoChars", "maxTitleChars", "maxRequestChars"]) assert.ok(ai.todo[k] > 0, `todo.${k}`);
    assert.equal(limits.maxMemoChars, 100);
    assert.equal(getTodoLimits().maxMemoChars, ai.todo.maxMemoChars);
    assert.ok(parseTodoRequest({ mode: "ai", memo: "あ".repeat(100), rules: [] }, limits.maxMemoChars, []).ok);
    const over = parseTodoRequest({ mode: "ai", memo: "あ".repeat(101), rules: [] }, limits.maxMemoChars, []);
    assert.ok(!over.ok);
    assert.ok(!parseTodoRequest({ mode: "ai", memo: "  ", rules: [] }, limits.maxMemoChars, []).ok);
    // 画面・窓口に上限の数を直に書かない
    for (const f of ["src/app/api/ai/todo/route.ts", "src/components/MemoThrow.tsx", "src/components/TodoRows.tsx", "src/app/todo/page.tsx"]) {
      const text = readFileSync(join(__dirname, "../../../..", f), "utf8");
      assert.doesNotMatch(text, /\b(100|40|8000)\b/, f);
    }
  });

  test("AI を呼ぶ窓口は /api/ai/todo（/api/ai/ の下）", () => {
    assert.ok(existsSync(join(__dirname, "../../../app/api/ai/todo/route.ts")));
  });

  test("お客様の名字は〔お客様〕に置きかえて送り、返ってきた文で「○○（架空）様」に戻す", () => {
    const memo = "青木さんに次の予約の電話";
    const { masked, found } = maskNames(memo, getCustomers());
    assert.equal(masked.includes("青木"), false);
    assert.equal(restoreNames("〔お客様〕さんに電話する", memo, found), "青木（架空）様に電話する");
    assert.equal(restoreNames("〔お客様〕に電話", "電話", []), "お客様に電話");
  });
});

describe("7. 架空の例（最初の状態）", () => {
  const seed = getTodos();

  test("20件前後。いろいろな入口・期限が混ざる", () => {
    assert.ok(seed.length >= 18 && seed.length <= 24, `${seed.length}件`);
    const sources = new Set(seed.map((t) => t.source));
    for (const s of ["memo", "karte", "ad", "reserve", "line", "chat"]) assert.ok(sources.has(s as never), s);
    const groups = new Set(todoItems(seedItems, emptyBook(today), shop).map((t) => todoGroup(t, today)));
    for (const g of ["contact", "overdue", "today", "next", "memo", "none", "done"]) assert.ok(groups.has(g as never), g);
    assert.ok(groups.has("week") || groups.has("later"), "先の期限");
  });

  test("鍵は1つずつ違い、id も違う。お客様は名字だけで「（架空）様」", () => {
    assert.equal(SEED_TODO_KEYS.size, seed.length);
    assert.equal(new Set(seed.map((t) => t.id)).size, seed.length);
    const surnames = new Set(getCustomers().map((c) => c.surname));
    for (const t of seed)
      for (const m of t.title.matchAll(/(\S+?)（架空）様/g)) assert.ok(surnames.has(m[1].replace(/^.*[：、]/, "")), t.title);
  });

  test("期限は営業日に置く（定休日には置かない）。投げたメモには元のメモがある", () => {
    for (const t of seedItems) if (t.due) assert.ok(calDay(shop, t.due).open, `${t.title} ${t.due}`);
    for (const t of seed.filter((x) => x.source === "memo")) assert.ok(t.memo && t.memo.length <= limits.maxMemoChars, t.id);
  });

  test("翌日へ・別の日に開いても、同じ数の例が同じ形で並ぶ", () => {
    for (const d of ["2026-11-02", "2026-11-07", "2026-11-11"]) {
      const day = calDay(shop, d);
      const items = resolveSeedTodos(shop, day, seed);
      assert.equal(items.length, seed.length);
      assert.equal(todoGroup(sortTodos(items, d)[0], d), "contact");
    }
  });
});

describe("予約サイト（架空）で枠が埋まったか", () => {
  const r = (id: string, startMin: number, endMin: number, status: "hold" | "confirmed" = "confirmed") => ({ id, date: "2026-11-06", startMin, endMin, status });
  test("確定の予約が席の数だけ重なれば埋まった。仮押さえは数えない", () => {
    const h = r("h", 900, 960, "hold");
    assert.equal(slotFull([h, r("a", 900, 960), r("b", 930, 990)], h, 3), false);
    assert.equal(slotFull([h, r("a", 900, 960), r("b", 930, 990), r("c", 945, 1000)], h, 3), true);
    assert.equal(slotFull([h, r("a", 900, 960), r("b", 930, 990), r("x", 930, 990, "hold")], h, 3), false);
    assert.equal(slotFull([h, r("a", 840, 900), r("b", 960, 990), r("c", 960, 990)], h, 2), false, "前後で重ならない");
  });

  test("承認で確定が増えて埋まったら、ほかの承認待ちの方に「別の日時を案内」（仮押さえはそのまま）", () => {
    let s = withHold(emptyBook(today), hold("h1"));
    s = withHold(s, hold("h2", { customerId: "c06" }));
    const rows = pendingApprovals(s, now);
    s = withApproved(s, rows[0].approval.id, now);
    const pending = pendingApprovals(s, now);
    assert.equal(pending.length, 1);
    const all = [
      { id: "h1", date: "2026-11-06", startMin: 900, endMin: 960, status: "confirmed" },
      { id: "h2", date: "2026-11-06", startMin: 900, endMin: 960, status: "hold" },
      { id: "r1", date: "2026-11-06", startMin: 900, endMin: 960, status: "confirmed" },
      { id: "r2", date: "2026-11-06", startMin: 900, endMin: 960, status: "confirmed" },
    ] as Reservation[];
    const todos = fullSlotTodos(all, pending, { seats: 3, customers: getCustomers(), today, nowIso: now });
    assert.deepEqual(todos.map((t) => t.title), ["加藤（架空）様に別の日時を案内"]);
    assert.equal(pendingApprovals(withTodo(s, todos[0]), now).length, 1, "仮押さえは変えない");
  });
});
