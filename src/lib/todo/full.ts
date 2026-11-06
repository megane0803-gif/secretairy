// 予約サイトで枠が埋まった時の ToDo（プログラム。AI は使わない。docs/SPEC.md §1.11）。
// 承認待ちの仮押さえの時間に、確定の予約（予約サイトが受け取る物）が席の数だけ入って「×」になったら、
// その仮押さえはそのままでは確定できないので「○○様に別の日時を案内」を今日中として足す。
// 🔒 仮押さえそのものは変えない（外す・確定するのは人のボタン）。足すのは ToDo だけ。

import type { AddedTodo, PendingRow } from "../book/state";
import type { Customer } from "../data/types";
import type { Reservation } from "../reservations";
import { rescheduleTitle } from "../guestName";
import { reserveKey } from "./keys";

/** 仮押さえの時間（start〜end の分）に、確定の予約が席の数だけ重なる時があるか */
export function slotFull(all: Pick<Reservation, "id" | "date" | "startMin" | "endMin" | "status">[], hold: { id: string; date: string; startMin: number; endMin: number }, seats: number): boolean {
  const confirmed = all.filter((r) => r.status === "confirmed" && r.id !== hold.id && r.date === hold.date && r.startMin < hold.endMin && hold.startMin < r.endMin);
  const points = [hold.startMin, ...confirmed.map((r) => r.startMin).filter((m) => m > hold.startMin && m < hold.endMin)];
  return points.some((p) => confirmed.filter((r) => r.startMin <= p && p < r.endMin).length >= seats);
}

/** 枠が埋まった仮押さえごとに、足す ToDo（鍵は「予約:お客様＠日時」。直す・見送りと同じ鍵なので2回は入らない） */
export function fullSlotTodos(
  all: Reservation[],
  pending: PendingRow[],
  ctx: { seats: number; customers: Customer[]; today: string; nowIso: string },
): AddedTodo[] {
  const out: AddedTodo[] = [];
  for (const row of pending) {
    const r = row.reservation;
    const resolved = all.find((x) => x.id === r.id);
    if (!resolved || !slotFull(all, resolved, ctx.seats)) continue;
    const surname = ctx.customers.find((c) => c.id === r.customerId)?.surname ?? "お客";
    out.push({
      id: `td-full-${r.id}`,
      title: rescheduleTitle(surname),
      createdAt: ctx.nowIso,
      done: false,
      source: "reserve",
      key: reserveKey(r.customerId, r.date, r.start),
      due: ctx.today,
    });
  }
  return out;
}
