// ToDo の一覧の形と並べ方（プログラムが並べる。Claude は並べない。docs/SPEC.md §1.11）。
// 最初の状態（seed/todo.json）と、このブラウザで足した分（secretairy:book の todos）を1つの一覧にする。
// ToDo のタブ・ホームの「今やる3件」・朝の要点の「今日の ToDo」は、みなここの同じ関数を使う。
//
// 並べ方（上から）：
//   ① 期限あり … 先頭は「お客様への連絡（今日中）」、そのあと 過ぎている → 今日 → 今週（日曜まで）→ 来週から
//   ② 次回話すこと（カルテ）
//   ③ 投げたメモ
//   ④ 期限なし
// 済んだ物は「済み」に分ける（済みにした新しい順）。

import type { AddedTodo, BookState } from "../book/state";
import { withTodo, withTodoDone } from "../book/state";
import { addDays, businessDayAt, calDay, openedDate, type CalDay } from "../calendar";
import type { Todo } from "../data/types";
import type { ShopSettings } from "../settings";
import { CONTACT_SOURCES, memoKey, seedTodoKey, todoKey, todoSource, type TodoSource } from "./keys";

export type TodoItem = {
  id: string;
  key: string;
  title: string;
  source: TodoSource;
  /** いつまで（YYYY-MM-DD）。無ければ期限なし */
  due?: string;
  /** 投げたメモの元の文 */
  memo?: string;
  createdAt: string;
  done: boolean;
  doneAt?: string;
  /** 最初の状態（seed/todo.json）の物 */
  seed: boolean;
};

/** contact = お客様への連絡（今日中）/ overdue = 過ぎている / today = 今日 / week = 今週（日曜まで）/ later = 来週から */
export type TodoGroup = "contact" | "overdue" | "today" | "week" | "later" | "next" | "memo" | "none" | "done";

export const GROUP_ORDER: readonly TodoGroup[] = ["contact", "overdue", "today", "week", "later", "next", "memo", "none", "done"];

/** ToDo のページの上のタブ：期限あり（最初に開く）／メモ・次回／期限なし／済み */
export type TodoTab = "due" | "talk" | "none" | "done";

export const TODO_TABS: readonly { id: TodoTab; label: string }[] = [
  { id: "due", label: "期限あり" },
  { id: "talk", label: "メモ・次回" },
  { id: "none", label: "期限なし" },
  { id: "done", label: "済み" },
];

/**
 * 最初の状態の ToDo を本当の日付に直す。期限は起点の日から数えた営業日（定休日には置かない）。
 * 足した日は起点の日より前にして、このブラウザで足した物より古い扱いにする（並びは seed の順）。
 */
export function resolveSeedTodos(shop: ShopSettings, anchor: CalDay, seed: Todo[]): TodoItem[] {
  const base = Date.parse(`${anchor.date}T00:00:00.000Z`);
  return seed.map((t, i) => {
    const createdAt = new Date(base - (seed.length - i) * 60_000).toISOString();
    const due = typeof t.due === "number" ? businessDayAt(shop, anchor, t.due)?.date : undefined;
    const source = todoSource({ id: `td-${t.id}`, source: t.source, kind: t.source === "karte" ? "next-talk" : undefined });
    return {
      id: t.id,
      key: seedTodoKey(t),
      title: t.title,
      source,
      ...(due ? { due } : {}),
      ...(t.memo ? { memo: t.memo } : {}),
      createdAt,
      done: t.done,
      ...(t.done ? { doneAt: createdAt } : {}),
      seed: true,
    };
  });
}

/** 足した ToDo を一覧の形にする。お客様への連絡で期限を持たない古い物は、足した日（店の時間帯）を期限にする */
export function addedItem(t: AddedTodo, shop: Pick<ShopSettings, "timezone">): TodoItem {
  const source = todoSource(t);
  const due = t.due ?? (CONTACT_SOURCES.includes(source) ? openedDate(shop, new Date(t.createdAt)) : undefined);
  return {
    id: t.id,
    key: todoKey(t),
    title: t.title,
    source,
    ...(due ? { due } : {}),
    ...(t.memo ? { memo: t.memo } : {}),
    createdAt: t.createdAt,
    done: t.done,
    ...(t.doneAt ? { doneAt: t.doneAt } : {}),
    seed: false,
  };
}

/** 最初の状態（済み・戻すの印を重ねる）と、足した分を1つにする。同じ鍵は1つだけ（最初の状態の方を残す） */
export function todoItems(seedItems: TodoItem[], s: BookState, shop: Pick<ShopSettings, "timezone">): TodoItem[] {
  const marks = s.todoMarks ?? {};
  const seed = seedItems.map((t) => {
    const m = marks[t.id];
    if (!m) return t;
    const { doneAt: _drop, ...rest } = t;
    void _drop;
    return m.done ? { ...rest, done: true, doneAt: m.at } : { ...rest, done: false };
  });
  const keys = new Set(seed.map((t) => t.key));
  const added = s.todos.map((t) => addedItem(t, shop)).filter((t) => !keys.has(t.key));
  return [...seed, ...added];
}

