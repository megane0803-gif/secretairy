"use client";

// 画面で使う ToDo の一覧。最初の状態（seed/todo.json。起点の日から数える）に、このブラウザで足した分と
// 済み・戻すの印を重ねる。並べ方は items.ts の1か所（ToDo のタブ・ホームの「今やる3件」・朝の要点の数が同じ物を使う）。

import { useCallback, useMemo } from "react";
import type { BookData } from "../book/data";
import { useBook } from "../book/useBook";
import { calDay } from "../calendar";
import { getTodos } from "../data/seed";
import { writeJournal } from "../journal";
import { resolveSeedTodos, todayTodoCount, todoItems, todoTabs, topTodos, withTodoMarked, type TodoItem } from "./items";

export function useTodos(data: BookData) {
  const book = useBook(data);
  const today = book.today.date;
  const seedItems = useMemo(() => {
    const anchor = calDay(data.shop, book.state.anchor);
    return resolveSeedTodos(data.shop, anchor.open ? anchor : book.today, getTodos());
  }, [data.shop, book.state.anchor, book.today]);
  const items = useMemo(() => todoItems(seedItems, book.state, data.shop), [seedItems, book.state, data.shop]);
  const tabs = useMemo(() => todoTabs(items, today), [items, today]);

  /** 人がチェックした・「戻す」を押した（AI は使わない。日誌に1行） */
  const { update } = book;
  const mark = useCallback(
    (item: TodoItem, done: boolean) => {
      update((s) => withTodoMarked(s, item, done, new Date().toISOString()));
      writeJournal({ who: "オーナー", text: `ToDo を${done ? "済みにした" : "まだに戻した"}：${item.title}` });
    },
    [update],
  );

  return {
    book,
    today,
    seedItems,
    items,
    tabs,
    top: (n: number) => topTodos(items, today, n),
    todayCount: todayTodoCount(items, today),
    mark,
  };
}
