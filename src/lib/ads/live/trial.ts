// だれでも試す窓口（/api/ads/live/try。直しU・docs/SPEC.md §1.7.8）で、番号から言葉を引く「最初の表」（サーバーの側だけ）。
// ブラウザからは種類（止める・外す・足す）と番号の2つだけを受け取り、言葉はここで作品の最初の表（seed/ads.json）から引く。
// ブラウザの表・印（止めた・足した・承認待ち）は信じない。足してよい番号は、直しR の足す案の確かめ（add.ts の checkAdd）を
// 最初の表で通る番号だけ（別に書かない）。

import type { AdReport } from "../../data/types";
import type { AdSettings } from "../../settings";
import { checkAdd } from "../add";
import { buildTable } from "../report";

export type TrialTable = {
  /** 止められる言葉（getAds().keywords の番号と言葉） */
  keywords: { no: number; text: string }[];
  /** 外せる・足せるかもしれない言葉（getAds().searchTerms の番号と言葉） */
  terms: { no: number; text: string }[];
  /** 最初の表で足す案の確かめ（売りの言葉・予約につながった・もう広告を出す言葉に無い）を通る番号 */
  addable: number[];
};

export function trialTable(report: AdReport, settings: Pick<AdSettings, "featuredMenus">, words: readonly string[]): TrialTable {
  const table = buildTable(report, settings);
  return {
    keywords: report.keywords.map((k) => ({ no: k.no, text: k.text })),
    terms: report.searchTerms.map((t) => ({ no: t.no, text: t.text })),
    addable: report.searchTerms.filter((t) => checkAdd(table, words, t.no).ok).map((t) => t.no),
  };
}
