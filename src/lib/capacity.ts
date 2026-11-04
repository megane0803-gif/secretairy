// 同じ時間に受ける人数（前は「席の数」。設定の shop.seats）。
// 最初の状態は config/shop.json の seats（この店は1人で営業するので 1）。オーナーがルールのタブで seatsRange の幅（1〜3）の中で変えられる。
// 変えた分はこのブラウザの中だけ（secretairy:capacity）。「最初に戻す」で設定の数に戻る。
// 予約チャット・台帳・予約サイト・朝の要点・発信の空き枠・AI の仕事・LINE は、どれも withSeats で重ねた同じ1つの数を使う。
// 予約チャットと LINE の窓口（サーバー）には、画面がこの数を毎回送る（サーバーでも幅を確かめなおす）。

import type { ShopSettings } from "./settings";

/** ブラウザの中の置き場所（browser.ts の PREFIX の後ろ） */
export const CAPACITY_KEY = "capacity";

export type SeatsRange = { min: number; max: number };

/** 選べる幅。設定に無ければ 1〜設定の数 */
export function seatsRangeOf(shop: Pick<ShopSettings, "seats" | "seatsRange">): SeatsRange {
  const r = shop.seatsRange;
  if (r && Number.isInteger(r.min) && Number.isInteger(r.max) && r.min >= 1 && r.max >= r.min) return r;
  return { min: 1, max: Math.max(1, shop.seats) };
}

/** 幅の中の整数なら、その数。ちがえば null */
export function clampSeats(x: unknown, range: SeatsRange): number | null {
  return typeof x === "number" && Number.isInteger(x) && x >= range.min && x <= range.max ? x : null;
}

/** ブラウザに残した数を読む（形がおかしい・幅の外なら設定の数） */
export function parseCapacity(raw: string | null, shop: Pick<ShopSettings, "seats" | "seatsRange">): number {
  if (raw) {
    try {
      const v = clampSeats((JSON.parse(raw) as { seats?: unknown })?.seats, seatsRangeOf(shop));
      if (v !== null) return v;
    } catch {
      // 読めなければ設定の数
    }
  }
  return shop.seats;
}

/** ブラウザに書く形。設定の数と同じなら消す（null） */
export function capacityRaw(seats: number, shop: Pick<ShopSettings, "seats">): string | null {
  return seats === shop.seats ? null : JSON.stringify({ seats });
}

/** 店の設定に、同じ時間に受ける人数を重ねる（幅の外・無い時は設定のまま） */
export function withSeats<T extends Pick<ShopSettings, "seats" | "seatsRange">>(shop: T, seats: number | null | undefined): T {
  const v = clampSeats(seats, seatsRangeOf(shop));
  return v === null || v === shop.seats ? shop : { ...shop, seats: v };
}

/** 日誌の1行 */
export function capacityJournal(before: number, after: number): string {
  return `同じ時間に受ける人数を ${before}人 から ${after}人 にした（予約チャット・台帳・予約サイト・空き枠・AI の仕事に、次からすぐ効く）`;
}
