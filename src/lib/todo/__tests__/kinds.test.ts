// ToDo の種類（箱）のテスト（docs/SPEC.md §1.11）。どの箱かはプログラムが出どころで決める（AI は決めない）。
// 1. 出どころごとの箱  2. 投げたメモで選んだ種類・選ばなかった時  3. 知らない出どころ・前からの物  4. 箱の並び
// 5. メモを足す時に種類を持つ（ブラウザに残して読み直しても残る）  6. AI には送らない  7. 最初の例・最初に戻す

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { emptyBook, parseBook, withTodo, type BookState } from "../../book/state";
import { BOOK_KEY, readBrowser, writeBrowser } from "../../browser";
import { calDay } from "../../calendar";
import { getTodos } from "../../data/seed";
import { resetAll } from "../../reset";
import { getShop } from "../../settings";
import { resolveSeedTodos, sortTodos, todoItems, todoTabs, withMemoTodo, type TodoItem } from "../items";
import { KIND_LABEL, KIND_ORDER, kindBoxes, MEMO_KINDS, readMemoKind, todoKind } from "../kinds";
import { TODO_SOURCES } from "../keys";

const shop = getShop();
const today = "2026-11-04"; // 水曜
const now = "2026-11-04T01:00:00.000Z";
const seedItems = resolveSeedTodos(shop, calDay(shop, today), getTodos());
const root = join(__dirname, "../../../..");

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

describe("1. 出どころごとの箱（プログラムが決める）", () => {
  test("予約・予約チャット・カルテの次回話すこと → お客様", () => {
    assert.equal(todoKind({ source: "reserve" }), "customer");
    assert.equal(todoKind({ source: "chat" }), "customer");
    assert.equal(todoKind({ source: "karte" }), "customer");
  });

  test("広告の判定日 → 広告。LINE の一言 → その他", () => {
    assert.equal(todoKind({ source: "ad" }), "ad");
    assert.equal(todoKind({ source: "line" }), "other");
  });

  test("ほかの入口は、種類の欄を持っていても出どころで決める（選べるのは投げたメモだけ）", () => {
    assert.equal(todoKind({ source: "reserve", category: "supply" }), "customer");
    assert.equal(todoKind({ source: "ad", category: "office" }), "ad");
    assert.equal(todoKind({ source: "line", category: "shop" }), "other");
  });

  test("今の入口はどれも、6つの箱のどれかに入る", () => {
    for (const s of TODO_SOURCES) assert.ok(KIND_ORDER.includes(todoKind({ source: s })), s);
  });
});

describe("2. 投げたメモは送る時に選んだ種類。選ばなかった時は その他", () => {
  test("選べる4つ（お客様・仕入れと材料・お店のこと・お金と事務）はその箱に入る", () => {
    assert.deepEqual([...MEMO_KINDS], ["customer", "supply", "shop", "office"]);
    for (const k of MEMO_KINDS) assert.equal(todoKind({ source: "memo", category: k }), k);
    assert.deepEqual(
      MEMO_KINDS.map((k) => KIND_LABEL[k]),
      ["お客様", "仕入れと材料", "お店のこと", "お金と事務"],
    );
  });

  test("選ばなかった（無い・null）メモは その他", () => {
    assert.equal(todoKind({ source: "memo" }), "other");
    assert.equal(todoKind({ source: "memo", category: null }), "other");
  });

  test("選べない種類（広告・その他・知らない文字・文字でない物）は その他", () => {
    for (const c of ["ad", "other", "money", "", 3, {}]) {
      assert.equal(todoKind({ source: "memo", category: c }), "other", String(c));
      assert.equal(readMemoKind(c), undefined, String(c));
    }
  });
});

describe("3. 知らない出どころ・前からブラウザに残っていた物でも落ちない", () => {
  test("知らない出どころ・出どころが無い物は その他", () => {
    assert.equal(todoKind({ source: "fax" }), "other");
    assert.equal(todoKind({}), "other");
  });

  test("前からブラウザに残っていた種類の無いメモは その他の箱に入る（読み直しても落ちない）", () => {
    const old = { v: 1, anchor: today, chat: [], approvals: [], kartes: [], dayOffset: 0, todos: [{ id: "td-memo-1", title: "床を拭く", createdAt: now, done: false, memo: "床" }] };
    const s = parseBook(JSON.stringify(old))!;
    const rows = todoItems([], s, shop);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "memo");
    assert.equal(rows[0].category, undefined);
    assert.deepEqual(
      kindBoxes(rows).map((b) => b.kind),
      ["other"],
    );
  });

  test("ブラウザに残っていた種類がおかしい物は捨てて その他", () => {
    const raw = { v: 1, anchor: today, chat: [], approvals: [], kartes: [], dayOffset: 0, todos: [{ id: "td-memo-1", title: "床を拭く", createdAt: now, done: false, source: "memo", category: "ad" }] };
    const s = parseBook(JSON.stringify(raw))!;
    assert.equal(s.todos[0].category, undefined);
    assert.equal(todoKind(todoItems([], s, shop)[0]), "other");
  });
});

