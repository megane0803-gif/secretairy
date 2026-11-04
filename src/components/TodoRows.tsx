"use client";

// ToDo の行。1行は文だけ。期限は左に小さく色で（過ぎた物は灰色）、出どころは右に短い名前で。
// 投げたメモには印を付け、押すと元のメモを開く。チェックすると行が消えて「済み」へ移り、
// 「…を済にしました　戻す」を少しの間（config/todo.json の undoSeconds）出す。
// ToDo のタブとホームの「今やる3件」で同じ物を使う。

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { dueLabel, type TodoItem } from "@/lib/todo/items";
import { SOURCE_LABEL } from "@/lib/todo/keys";
import type { ShopSettings } from "@/lib/settings";
import { CustomerName } from "./parts";

const NAME = /([^\s（）、。：「」]+?)（架空）様/g;

/** 題の中の「○○（架空）様」は、いつもの「○○ 様 [架空]」の札で出す */
export function TodoTitle({ title }: { title: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of title.matchAll(NAME)) {
    const i = m.index ?? 0;
    if (i > last) parts.push(title.slice(last, i));
    parts.push(<CustomerName key={i} surname={m[1]} fictional />);
    last = i + m[0].length;
  }
  if (last < title.length) parts.push(title.slice(last));
  return (
    <span className="todo-title">
      {parts.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
    </span>
  );
}

export function TodoRow({
  item,
  today,
  shop,
  onMark,
}: {
  item: TodoItem;
  today: string;
  shop: ShopSettings;
  onMark: (item: TodoItem, done: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const due = item.done ? null : dueLabel(item, today, shop);
  const memoId = `todo-memo-${item.id}`;
  return (
    <li className={item.done ? "todo done" : "todo"}>
      <div className="todo-line">
        <input
          type="checkbox"
          checked={item.done}
          onChange={(e) => onMark(item, e.target.checked)}
          aria-label={`${item.title}を${item.done ? "まだに戻す" : "済みにする"}`}
        />
        <span className="todo-body">
          {due && <span className={`todo-due ${due.tone}`}>{due.text}</span>}
          <TodoTitle title={item.title} />
          {item.memo && (
          <button
            type="button"
            className="todo-memo-mark"
            aria-expanded={open}
            aria-controls={memoId}
            title="元のメモを開く"
            onClick={() => setOpen((v) => !v)}
          >
            <span aria-hidden>📝</span>
            <span className="sr-only">元のメモ</span>
          </button>
          )}
        </span>
        <small className="todo-from">{SOURCE_LABEL[item.source]}</small>
      </div>
      {item.memo && open && (
        <p id={memoId} className="todo-memo">
          元のメモ：{item.memo}
        </p>
      )}
    </li>
  );
}

/** チェックして済みにした・戻したときの「…を済にしました　戻す」 */
export function useUndo(onMark: (item: TodoItem, done: boolean) => void, seconds: number) {
  const [last, setLast] = useState<TodoItem | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  const mark = (item: TodoItem, done: boolean) => {
    onMark(item, done);
    if (timer.current) window.clearTimeout(timer.current);
    if (done) {
      setLast(item);
      timer.current = window.setTimeout(() => setLast(null), seconds * 1000);
    } else setLast(null);
  };
  const toast = last ? (
    <p className="todo-undo" role="status">
      <span>
        「<TodoTitle title={last.title} />」を済にしました
      </span>
      <button
        type="button"
        className="btn small"
        onClick={() => {
          onMark(last, false);
          setLast(null);
        }}
      >
        戻す
      </button>
    </p>
  ) : null;
  return { mark, toast };
}

export function TodoRowList({
  items,
  today,
  shop,
  onMark,
  empty,
}: {
  items: TodoItem[];
  today: string;
  shop: ShopSettings;
  onMark: (item: TodoItem, done: boolean) => void;
  empty: string;
}) {
  if (items.length === 0) return <p className="empty">{empty}</p>;
  return (
    <ul className="todos">
      {items.map((t) => (
        <TodoRow key={t.id} item={t} today={today} shop={shop} onMark={onMark} />
      ))}
    </ul>
  );
}
