"use client";

// やることの一覧。最初の状態（seed/todo.json）と、承認の箱から足した分（このブラウザの中だけ）。

import { CustomerName } from "@/components/parts";
import { withTodoDone } from "@/lib/book/state";
import { useBookState } from "@/lib/book/useBook";
import type { Todo } from "@/lib/data/types";
import { calDay } from "@/lib/calendar";
import { writeJournal } from "@/lib/journal";
import { getShop } from "@/lib/settings";

export function TodoList({ seed }: { seed: Todo[] }) {
  const { state, update } = useBookState();
  const added = [...state.todos].reverse();
  if (seed.length === 0 && added.length === 0) return <p className="empty">やることはありません。</p>;
  return (
    <ul className="todos">
      {added.map((t) => {
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
            <small className="hint">承認の箱から</small>
          </li>
        );
      })}
      {seed.map((t) => (
        <li key={t.id} className={t.done ? "todo done" : "todo"}>
          <span>{t.title}</span>
        </li>
      ))}
    </ul>
  );
}
