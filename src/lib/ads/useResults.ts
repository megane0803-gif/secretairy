"use client";

// 画面で使う「効いたかの判定」。判定日（「翌日へ」も入れた今日）が来た言葉を判定する（AdsFeeds.tsx。どのタブでも）か、
// 「判定日まで進める（デモ）」で、いちばん早い判定日の言葉を今すぐ判定する（広告タブ）。
// 判定・ToDo の済み・日誌は同じ1回で、書く直前に読みなおした物で変える（verdict.ts の withJudged）。

import { useCallback } from "react";
import { useBookState, useMinute } from "../book/useBook";
import { demoClock } from "../calendar";
import { writeJournal, type JournalWho } from "../journal";
import { getShop } from "../settings";
import type { AdApplied, AdsState } from "./state";
import type { BookState } from "../book/state";
import { useAds } from "./useAds";
import { dueToJudge, waitingJudge, withJudged } from "./verdict";

type Picker = (ads: AdsState, book: BookState, today: string) => { applied: AdApplied; due: string }[];

export function useAdResults() {
  const ads = useAds();
  const book = useBookState();
  const minute = useMinute();
  const shop = getShop();
  const today = demoClock(shop, new Date(minute * 60_000), book.state.dayOffset).today.date;
  const waiting = waitingJudge(ads.state, book.state, shop, ads.settings);
  const due = waiting.filter((w) => w.due <= today);

  const { update: updateAds, settings, report } = ads;
  const { update: updateBook } = book;

  const judge = useCallback(
    (pick: Picker, demo: boolean): number => {
      const nowIso = new Date().toISOString();
      let journal: { who: JournalWho; text: string }[] = [];
      let made = 0;
      updateAds((a) => {
        let next = a;
        updateBook((b) => {
          const t = demoClock(shop, new Date(), b.dayOffset).today.date;
          const out = withJudged(a, b, report, pick(a, b, t), { nowIso, demo, settings });
          next = out.ads;
          journal = out.journal;
          made = out.made.length;
          return out.book;
        });
        return next;
      });
      writeJournal(...journal);
      return made;
    },
    [updateAds, updateBook, shop, report, settings],
  );

  /** 判定日が来た物を全部判定する（プログラム。人のボタンではないが、何も止めも戻しもしない） */
  const judgeDue = useCallback(() => judge((a, b, t) => dueToJudge(a, b, { shop, today: t, settings }), false), [judge, shop, settings]);

  /** 「判定日まで進める（デモ）」：いちばん早い判定日の言葉を1つ、判定日まで進めたことにして判定する */
  const judgeNextDemo = useCallback(() => judge((a, b) => waitingJudge(a, b, shop, settings).slice(0, 1), true), [judge, shop, settings]);

  return { ads, book, shop, today, waiting, due, judgeDue, judgeNextDemo };
}
