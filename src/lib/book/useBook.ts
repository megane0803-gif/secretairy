"use client";

// 画面で使う台帳。最初の状態（seed/）を起点の日から数えて本当の日付に直し、
// このブラウザに残した分（予約チャットの仮押さえ・確定・承認の箱・足した ToDo）を重ねる。
// 書くのはこのブラウザの中だけ（サーバーには送らない）。

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { BOOK_KEY, readBrowser, subscribeBrowser, type BrowserWrite } from "../browser";
import { demoClock, demoInstant, shopToday } from "../calendar";
import { allKartes, resolveSeedKartes, toVisits, withSeedKarteEdits } from "../karte/record";
import { withSeats } from "../capacity";
import { withHolidays } from "../holidays";
import { getShop, type ShopSettings } from "../settings";
import { useCapacity } from "../useCapacity";
import { useHolidays } from "../useHolidays";
import { useMenus } from "../useMenus";
import type { BookData } from "./data";
import { alignAnchor, updateBook } from "./store";
import { assembleBook } from "./assemble";
import { emptyBook, parseBook, pendingApprovals, type BookState } from "./state";

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

/** このブラウザの台帳の中身。まだ一度も開いていない・まだ何も触っていなければ、今日（このブラウザの時計・店の時間帯）を起点にして覚える */
export function useBookState() {
  const todayDate = shopToday(getShop()).today.date;
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  const stored = useMemo(() => parseBook(raw), [raw]);
  const state: BookState = stored ?? emptyBook(todayDate);

  useEffect(() => {
    // そのブラウザで初めて開いた日を起点として覚える。まだ何も触っていなければ、開いた日（今日）に起点をそろえる
    // （PC とスマホで最初の中身を同じにする。書けなかった時は今の起点のまま。docs/SPEC.md §5.1・store.ts の alignAnchor）
    alignAnchor(todayDate);
  }, [todayDate]);

  // 書く直前に読みなおす（別の窓で変えた分を消さないように）。書けたかどうかを返す（store.ts）
  const update = useCallback((f: (s: BookState) => BookState): BrowserWrite => updateBook(f, todayDate), [todayDate]);

  return { state, update };
}

/**
 * 画面で使う形：今日・起点・全部の予約・7日分・承認待ち・AI に送る台帳・カルテ。
 * shop は、店の設定に「同じ時間に受ける人数」（ルールのタブで変えた分）と「休みの日」（予約のページで決めた分）を重ねた物。
 * 数・受け付けるかの判定を使う所はみなこれを使う（最初の状態の予約の日付は休みの日を見ないので動かない。reservations.ts の seedAnchor）。
 * data.menus は、設定のメニューに「メニュー」の欄（ルールのタブ）で直した時間・値段・最終受付を重ねた物。メニューを読む所はみなこれを通す（menuEdits.ts）。
 */
export function useBook(data: BookData) {
  const minute = useMinute();
  const { seats } = useCapacity();
  const { dates: holidays } = useHolidays();
  const { menus, mark: menusMark } = useMenus();
  const shop: ShopSettings = useMemo(() => withHolidays(withSeats(data.shop, seats), holidays), [data.shop, seats, holidays]);
  const now = useMemo(() => new Date(minute * 60_000), [minute]);
  const { state, update } = useBookState();
  // デモの「翌日へ」で進めた分だけ、今日を先へずらす（サーバーも同じ決め方。calendar.ts の demoClock）。
  // 休みの日を重ねてから今日を決める（休みにした日が今日なら、次の営業日を今日にする）
  const clock = useMemo(() => demoClock(shop, now, state.dayOffset), [shop, now, state.dayOffset]);
  const { today, opened, shifted, realToday, dayOffset } = clock;
  const nowIso = now.toISOString();
  const nowShop = clock.now;

  const view = useMemo(() => {
    // 台帳を組み立てる1か所（book/assemble.ts。予約サイト・台帳から入れる・AI の仕事と同じ）
    const { anchor, book, all, booked } = assembleBook({ shop, menus, customers: data.customers }, state, today, nowIso);
    const kartes = allKartes(withSeedKarteEdits(resolveSeedKartes(data.seedKartes, all), state.seedKarteEdits), state.kartes);
    return { anchor, book, all, booked, kartes, visits: toVisits(kartes), pending: pendingApprovals(state, nowIso) };
  }, [data, shop, menus, state, today, nowIso]);
  const bookData: BookData = useMemo(() => (shop === data.shop && menus === data.menus ? data : { ...data, shop, menus }), [data, shop, menus]);

  return {
    ...view,
    shop,
    /** 店の設定に、同じ時間に受ける人数と休みの日を重ね、メニューに直した時間・値段・最終受付を重ねた BookData（AI の仕事・LINE などにそのまま渡す） */
    data: bookData,
    /** メニューの設定の印（直していなければ ""。予約チャットの返事を始めた時と比べる） */
    menusMark,
    state,
    update,
    today,
    opened,
    shifted,
    realToday,
    dayOffset,
    now: nowShop,
    nowIso,
    /** 「翌日へ」で進めた日付の時計（広告の「7日に1つ」を数える時。calendar.ts の demoInstant） */
    demoNowIso: demoInstant(shop, now, state.dayOffset).toISOString(),
  };
}