describe("4. 箱の並び・空の箱は出さない・箱の中は sortTodos の順のまま", () => {
  test("お客様 → 仕入れと材料 → お店のこと → お金と事務 → 広告 → その他", () => {
    assert.deepEqual([...KIND_ORDER], ["customer", "supply", "shop", "office", "ad", "other"]);
    assert.deepEqual(
      KIND_ORDER.map((k) => KIND_LABEL[k]),
      ["お客様", "仕入れと材料", "お店のこと", "お金と事務", "広告", "その他"],
    );
  });

  test("空の箱は出さず、箱の中は渡した順のまま（件数は箱の中の数）", () => {
    const rows = [
      item("l1", { source: "line" }),
      item("m1", { source: "memo", category: "office" }),
      item("r1", { source: "reserve" }),
      item("a1", { source: "ad" }),
      item("r2", { source: "chat" }),
      item("m2", { source: "memo" }),
    ];
    const boxes = kindBoxes(rows);
    assert.deepEqual(
      boxes.map((b) => [b.kind, b.label, b.items.map((t) => t.id)]),
      [
        ["customer", "お客様", ["r1", "r2"]],
        ["office", "お金と事務", ["m1"]],
        ["ad", "広告", ["a1"]],
        ["other", "その他", ["l1", "m2"]],
      ],
    );
    assert.deepEqual(kindBoxes([]), []);
  });

  test("「期限あり」の箱の中は、お客様への連絡（今日中）が先（sortTodos の順）", () => {
    const rows = [
      item("ad-today", { source: "ad", due: today }),
      item("chat-old", { source: "chat", due: "2026-11-02", createdAt: "2026-11-02T00:00:00.000Z" }),
      item("res-week", { source: "reserve", due: "2026-11-06" }),
      item("res-today", { source: "reserve", due: today }),
    ];
    const due = todoTabs(rows, today).due;
    const customer = kindBoxes(due).find((b) => b.kind === "customer")!;
    assert.deepEqual(
      customer.items.map((t) => t.id),
      sortTodos(rows, today)
        .filter((t) => todoKind(t) === "customer")
        .map((t) => t.id),
    );
    assert.deepEqual(
      customer.items.map((t) => t.id),
      ["chat-old", "res-today", "res-week"],
    );
  });
});

describe("5. メモを足す時に、選んだ種類を持つ", () => {
  test("選んだ種類を足した ToDo に持ち、その箱に入る", () => {
    const r = withMemoTodo(emptyBook(today), seedItems, { title: "カラー剤を発注", memo: "カラー剤が少ない", category: "supply" }, now, shop);
    assert.equal(r.todo?.category, "supply");
    const added = todoItems(seedItems, r.state, shop).find((t) => t.id === r.todo!.id)!;
    assert.equal(todoKind(added), "supply");
  });

  test("選ばなかった時・選べない種類の時は種類を持たず、その他の箱", () => {
    for (const c of [undefined, null, "ad", "other", "x"]) {
      const r = withMemoTodo(emptyBook(today), seedItems, { title: "床を拭く", memo: "床", category: c }, now, shop);
      assert.ok(r.todo, String(c));
      assert.equal("category" in r.todo!, false, String(c));
      assert.equal(todoKind(todoItems(seedItems, r.state, shop).find((t) => t.id === r.todo!.id)!), "other", String(c));
    }
  });

  test("ブラウザに残して読み直しても、種類は残る（今の置き場所 secretairy:book の todos のまま）", () => {
    const r = withMemoTodo(emptyBook(today), seedItems, { title: "家賃を確かめる", memo: "家賃", category: "office" }, now, shop);
    const back = parseBook(JSON.stringify(r.state))!;
    assert.equal(back.todos[0].category, "office");
    assert.equal(todoItems(seedItems, back, shop).find((t) => t.id === r.todo!.id)!.category, "office");
  });

  test("種類が違っても、同じ鍵は足さない（今の決まりのまま）", () => {
    const a = withMemoTodo(emptyBook(today), seedItems, { title: "床を拭く", memo: "床", category: "shop" }, now, shop);
    const again = withTodo(a.state, { ...a.todo!, category: "office" });
    assert.equal(again, a.state);
  });
});

