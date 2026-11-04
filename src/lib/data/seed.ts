// 最初の状態（seed/*.json）を読む場所。画面のコードは seed/ を直接 import せず、ここを通す。
// ブラウザに残った変化を重ねるようにするときは、この関数の中身だけを差しかえる。

import customers from "@seed/customers.json";
import reservations from "@seed/reservations.json";
import ads from "@seed/ads.json";
import accounting from "@seed/accounting.json";
import todo from "@seed/todo.json";
import kartes from "@seed/kartes.json";
import karteExamples from "@seed/karte-examples.json";
import type { Ad, Customer, KarteExample, MoneyEntry, SeedKarte, SeedReservation, Todo } from "./types";

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

/** 前回までのカルテ（最初の状態）。日付・メニューは予約（前回の来店）から取る */
export function getSeedKartes(): SeedKarte[] {
  return kartes as SeedKarte[];
}

/** カルテの「例文を入れる」（今日のお客様1人に1つ） */
export function getKarteExamples(): KarteExample[] {
  return karteExamples as KarteExample[];
}
