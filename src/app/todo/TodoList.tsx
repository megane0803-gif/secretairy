"use client";

// やることの一覧。最初の状態（seed/todo.json）と、承認の箱・カルテの保存から足した分（このブラウザの中だけ）。
// カルテの保存から足した物は「次回話すこと」としてまとめて先に出す。

import { CustomerName } from "@/components/parts";
import { withTodoDone, type AddedTodo } from "@/lib/book/state";
import { useBookState } from "@/lib/book/useBook";
import type { Todo } from "@/lib/data/types";
import { calDay } from "@/lib/calendar";
import { writeJournal } from "@/lib/journal";
import { getShop } from "@/lib/settings";

export function TodoList({ seed }: { seed: Todo[] }) {
  const { state, update } = useBookState();
  const all = [...state.todos].reverse();
  const talks = all.filter((t) => t.kind === "next-talk");
  const added = all.filter((t) => t.kind !== "next-talk");
  if (seed.length === 0 && all.length === 0) return <p className="empty">やることはありません。</p>;

  const row = (t: AddedTodo, from: string) => {
    const m = t.title.match(/^(.+?)（架空）様(.*)$/);
    return (
      <li key={t.id} className={t.done ? "todo done" : "todo"}>
        <label>
          <input
            type="checkbox"
            checked={t.done}
            onChange={(e) => {
              update((s) => withTodoDone(s, t.id, e.target.checked));
              writeJournal({ who: "オーナー", text: `ToDo を${e.target.checked ? "済みにした" : "まだに戻した"}：${t.title}` });
            }}
          />
          {m ? (
            <span>
              <CustomerName surname={m[1]} fictional />
              {m[2]}
            </span>
          ) : (
            <span>{t.title}</span>
          )}
        </label>
        {t.due && <small className="hint num">期限 {calDay(getShop(), t.due).label}</small>}
        <small className="hint">{from}</small>
      </li>
    );
  };

  return (
    <>
      {talks.length > 0 && (
        <>
          <h3 className="todo-group">次回話すこと（カルテの次回提案から）</h3>
          <ul className="todos">{talks.map((t) => row(t, "カルテから"))}</ul>
        </>
      )}
      {(added.length > 0 || seed.length > 0) && (
        <>
          {talks.length > 0 && <h3 className="todo-group">ほかのやること</h3>}
          <ul className="todos">
            {added.map((t) => row(t, "承認の箱から"))}
            {seed.map((t) => (
              <li key={t.id} className={t.done ? "todo done" : "todo"}>
                <span>{t.title}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