describe("6. 種類はオーナーが選ぶ物だけ（AI には送らない・決めさせない）", () => {
  test("メモを投げる窓口の形（wire.ts）と窓口・AI の流れは種類を持たない", () => {
    for (const f of ["src/lib/todo/wire.ts", "src/app/api/ai/todo/route.ts", "src/lib/todo/run.ts", "src/lib/todo/writer.ts", "src/lib/todo/prompt.ts"]) {
      const text = readFileSync(join(root, f), "utf8");
      assert.doesNotMatch(text, /category|kinds/, f);
    }
  });

  test("メモの欄（MemoThrow）は種類を AI に送る中身に入れず、足す時だけ渡す", () => {
    const text = readFileSync(join(root, "src/components/MemoThrow.tsx"), "utf8");
    assert.match(text, /const body: TodoRequest = \{ mode: how, memo: masked, rules: rules\.filter\(\(r\) => !r\.locked\) \};/);
    assert.match(text, /withMemoTodo\(s, todos\.seedItems, \{ title, memo, due: memoDue\(memo, todos\.today\), category: kind \}/);
    assert.match(text, /aria-pressed=\{kind === k\}/, "選んでいるかを読み上げでも");
    assert.match(text, /✓/, "選んでいるかを色だけでなく");
  });
});

describe("7. 最初の例（seed/todo.json）と最初に戻す", () => {
  test("種類を持つのは投げたメモだけで、どれも選べる4つのどれか", () => {
    for (const t of getTodos()) {
      if (t.category === undefined) continue;
      assert.equal(t.source, "memo", t.id);
      assert.ok(readMemoKind(t.category), t.id);
    }
  });

  test("「メモ・次回」に、お客様・仕入れと材料・お店のこと・お金と事務・その他の投げたメモが見える", () => {
    const talk = todoTabs(todoItems(seedItems, emptyBook(today), shop), today).talk;
    const memoKinds = new Set(talk.filter((t) => t.source === "memo").map(todoKind));
    for (const k of ["customer", "supply", "shop", "office", "other"] as const) assert.ok(memoKinds.has(k), k);
    // カルテの次回話すことはお客様の箱の先頭（sortTodos の順）
    const customer = kindBoxes(talk).find((b) => b.kind === "customer")!;
    assert.equal(customer.items[0].source, "karte");
  });

  test("「期限あり」はお客様と広告などの箱に分かれる", () => {
    const due = todoTabs(todoItems(seedItems, emptyBook(today), shop), today).due;
    const kinds = kindBoxes(due).map((b) => b.kind);
    assert.ok(kinds.includes("customer"));
    assert.ok(kinds.includes("ad"));
  });

  describe("最初に戻すと、種類も最初の例に戻る", () => {
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

    test("足したメモの種類は消え、箱の分かれ方は最初の例と同じ", () => {
      const first = kindBoxes(todoTabs(todoItems(seedItems, emptyBook(today), shop), today).talk).map((b) => [b.kind, b.items.length]);
      let s: BookState = withMemoTodo(emptyBook(today), seedItems, { title: "カラー剤を発注", memo: "カラー剤", category: "supply" }, now, shop).state;
      s = withMemoTodo(s, seedItems, { title: "家賃", memo: "家賃", category: "office" }, now, shop).state;
      writeBrowser(BOOK_KEY, JSON.stringify(s));
      assert.notDeepEqual(kindBoxes(todoTabs(todoItems(seedItems, parseBook(readBrowser(BOOK_KEY))!, shop), today).talk).map((b) => [b.kind, b.items.length]), first);

      resetAll(today);

      const back = parseBook(readBrowser(BOOK_KEY))!;
      const fresh = resolveSeedTodos(shop, calDay(shop, back.anchor), getTodos());
      assert.deepEqual(
        kindBoxes(todoTabs(todoItems(fresh, back, shop), today).talk).map((b) => [b.kind, b.items.length]),
        first,
      );
    });
  });
});
