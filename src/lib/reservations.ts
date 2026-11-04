// 予約を本当の日付に直し、台帳の形にまとめる。数はここ（プログラム）が出す。AI は数を作らない。

import { businessDays, toHHMM, toMinutes, weekFrom, type CalDay } from "./calendar";
import { getCustomers, getSeedReservations } from "./data/seed";
import type { Customer, ReservationStatus, SeedReservation } from "./data/types";
import type { Menu, ShopSettings } from "./settings";

export type Reservation = {
  id: string;
  date: string;
  day: number;
  start: string;
  end: string;
  startMin: number;
  endMin: number;
  status: ReservationStatus;
  menu: Menu;
  customer: Customer;
};

/** 最終受付。メニューに書いてなければ「閉店 − 所要時間」 */
export function lastStartOf(menu: Menu, close: string): string {
  return menu.lastStart ?? toHHMM(toMinutes(close) - menu.minutes);
}

/** 最初の状態の予約を、今日を起点にした本当の日付に直す */
export function resolveReservations(
  shop: ShopSettings,
  menus: Menu[],
  today: CalDay,
  seed: SeedReservation[] = getSeedReservations(),
  customers: Customer[] = getCustomers(),
): Reservation[] {
  const maxDay = seed.reduce((m, r) => Math.max(m, r.day), 0);
  const days = businessDays(shop, today, maxDay + 1);
  const out: Reservation[] = [];
  for (const r of seed) {
    const d = days[r.day];
    const menu = menus.find((m) => m.id === r.menuId);
    const customer = customers.find((c) => c.id === r.customerId);
    if (!d || !menu || !customer || r.day < 0) continue;
    const startMin = toMinutes(r.start);
    const endMin = startMin + menu.minutes;
    out.push({
      id: r.id,
      date: d.date,
      day: r.day,
      start: r.start,
      end: toHHMM(endMin),
      startMin,
      endMin,
      status: r.status,
      menu,
      customer,
    });
  }
  return out.sort((a, b) => (a.date === b.date ? a.startMin - b.startMin : a.date < b.date ? -1 : 1));
}

export type LedgerDay = CalDay & {
  isToday: boolean;
  reservations: Reservation[];
  /** 席 × 分 のうち、埋まっている分 */
  usedMinutes: number;
  capacityMinutes: number;
};

/** 今日から7日分の台帳 */
export function weekLedger(shop: ShopSettings, today: CalDay, all: Reservation[]): LedgerDay[] {
  return weekFrom(shop, today).map((d) => {
    const reservations = all.filter((r) => r.date === d.date);
    const capacityMinutes = d.hours ? shop.seats * (toMinutes(d.hours.close) - toMinutes(d.hours.open)) : 0;
    return {
      ...d,
      isToday: d.date === today.date,
      reservations,
      usedMinutes: reservations.reduce((s, r) => s + r.menu.minutes, 0),
      capacityMinutes,
    };
  });
}

export type CheckResult = { ok: boolean; problems: string[] };

/** 営業時間の中で、最終受付までに始まっているか */
export function checkHours(shop: ShopSettings, days: CalDay[], all: Reservation[]): CheckResult {
  const problems: string[] = [];
  for (const r of all) {
    const d = days.find((x) => x.date === r.date);
    if (!d?.hours) {
      problems.push(`${r.id}：お休みの日に入っています`);
      continue;
    }
    const open = toMinutes(d.hours.open);
    const close = toMinutes(d.hours.close);
    const last = toMinutes(lastStartOf(r.menu, d.hours.close));
    if (r.startMin < open) problems.push(`${d.label} ${r.start} ${r.menu.name}：開店より前です`);
    if (r.startMin > last) problems.push(`${d.label} ${r.start} ${r.menu.name}：最終受付（${toHHMM(last)}）を過ぎています`);
    if (r.endMin > close) problems.push(`${d.label} ${r.start} ${r.menu.name}：閉店（${d.hours.close}）までに終わりません`);
  }
  return { ok: problems.length === 0, problems };
}

/** どの時刻も、同時に入っている予約が席の数をこえていないか */
export function checkSeats(shop: ShopSettings, days: CalDay[], all: Reservation[]): CheckResult {
  const problems: string[] = [];
  for (const d of days) {
    const list = all.filter((r) => r.date === d.date);
    // 始まりの時刻ごとに、そのとき入っている数を数える（重なりの最大はどれかの始まりで起きる）
    for (const r of list) {
      const n = list.filter((x) => x.startMin <= r.startMin && r.startMin < x.endMin).length;
      if (n > shop.seats) {
        problems.push(`${d.label} ${r.start}：${n}件が重なっています（席は${shop.seats}つ）`);
        break;
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/** 画面で使う形にまとめて返す（今日・2週間分の予約・7日分の台帳・プログラムの確認） */
export function loadBook(shop: ShopSettings, menus: Menu[], today: CalDay) {
  const all = resolveReservations(shop, menus, today);
  const maxDay = all.reduce((m, r) => Math.max(m, r.day), 0);
  const days = businessDays(shop, today, maxDay + 1);
  return {
    all,
    week: weekLedger(shop, today, all),
    todayCount: all.filter((r) => r.date === today.date).length,
    checks: { hours: checkHours(shop, days, all), seats: checkSeats(shop, days, all) },
  };
}
