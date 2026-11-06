// デモの「翌日へ」1回の全部：台帳を1営業日進めて書く → 書けて進んだ時だけ、前日のお知らせ（決まった形・送らない）と日誌。
// 「翌日へ」を置く画面はみなここを通す（いまはホームの朝の要点。docs/SPEC.md §1.6）。テストも同じここを使う。
// 進む先の今日は、画面の台帳の店（休みの日も重ねた useBook の shop）で決める（休みの日も飛ばす。holidays.ts）。
// 進まない時：上限（MAX_DAY_OFFSET 営業日）に来た（cap）・ブラウザに書けなかった（write）。どちらも日誌・お知らせは作らない。

import { SAVE_FAILED_MESSAGE, type BrowserWrite } from "../browser";
import { addDays, calDay, demoClock, type CalDay } from "../calendar";
import type { JournalWho } from "../journal";
import { dayBeforeReminders, type Reminder } from "../reminder";
import type { Reservation } from "../reservations";
import type { ShopSettings } from "../settings";
import { LAST_DEMO_DAY, nextDayStep, type BookState } from "./state";

export type NextDayDeps = {
  /** 台帳を変えて書く（書けたかを返す。useBook の update） */
  update: (f: (s: BookState) => BookState) => BrowserWrite;
  journal: (...lines: { who: JournalWho; text: string }[]) => void;
};

export type NextDayInput = {
  shop: ShopSettings;
  /** いま（本当の時刻） */
  now: Date;
  /** 前日のお知らせに使う予約（画面の台帳の全部） */
  all: Reservation[];
  /** 前日のお知らせの決まった形（config/reminder.json の template） */
  template: string;
};

export type NextDayOutcome =
  | { moved: true; from: CalDay; to: CalDay; dayOffset: number; reminders: Reminder[]; sentLabel: string }
  | { moved: false; why: "cap" | "write"; message: string };

export function advanceDay(deps: NextDayDeps, input: NextDayInput): NextDayOutcome {
  let before = 0;
  let after = 0;
  let moved = false as boolean;
  const w = deps.update((s) => {
    const out = nextDayStep(s);
    before = s.dayOffset;
    after = out.state.dayOffset;
    moved = out.moved;
    return out.state;
  });
  if (!w.ok) return { moved: false, why: "write", message: SAVE_FAILED_MESSAGE };
  if (!moved) return { moved: false, why: "cap", message: LAST_DEMO_DAY };
  // 書いた後の台帳の日数から（別の窓で進めていても、書いた物とそろう）
  const from = demoClock(input.shop, input.now, before).today;
  const to = demoClock(input.shop, input.now, after).today;
  // その日（進めた先の今日）に確定の予約がある方へ、前日に届いたつもりのお知らせ（決まった形・AI なし・送らない）
  const reminders = dayBeforeReminders(input.all, to.date, input.template, input.shop.name);
  const sentLabel = calDay(input.shop, addDays(to.date, -1)).label;
  deps.journal(
    { who: "オーナー", text: `デモ：翌日へ（${from.label} → ${to.label}。定休日${input.shop.ownerHolidays?.length ? "と休みの日" : ""}は飛ばす）` },
    { who: "プログラム", text: `デモ：前日のお知らせを${reminders.length}件見せた（${to.label}のご予約。決まった形・実際には送信していない）` },
  );
  return { moved: true, from, to, dayOffset: after, reminders, sentLabel };
}

/**
 * 「翌日へ」の後に出す前日のお知らせで、画面が持つのは「どの日のお知らせか」だけ（作った時の予約の並びは持たない）。
 * 出す時に今の台帳から数え直す（remindersNow）。別のタブで予約を取り消した・変えた時も、今の台帳と合う。
 */
export type ReminderDay = { date: string; dayLabel: string; sentLabel: string };

export function reminderDay(out: Extract<NextDayOutcome, { moved: true }>): ReminderDay {
  return { date: out.to.date, dayLabel: out.to.label, sentLabel: out.sentLabel };
}

/** 今の台帳（画面の台帳の全部）から、その日の前日のお知らせを数え直す */
export function remindersNow(day: ReminderDay, all: Reservation[], template: string, shopName: string): Reminder[] {
  return dayBeforeReminders(all, day.date, template, shopName);
}
