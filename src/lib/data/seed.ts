// 最初の状態（seed/*.json）を読む場所。画面のコードは seed/ を直接 import せず、ここを通す。
// ブラウザに残った変化を重ねるようにするときは、この関数の中身だけを差しかえる。

import customers from "@seed/customers.json";
import reservations from "@seed/reservations.json";
import ads from "@seed/ads.json";
import accounting from "@seed/accounting.json";
import todo from "@seed/todo.json";
import kartes from "@seed/kartes.json";
import karteExamples from "@seed/karte-examples.json";
import postMemos from "@seed/post-memos.json";
import jobs from "@seed/jobs.json";
import type { AccountingSeed, AdReport, Customer, JobSeed, KarteExample, PostMemo, SeedKarte, SeedReservation, Todo } from "./types";

export function getCustomers(): Customer[] {
  return customers as Customer[];
}

export function getSeedReservations(): SeedReservation[] {
  return reservations as SeedReservation[];
}

/** 架空の広告の4週分（広告を出す言葉8つ・お客さんが調べた言葉8つ） */
export function getAds(): AdReport {
  return ads as AdReport;
}

/** 経理の最初の状態：架空の10月の売上・購入先・前の月までの自動のルール・未処理の通販の明細 */
export function getAccounting(): AccountingSeed {
  return accounting as AccountingSeed;
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

/** 発信の「お店のメモ」（架空・3つ）。下書きを作るときは全部 AI に渡す */
export function getPostMemos(): PostMemo[] {
  return postMemos as PostMemo[];
}

/** ホームの「AI の仕事」で、これから来る物（上から順に4行） */
export function getJobSeeds(): JobSeed[] {
  return jobs as JobSeed[];
}
