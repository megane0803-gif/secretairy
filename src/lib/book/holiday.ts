// 休みの日にする時、その日に入っていた予約（確定・仮押さえ）の扱い。形と変え方だけ（どこにも書かない）。書くのは休みの日の欄（HolidayPanel.tsx）。
// 予約は消さない。お客様ごとに ToDo「○○（架空）様に別の日時を案内（11/12（木） 15:00 カットの分）」を足す（AI は使わない）。
// 休みの日そのものは台帳とは別の置き場所（holidays.ts の HOLIDAYS_KEY）。

import { calDay } from "../calendar";
import type { Reservation } from "../reservations";
import type { ShopSettings } from "../settings";
import { reserveKey } from "../todo/keys";
import { withTodo, type AddedTodo, type BookState } from "./state";

/** 休みにする日の予約から、お客様ごとの ToDo を作る（同じ方が2件あれば1つにまとめる） */
export function holidayTodos(shop: ShopSettings, list: Reservation[], nowIso: string, today?: string): AddedTodo[] {
  const byCustomer = new Map<string, Reservation[]>();
  for (const r of [...list].sort((a, b) => a.startMin - b.startMin)) byCustomer.set(r.customer.id, [...(byCustomer.get(r.customer.id) ?? []), r]);
  return [...byCustomer.values()].map((rs) => {
    const first = rs[0];
    const label = calDay(shop, first.date).label;
    const what = rs.map((r) => `${r.start} ${r.menu.name}`).join("・");
    return {
      id: `td-hol-${first.date}-${first.customer.id}`,
      title: `${first.customer.surname}（架空）様に別の日時を案内（${label} ${what}の分）`,
      createdAt: nowIso,
      done: false,
      source: "reserve",
      key: reserveKey(first.customer.id, first.date, first.start),
      ...(today ? { due: today } : {}),
    };
  });
}

/** ToDo を足す（同じ鍵の物がもうあれば足さない）。足した題を返す */
export function withHolidayTodos(s: BookState, todos: AddedTodo[]): { state: BookState; added: string[] } {
  let next = s;
  const added: string[] = [];
  for (const t of todos) {
    const after = withTodo(next, t);
    if (after !== next) added.push(t.title);
    next = after;
  }
  return { state: next, added };
}
