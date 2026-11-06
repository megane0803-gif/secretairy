// 休みの日にする時、その日に入っていた予約（確定・仮押さえ）の扱い。形と変え方だけ（どこにも書かない）。書くのは休みの日の欄（HolidayPanel.tsx）。
// 予約は消さない。その予約のお客様に ToDo「○○（架空）様に別の日時を案内（11/12（木） 15:00 カットの代わり）」を足す（AI は使わない）。
// 休みの日そのものは台帳とは別の置き場所（holidays.ts の HOLIDAYS_KEY）。

import type { Reservation } from "../reservations";
import { rescheduleTodo } from "../todo/reschedule";
import { withTodo, type AddedTodo, type BookState } from "./state";

/**
 * 休みにする日の予約から、ToDo「○○（架空）様に別の日時を案内（11/12（木） 15:00 カットの代わり）」を作る。
 * 文・鍵・期限は「別の日時を案内」の1か所（todo/reschedule.ts）を通す（予約ごとに1件。どの予約の分か見分けられる）
 */
export function holidayTodos(list: Reservation[], nowIso: string, today?: string): AddedTodo[] {
  return [...list]
    .sort((a, b) => a.startMin - b.startMin)
    .map((r) =>
      rescheduleTodo({
        idPrefix: "td-hol",
        reservationId: r.id,
        surname: r.customer.surname,
        from: { id: r.id, customerId: r.customer.id, menuId: r.menu.id, date: r.date, start: r.start },
        nowIso,
        due: today,
      }),
    );
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
