"use client";

// やることの一覧（真ん中）。上にタブを4つ：期限あり（最初に開く）／メモ・次回／期限なし／済み。名前の下に件数。
// 並べ方はプログラム（src/lib/todo/items.ts）。Claude は並べない。
// 最初の状態（seed/todo.json）と、このブラウザで足した分（投げたメモ・カルテ・広告・予約・LINE・予約チャット）を1つにする。
// 「済み」以外の3つのタブは、中を種類の箱（お客様 → 仕入れと材料 → お店のこと → お金と事務 → 広告 → その他）に分ける。
// どの箱かはプログラムが出どころで決める（src/lib/todo/kinds.ts。投げたメモだけ送る時に選んだ種類）。箱の中は sortTodos の順のまま。

import { useState } from "react";
import { TodoRowList, useUndo } from "@/components/TodoRows";
import type { BookData } from "@/lib/book/data";
import { TODO_TABS, type TodoTab } from "@/lib/todo/items";
import { kindBoxes } from "@/lib/todo/kinds";
import { useTodos } from "@/lib/todo/useTodos";

const EMPTY: Record<TodoTab, string> = {
  due: "期限のあるやることはありません。",
  talk: "次回話すこと・投げたメモはありません。",
  none: "期限なしのやることはありません。",
  done: "済んだ物はまだありません。",
};

export function TodoList({ data, undoSeconds }: { data: BookData; undoSeconds: number }) {
  const todos = useTodos(data);
  const [tab, setTab] = useState<TodoTab>("due");
  const { mark, toast } = useUndo(todos.mark, undoSeconds);
  const rows = todos.tabs[tab];
  // 「済み」は今のまま。ほかの3つは種類の箱に分ける（空の箱は出さない）
  const boxes = tab === "done" ? [] : kindBoxes(rows);

  return (
    <>
      <div className="todo-tabs" role="tablist" aria-label="ToDo の分け方">
        {TODO_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`todo-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="todo-panel"
            className={tab === t.id ? "todo-tab on" : "todo-tab"}
            onClick={() => setTab(t.id)}
          >
            <span>{t.label}</span>
            <strong className="num">{todos.tabs[t.id].length}</strong>
          </button>
        ))}
      </div>
      {toast}
      <div id="todo-panel" role="tabpanel" aria-labelledby={`todo-tab-${tab}`}>
        {tab === "done" || rows.length === 0 ? (
          <TodoRowList items={rows} today={todos.today} shop={data.shop} onMark={mark} empty={EMPTY[tab]} />
        ) : (
          boxes.map((b) => (
            <section key={b.kind} className="todo-box" aria-labelledby={`todo-box-${b.kind}`}>
              <h3 id={`todo-box-${b.kind}`} className="todo-box-head">
                {b.label} <span className="num">{b.items.length}</span>件
              </h3>
              <TodoRowList items={b.items} today={todos.today} shop={data.shop} onMark={mark} empty="" />
            </section>
          ))
        )}
      </div>
    </>
  );
}
