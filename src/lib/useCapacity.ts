"use client";

// 画面で使う「同じ時間に受ける人数」。最初の状態（config/shop.json の seats）に、このブラウザで変えた分を重ねる。
// 書くのはこのブラウザの中だけ。変えたらすぐ、どの画面の次の判定・数え方にも効く（capacity.ts）。

import { useCallback, useSyncExternalStore } from "react";
import { readBrowser, subscribeBrowser, writeBrowser } from "./browser";
import { CAPACITY_KEY, capacityJournal, capacityRaw, clampSeats, parseCapacity, seatsRangeOf } from "./capacity";
import { writeJournal } from "./journal";
import { getShop } from "./settings";

const read = () => readBrowser(CAPACITY_KEY);

export function useCapacity() {
  const shop = getShop();
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  const seats = parseCapacity(raw, shop);
  const range = seatsRangeOf(shop);

  /** オーナーが変えた（日誌に1行）。幅の外は受けない */
  const setSeats = useCallback(
    (next: number) => {
      const v = clampSeats(next, seatsRangeOf(getShop()));
      const before = parseCapacity(read(), getShop());
      if (v === null || v === before) return;
      writeBrowser(CAPACITY_KEY, capacityRaw(v, getShop()));
      writeJournal({ who: "オーナー", text: capacityJournal(before, v) });
    },
    [],
  );

  return { seats, range, base: shop.seats, setSeats };
}
