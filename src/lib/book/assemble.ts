// 台帳を組み立てる1か所（画面の useBook・予約サイトと台帳から入れる・変える時の ledgerView・ホームの AI の仕事の bookView）。
// 最初の状態（seed/）を起点の日から本当の日付に直し → 人が直した分（取り消した・変えた。state.seedResEdits）を重ね →
// このブラウザに残した予約チャット・予約サイト・台帳から入れた分（期限の切れていない物）を足す。
// 週の表示・件数・空きの数え・サーバーへ送る台帳（予約チャット・LINE の一言・AI の仕事）は、みなここで組んだ物から。

import type { BookedRow } from "../ai/wire";
import type { CalDay } from "../calendar";
import type { Customer } from "../data/types";
import { loadBook, resolveChatReservations, seedAnchor, sortReservations, type Reservation } from "../reservations";
import type { Menu, ShopSettings } from "../settings";
import { activeChat, type BookState } from "./state";

/** サーバーへ送る台帳の1行 */
export const toRow = (r: Reservation): BookedRow => ({
  id: r.id,
  customerId: r.customer.id,
  menuId: r.menu.id,
  date: r.date,
  start: r.start,
  status: r.status,
  newCustomer: r.customer.firstVisit,
});

export function assembleBook(
  src: { shop: ShopSettings; menus: Menu[]; customers: Customer[] },
  state: BookState,
  today: CalDay,
  nowIso: string,
) {
  const anchor = seedAnchor(src.shop, state.anchor, today);
  const chat = resolveChatReservations(src.menus, src.customers, activeChat(state, nowIso));
  const book = loadBook(src.shop, src.menus, today, anchor, chat, state.seedResEdits);
  const all: Reservation[] = sortReservations(book.all);
  return { anchor, book, all, booked: all.map(toRow) };
}
