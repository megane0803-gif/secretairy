// ToDo の出どころと鍵。どの入口から入った ToDo も、同じ鍵がもうあれば足さない（docs/SPEC.md §1.11）。
// 鍵：メモ:番号 / カルテ:番号 / 語句:番号 / 予約:お客様＠日時 / LINE:番号 / チャット:番号
// 最初の例（seed/todo.json）の鍵は「例:」で始める。本物の広告・カルテ・予約・メモの鍵と重ならない
// （例を残したままでも、本物の 6番の承認・カルテの保存・メモの番号は止まらない）。
// 前からブラウザに残っていた ToDo（鍵を持たない物）は、id の頭から出どころと鍵を出す。

import type { AddedTodo } from "../book/state";
import { getTodos } from "../data/seed";

/**
 * memo = 投げたメモ / karte = カルテの「次回話すこと」/ ad = 広告の判定日 / reserve = 予約（直す・見送り・枠が埋まった）
 * line = LINE の一言 / chat = 予約チャットの「お店に確かめてご連絡します」
 */
export type TodoSource = "memo" | "karte" | "ad" | "reserve" | "line" | "chat";

export const TODO_SOURCES: readonly TodoSource[] = ["memo", "karte", "ad", "reserve", "line", "chat"];

/** 行の右に出す短い名前 */
export const SOURCE_LABEL: Record<TodoSource, string> = {
  memo: "メモ",
  karte: "カルテ",
  ad: "広告",
  reserve: "予約",
  line: "LINE",
  chat: "チャット",
};

/** お客様への連絡（今日中）になる出どころ */
export const CONTACT_SOURCES: readonly TodoSource[] = ["reserve", "chat"];

export const memoKey = (no: number) => `メモ:${no}`;
export const karteKey = (karteId: string) => `カルテ:${karteId}`;
export const adKey = (no: number) => `語句:${no}`;
export const reserveKey = (customerId: string, date: string, start: string) => `予約:${customerId}＠${date} ${start}`;
export const lineKey = (eventId: string) => `LINE:${eventId}`;
export const chatKey = (id: string) => `チャット:${id}`;

/** 出どころ（持っていなければ id の頭から） */
export function todoSource(t: Pick<AddedTodo, "id" | "source" | "kind">): TodoSource {
  if (t.source && TODO_SOURCES.includes(t.source)) return t.source;
  if (t.kind === "next-talk" || t.id.startsWith("td-next-")) return "karte";
  if (t.id.startsWith("td-memo-")) return "memo";
  if (t.id.startsWith("td-ad-")) return "ad";
  if (t.id.startsWith("td-line-")) return "line";
  if (t.id.startsWith("td-chat-")) return "chat";
  return "reserve";
}

/** 鍵（持っていなければ id と題から） */
export function todoKey(t: Pick<AddedTodo, "id" | "title" | "key" | "source" | "kind">): string {
  if (t.key) return t.key;
  const src = todoSource(t);
  const rest = (prefix: string) => (t.id.startsWith(prefix) ? t.id.slice(prefix.length) : t.id);
  switch (src) {
    case "karte":
      return karteKey(rest("td-next-"));
    case "memo":
      return `メモ:${rest("td-memo-")}`;
    case "ad": {
      const no = t.title.match(/（(\d+)番）/)?.[1];
      return no ? adKey(Number(no)) : `語句:${rest("td-ad-")}`;
    }
    case "line":
      return lineKey(rest("td-line-"));
    case "chat":
      return chatKey(rest("td-chat-"));
    default:
      return `予約:${rest("td-")}`;
  }
}

/** 最初の例の鍵の頭。本物の入口の鍵（メモ:・カルテ:・語句:・予約:・LINE:・チャット:）はこれで始まらない */
export const SEED_KEY_PREFIX = "例:";

/** 最初の例の鍵（「例:」で始める。書いていなければ id から作る） */
export function seedTodoKey(t: { id: string; key?: string }): string {
  const k = t.key ?? t.id;
  return k.startsWith(SEED_KEY_PREFIX) ? k : `${SEED_KEY_PREFIX}${k}`;
}

/** 最初の状態（seed/todo.json）の鍵。どれも「例:」で始まるので、本物の入口の鍵とは重ならない */
export const SEED_TODO_KEYS: ReadonlySet<string> = new Set(getTodos().map(seedTodoKey));
