// 最初の状態（seed/*.json）を読む場所。画面のコードは seed/ を直接 import せず、ここを通す。
// ブラウザに残った変化を重ねるようにするときは、この関数の中身だけを差しかえる。

import customers from "@seed/customers.json";
import reservations from "@seed/reservations.json";
import ads from "@seed/ads.json";
import accounting from "@seed/accounting.json";
import todo from "@seed/todo.json";
import type { Ad, Customer, MoneyEntry, SeedReservation, Todo } from "./types";

export function getCustomers(): Customer[] {
  return customers as Customer[];
}

export function getSeedReservations(): SeedReservation[] {
  return reservations as SeedReservation[];
}

export function getAds(): Ad[] {
  return ads as Ad[];
}

export function getMoneyEntries(): MoneyEntry[] {
  return accounting as MoneyEntry[];
}

export function getTodos(): Todo[] {
  return todo as Todo[];
}
