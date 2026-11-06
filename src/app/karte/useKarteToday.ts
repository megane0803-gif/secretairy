"use client";

// カルテのタブの真ん中と右の列が同じに使う：今日の予約のお客様（確定した物）と、選んでいる方。
// 何も選んでいなければ先頭の方を選んでおく。

import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";
import { deskKey, useDesk } from "@/lib/karte/deskStore";
import { savedOn } from "@/lib/karte/record";

/** 真ん中の「AI のカルテの案」のカードの id（スマホで案まで画面を動かす先・案へ飛ぶリンクの先） */
export const KARTE_DRAFT_ID = "karte-draft";

export function useKarteToday(data: BookData) {
  const book = useBook(data);
  const desk = useDesk();
  const todays = book.all.filter((r) => r.date === book.today.date && r.status === "confirmed");
  const selected = todays.find((r) => r.id === desk.selected) ?? todays[0] ?? null;
  const key = selected ? deskKey(selected.customer.id, book.today.date) : null;
  const saved = selected ? savedOn(book.state.kartes, selected.customer.id, book.today.date) : undefined;
  const draft = key ? desk.drafts[key] : undefined;
  const memo = key ? (saved?.memo ?? desk.memos[key] ?? "") : "";
  return { book, desk, todays, selected, key, saved, draft, memo };
}
