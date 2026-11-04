"use client";

// 画面で使う台帳。最初の状態（seed/）を起点の日から数えて本当の日付に直し、
// このブラウザに残した分（予約チャットの仮押さえ・確定・承認の箱・足した ToDo）を重ねる。
// 書くのはこのブラウザの中だけ（サーバーには送らない）。

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { BookedRow } from "../ai/wire";
import { BOOK_KEY, readBrowser, subscribeBrowser, writeBrowser } from "../browser";
import { calDay, demoClock, shopToday } from "../calendar";
import { allKartes, resolveSeedKartes, toVisits, withSeedKarteEdits } from "../karte/record";
import {
  loadBook,
  resolveChatReservations,
  sortReservations,
  type Reservation,
} from "../reservations";
import { withSeats } from "../capacity";
import { getShop, type ShopSettings } from "../settings";
import { useCapacity } from "../useCapacity";
import type { BookData } from "./data";
import { activeChat, emptyBook, parseBook, pendingApprovals, type BookState } from "./state";

const read = () => readBrowser(BOOK_KEY);

/** 1分ごとに変わる「いま」（仮押さえの期限・今日の切りかわりのため） */
export function useMinute(): number {
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

/**
 * 画面で使う形：今日・起点・全部の予約・7日分・承認待ち・AI に送る台帳・カルテ。
 * shop は、店の設定に「同じ時間に受ける人数」（ルールのタブで変えた分）を重ねた物。数を使う所はみなこれを使う。
 */
export function useBook(data: BookData) {
  const minute = useMinute();
  const { seats } = useCapacity();
  const shop: ShopSettings = useMemo(() => withSeats(data.shop, seats), [data.shop, seats]);
  const now = useMemo(() => new Date(minute * 60_000), [minute]);
  const { state, update } = useBookState();
  // デモの「翌日へ」で進めた分だけ、今日を先へずらす（サーバーも同じ決め方。calendar.ts の demoClock）
  const clock = useMemo(() => demoClock(data.shop, now, state.dayOffset), [data.shop, now, state.dayOffset]);
  const { today, opened, shifted, realToday, dayOffset } = clock;
  const nowIso = now.toISOString();
  const nowShop = clock.now;

  const view = useMemo(() => {
    const anchor = calDay(data.shop, state.anchor);
    const chat = resolveChatReservations(data.menus, data.customers, activeChat(state, nowIso));
    const book = loadBook(shop, data.menus, today, anchor.open ? anchor : today, chat);
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
    const kartes = allKartes(withSeedKarteEdits(resolveSeedKartes(data.seedKartes, all), state.seedKarteEdits), state.kartes);
    return { anchor, book, all, booked, kartes, visits: toVisits(kartes), pending: pendingApprovals(state, nowIso) };
  }, [data, shop, state, today, nowIso]);

  return {
    ...view,
    shop,
    /** 店の設定に、同じ時間に受ける人数を重ねた BookData（AI の仕事・LINE などにそのまま渡す） */
    data: shop === data.shop ? data : { ...data, shop },
    state,
    update,
    today,
    opened,
    shifted,
    realToday,
    dayOffset,
    now: nowShop,
    nowIso,
  };
}
