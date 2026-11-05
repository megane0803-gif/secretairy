"use client";

// 「今やる3件」：ToDo のタブと同じ並べ方の関数（src/lib/todo/items.ts の topTodos）で、上から3つ。済んだ物は出さない。
// ホームの真ん中と、ToDo のタブの右の列（PC）に出す。

import Link from "next/link";
import type { BookData } from "@/lib/book/data";
import { useTodos } from "@/lib/todo/useTodos";
import { TodoRowList, useUndo } from "./TodoRows";
import { Checked } from "./parts";

/** checked = false の時は「✓ 同じ並べ方で…」を出さない（ホーム。同じことを題名の下の1行で言っているため） */
export function TodoTop({
  data,
  count,
  undoSeconds,
  link = false,
  checked = true,
}: {
  data: BookData;
  count: number;
  undoSeconds: number;
  link?: boolean;
  checked?: boolean;
}) {
  const todos = useTodos(data);
  const { mark, toast } = useUndo(todos.mark, undoSeconds);
  const top = todos.top(count);
  return (
    <div className="todo-top">
      <TodoRowList items={top} today={todos.today} shop={data.shop} onMark={mark} empty="今やることはありません。" />
      {toast}
      {checked && <Checked>ToDo のタブと同じ並べ方で、プログラムが上から{count}つ出しています</Checked>}
      {link && (
        <p className="hint">
          <Link href="/todo">ToDo のタブで全部を見る →</Link>
        </p>
      )}
    </div>
  );
}
