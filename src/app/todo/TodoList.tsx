"use client";

// やることの一覧（真ん中）。上にタブを4つ：期限あり（最初に開く）／メモ・次回／期限なし／済み。名前の下に件数。
// 並べ方はプログラム（src/lib/todo/items.ts）。Claude は並べない。
// 最初の状態（seed/todo.json）と、このブラウザで足した分（投げたメモ・カルテ・広告・予約・LINE・予約チャット）を1つにする。

import { useState } from "react";
import { TodoRowList, useUndo } from "@/components/TodoRows";
import type { BookData } from "@/lib/book/data";
import { TODO_TABS, type TodoTab } from "@/lib/todo/items";
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
  // 「メモ・次回」は、次回話すこと（カルテ）→ 投げたメモ の順に見出しを分ける
  const talks = tab === "talk" ? rows.filter((t) => t.source === "karte") : [];
  const memos = tab === "talk" ? rows.filter((t) => t.source !== "karte") : [];

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
        {tab === "talk" ? (
          rows.length === 0 ? (
            <p className="empty">{EMPTY.talk}</p>
          ) : (
            <>
              {talks.length > 0 && (
                <>
                  <h3 className="todo-group">次回話すこと（カルテの次回提案から）</h3>
                  <TodoRowList items={talks} today={todos.today} shop={data.shop} onMark={mark} empty="" />
                </>
              )}
              {memos.length > 0 && (
                <>
                  <h3 className="todo-group">投げたメモ</h3>
                  <TodoRowList items={memos} today={todos.today} shop={data.shop} onMark={mark} empty="" />
                </>
              )}
            </>
          )
        ) : (
          <TodoRowList items={rows} today={todos.today} shop={data.shop} onMark={mark} empty={EMPTY[tab]} />
        )}
      </div>
    </>
  );
}
