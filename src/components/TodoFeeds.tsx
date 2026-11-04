"use client";

// 予約サイト（架空）で枠が埋まった時の ToDo（プログラム。AI は使わない。docs/SPEC.md §1.11）。
// 承認待ちの仮押さえの時間に確定の予約が「同じ時間に受ける人数」だけ入ったら「○○（架空）様に別の日時を案内」を今日中として足す。
// どのタブでも動く（何も描かない）。同じ鍵（予約:お客様＠日時）がもうあれば足さない。仮押さえそのものは変えない。

import { useEffect } from "react";
import type { BookData } from "@/lib/book/data";
import { hasTodoKey, withTodo } from "@/lib/book/state";
import { useBook } from "@/lib/book/useBook";
import { candidateLabel } from "@/lib/ai/slots";
import { writeJournal } from "@/lib/journal";
import { fullSlotTodos } from "@/lib/todo/full";
import { todoKey } from "@/lib/todo/keys";

export function TodoFeeds({ data }: { data: BookData }) {
  const book = useBook(data);
  const { all, pending, state, update, today, nowIso } = book;

  useEffect(() => {
    const want = fullSlotTodos(all, pending, { seats: book.shop.seats, customers: data.customers, today: today.date, nowIso }).filter(
      (t) => !hasTodoKey(state, todoKey(t)),
    );
    if (want.length === 0) return;
    const added: string[] = [];
    update((s) =>
      want.reduce((acc, t) => {
        const next = withTodo(acc, t);
        if (next !== acc) {
          const r = pending.find((p) => `td-full-${p.reservation.id}` === t.id)?.reservation;
          added.push(`予約サイト（架空）で${r ? ` ${candidateLabel(data, r)} の` : ""}枠が埋まったので、ToDo に「${t.title}」（今日中）を足した（仮押さえはそのまま。決めるのは人）`);
        }
        return next;
      }, s),
    );
    if (added.length) writeJournal(...added.map((text) => ({ who: "プログラム" as const, text })));
  }, [all, pending, state, update, today.date, nowIso, data, book.shop.seats]);

  return null;
}
