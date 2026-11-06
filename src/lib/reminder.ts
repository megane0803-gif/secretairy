// 前日のお知らせ（デモ）。ホームの「翌日へ」を押すと、その日に予約（確定）のあるお客様に
// 前日に届いたつもりのお知らせを、お客様のスマホの画面の形で見せる（docs/SPEC.md §1.6）。
// 文は決まった形（config/reminder.json の template）で、AI は使わない。日時とメニューはプログラムが台帳から入れる。
// 🔒 本当には送らない（LINE にも、どこにも送らない。画面に「デモ：実際には送信されません」と出す）。

import type { Reservation } from "./reservations";

export type Reminder = {
  reservationId: string;
  surname: string;
  /** 予約の日（YYYY-MM-DD） */
  date: string;
  start: string;
  menuName: string;
  /** お客様のスマホに届いたつもりの文 */
  text: string;
};

/** 決まった形の文に、時刻・メニュー・店の名前を入れる（知らない {…} は空にする） */
export function reminderText(template: string, v: { time: string; menu: string; shop: string }): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k === "time" ? v.time : k === "menu" ? v.menu : k === "shop" ? v.shop : ""));
}

/** その日の確定の予約（仮押さえは送らない）に、前日のお知らせを1通ずつ。時刻の順 */
export function dayBeforeReminders(all: Reservation[], date: string, template: string, shopName: string): Reminder[] {
  return all
    .filter((r) => r.date === date && r.status === "confirmed")
    .sort((a, b) => a.startMin - b.startMin)
    .map((r) => ({
      reservationId: r.id,
      surname: r.customer.surname,
      date: r.date,
      start: r.start,
      menuName: r.menu.name,
      text: reminderText(template, { time: r.start, menu: r.menu.name, shop: shopName }),
    }));
}
