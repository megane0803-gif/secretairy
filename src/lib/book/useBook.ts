"use client";

// 画面で使う台帳。最初の状態（seed/）を起点の日から数えて本当の日付に直し、
// このブラウザに残した分（予約チャットの仮押さえ・確定・承認の箱・足した ToDo）を重ねる。
// 書くのはこのブラウザの中だけ（サーバーには送らない）。

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { BookedRow } from "../ai/wire";
import { BOOK_KEY, readBrowser, subscribeBrowser, writeBrowser } from "../browser";
import { calDay, shopNow, shopToday } from "../calendar";
import {
  loadBook,
  resolveChatReservations,
  sortReservations,
  type Reservation,
} from "../reservations";
import { getShop } from "../settings";
import type { BookData } from "./data";
import { activeChat, emptyBook, parseBook, pendingApprovals, type BookState } from "./state";

const read = () => readBrowser(BOOK_KEY);

/** 1分ごとに変わる「いま」（仮押さえの期限・今日の切りかわりのため） */
function useMinute(): number {
  const sub = useCallback((f: () => void) => {
    const t = window.setInterval(f, 60_000);
    return () => window.clearInterval(t);
  }, []);
  return useSyncExternalStore(
    sub,
    () => Math.floor(Date.now() / 60_000),
    () => Math.floor(Date.now() / 60_000),
  );
}

/** このブラウザの台帳の中身。まだ一度も開いていなければ、今日（このブラウザの時計・店の時間帯）を起点にして覚える */
export function useBookState() {
  const todayDate = shopToday(getShop()).today.date;
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  const stored = useMemo(() => parseBook(raw), [raw]);
  const state: BookState = stored ?? emptyBook(todayDate);

  useEffect(() => {
    // そのブラウザで初めて開いた日を起点として覚える（docs/SPEC.md §5.1）
    if (!parseBook(read())) writeBrowser(BOOK_KEY, JSON.stringify(emptyBook(todayDate)));
  }, [todayDate]);

  const update = useCallback(
    (f: (s: BookState) => BookState) => {
      // 書く直前に読みなおす（別の窓で変えた分を消さないように）
      const cur = parseBook(read()) ?? emptyBook(todayDate);
      writeBrowser(BOOK_KEY, JSON.stringify(f(cur)));
    },
    [todayDate],
  );

  return { state, update };
}

/** 画面で使う形：今日・起点・全部の予約・7日分・承認待ち・AI に送る台帳 */
export function useBook(data: BookData) {
  const minute = useMinute();
  const now = useMemo(() => new Date(minute * 60_000), [minute]);
  const { today, opened, shifted } = useMemo(() => shopToday(data.shop, now), [data.shop, now]);
  const { state, update } = useBookState();
  const nowIso = now.toISOString();
  const nowShop = useMemo(() => shopNow(data.shop, now), [data.shop, now]);

  const view = useMemo(() => {
    const anchor = calDay(data.shop, state.anchor);
    const chat = resolveChatReservations(data.menus, data.customers, activeChat(state, nowIso));
    const book = loadBook(data.shop, data.menus, today, anchor.open ? anchor : today, chat);
    const all: Reservation[] = sortReservations(book.all);
    const booked: BookedRow[] = all.map((r) => ({
      id: r.id,
      customerId: r.customer.id,
      menuId: r.menu.id,
      date: r.date,
      start: r.start,
      status: r.status,
      newCustomer: r.customer.firstVisit,
    }));
    return { anchor, book, all, booked, pending: pendingApprovals(state, nowIso) };
  }, [data, state, today, nowIso]);

  return {
    ...view,
    state,
    update,
    today,
    opened,
    shifted,
    now: nowShop,
    nowIso,
  };
}