/** その週の日曜（週は月曜から日曜まで） */
export function weekEnd(today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = 日
  return addDays(today, (7 - w) % 7);
}

export function todoGroup(t: TodoItem, today: string): TodoGroup {
  if (t.done) return "done";
  if (t.source === "karte") return "next";
  if (t.due) {
    if (CONTACT_SOURCES.includes(t.source) && t.due <= today) return "contact";
    if (t.due < today) return "overdue";
    if (t.due === today) return "today";
    if (t.due <= weekEnd(today)) return "week";
    return "later";
  }
  if (t.source === "memo") return "memo";
  return "none";
}

export function tabOfGroup(g: TodoGroup): TodoTab {
  if (g === "done") return "done";
  if (g === "next" || g === "memo") return "talk";
  if (g === "none") return "none";
  return "due";
}

const byCreated = (a: TodoItem, b: TodoItem) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** まだ済んでいない物を、上の並べ方で並べる */
export function sortTodos(items: TodoItem[], today: string): TodoItem[] {
  const rank = (t: TodoItem) => GROUP_ORDER.indexOf(todoGroup(t, today));
  return items
    .filter((t) => !t.done)
    .sort((a, b) => rank(a) - rank(b) || (a.due && b.due ? a.due.localeCompare(b.due) : 0) || byCreated(a, b));
}

/** 済んだ物（済みにした新しい順） */
export function doneTodos(items: TodoItem[]): TodoItem[] {
  return items
    .filter((t) => t.done)
    .sort((a, b) => (b.doneAt ?? b.createdAt).localeCompare(a.doneAt ?? a.createdAt) || a.id.localeCompare(b.id));
}

/** タブごとの行（並べ方は sortTodos と同じ） */
export function todoTabs(items: TodoItem[], today: string): Record<TodoTab, TodoItem[]> {
  const out: Record<TodoTab, TodoItem[]> = { due: [], talk: [], none: [], done: doneTodos(items) };
  for (const t of sortTodos(items, today)) out[tabOfGroup(todoGroup(t, today))].push(t);
  return out;
}

/** ホームの「今やる3件」：同じ並べ方の上から n 個。済んだ物は出さない */
export function topTodos(items: TodoItem[], today: string, n: number): TodoItem[] {
  return sortTodos(items, today).slice(0, Math.max(0, n));
}

/** 朝の要点の「今日の ToDo」：まだ済んでいない物のうち、期限が無いか今日まで（期限の先の物はその日まで数えない） */
export function todayTodoCount(items: TodoItem[], today: string): number {
  return items.filter((t) => !t.done && (!t.due || t.due <= today)).length;
}

export type DueTone = "contact" | "overdue" | "today" | "week" | "later";

/** 行の左に出す期限の札（小さく・色で）。過ぎた物は灰色（赤で急がせない） */
export function dueLabel(t: TodoItem, today: string, shop: ShopSettings): { text: string; tone: DueTone } | null {
  if (!t.due) return null;
  const g = todoGroup({ ...t, done: false }, today);
  const day = calDay(shop, t.due).label;
  if (g === "contact") return t.due === today ? { text: "今日中", tone: "contact" } : { text: `${day} 過ぎた`, tone: "overdue" };
  if (g === "overdue") return { text: `${day} 過ぎた`, tone: "overdue" };
  if (g === "today") return { text: "今日", tone: "today" };
  if (g === "week") return { text: day, tone: "week" };
  return { text: day, tone: "later" };
}

/** 次に投げるメモの番号（足した分の「メモ:番号」の続き。最初の例の「例:メモ:番号」は数えない） */
export function nextMemoNo(items: Pick<TodoItem, "key">[]): number {
  let max = 0;
  for (const t of items) {
    const m = t.key.match(/^メモ:(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** 投げたメモを ToDo に足す。文は Claude（か決まった返事）が直した物、元のメモはプログラムがそのまましまう */
export function withMemoTodo(
  s: BookState,
  seedItems: TodoItem[],
  input: { title: string; memo: string },
  nowIso: string,
  shop: Pick<ShopSettings, "timezone">,
): { state: BookState; todo: AddedTodo | null } {
  const title = input.title.replace(/\s+/g, " ").trim();
  if (!title) return { state: s, todo: null };
  // 最初の例のメモの鍵は「例:メモ:番号」なので数えない（本物のメモは 1 から）
  const no = nextMemoNo(todoItems(seedItems, s, shop));
  const todo: AddedTodo = { id: `td-memo-${no}`, title, createdAt: nowIso, done: false, source: "memo", key: memoKey(no), memo: input.memo.trim() };
  const next = withTodo(s, todo);
  return next === s ? { state: s, todo: null } : { state: next, todo };
}

/** 済みにする・戻す。最初の状態の物は印（todoMarks）で、足した物は todos の中で */
export function withTodoMarked(s: BookState, item: Pick<TodoItem, "id" | "seed">, done: boolean, nowIso: string): BookState {
  if (!item.seed) return withTodoDone(s, item.id, done, nowIso);
  return { ...s, todoMarks: { ...(s.todoMarks ?? {}), [item.id]: { done, at: nowIso } } };
}
