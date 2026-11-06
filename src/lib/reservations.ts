// 予約を本当の日付に直し、台帳の形にまとめる。数はここ（プログラム）が出す。AI は数を作らない。
//
// 最初の状態（seed/reservations.json）は「何番目の営業日」で持つ。それを「起点の日」から数えて本当の日付に直す。
// 起点は、そのブラウザで初めて開いた日（book/state.ts）。「最初に戻す」を押すと今日を起点に作り直す。
// 予約チャットで入った仮押さえ・確定は、本当の日付のままブラウザに残る（book/state.ts の extra）。

import { businessDayAt, calDay, lastStartOf, toHHMM, toMinutes, weekFrom, type CalDay } from "./calendar";
import { resolveMenu } from "./combo";
import { getCustomers, getSeedReservations } from "./data/seed";
import { baseShop } from "./holidays";
import type { Customer, ReservationStatus, SeedReservation } from "./data/types";
import type { Booked } from "./rules/judge";
import type { Menu, ShopSettings } from "./settings";

export type Reservation = {
  id: string;
  date: string;
  start: string;
  end: string;
  startMin: number;
  endMin: number;
  status: ReservationStatus;
  menu: Menu;
  customer: Customer;
  /** seed = 最初の状態（店が受けて確定した予約）/ chat = 予約チャットから入った物 / site = 予約サイト（架空）から入った物 / owner = オーナーが台帳から入れた物 */
  source: "seed" | "chat" | "site" | "owner";
};

/** 予約チャットから入った予約（本当の日付で持つ）。ブラウザの中だけに残す */
export type ChatReservation = {
  id: string;
  customerId: string;
  menuId: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM */
  start: string;
  status: ReservationStatus;
  /** 仮押さえした時刻（ISO） */
  heldAt: string;
  /** 仮押さえの期限（ISO）。確定した物には使わない */
  expiresAt: string;
  /**
   * site = 予約サイト（架空）から入った予約（お客様が自分で決めたので、承認の箱は通さずに確定で入る。book/site.ts）
   * owner = オーナーが台帳から入れた予約（電話・店頭で受けた物。人のボタンで確定。book/owner.ts）
   */
  via?: "site" | "owner";
};

export { lastStartOf };

function make(
  id: string,
  date: string,
  start: string,
  status: ReservationStatus,
  menu: Menu,
  customer: Customer,
  source: Reservation["source"],
): Reservation {
  const startMin = toMinutes(start);
  const endMin = startMin + menu.minutes;
  return { id, date, start, end: toHHMM(endMin), startMin, endMin, status, menu, customer, source };
}

export function sortReservations(list: Reservation[]): Reservation[] {
  return [...list].sort((a, b) => (a.date === b.date ? a.startMin - b.startMin : a.date < b.date ? -1 : 1));
}

/**
 * 最初の状態を数える起点（その日がお休みなら今日）。オーナーの休みの日は見ない（休みにしても起点・今ある予約の日付を動かさない）。
 * 台帳を組み立てる所（useBook・予約サイト・AI の仕事）はみなここを通す。
 */
export function seedAnchor(shop: ShopSettings, anchorDate: string, today: CalDay): CalDay {
  const a = calDay(baseShop(shop), anchorDate);
  return a.open ? a : today;
}

/**
 * 最初の状態の予約を、起点の日から数えた本当の日付に直す（負の数の日は、起点より前の営業日）。
 * 数えるのは、オーナーの休みの日を外した店（holidays.ts の baseShop）。休みの日を足しても、今ある予約の日付は動かない。
 */
export function resolveReservations(
  shop: ShopSettings,
  menus: Menu[],
  anchor: CalDay,
  seed: SeedReservation[] = getSeedReservations(),
  customers: Customer[] = getCustomers(),
): Reservation[] {
  const base = baseShop(shop);
  const dayCache = new Map<number, CalDay | null>();
  const dayOf = (n: number) => {
    if (!dayCache.has(n)) dayCache.set(n, businessDayAt(base, anchor, n));
    return dayCache.get(n) ?? null;
  };
  const out: Reservation[] = [];
  for (const r of seed) {
    const d = dayOf(r.day);
    const menu = menus.find((m) => m.id === r.menuId);
    const customer = customers.find((c) => c.id === r.customerId);
    if (!d || !menu || !customer) continue;
    out.push(make(r.id, d.date, r.start, r.status, menu, customer, "seed"));
  }
  return sortReservations(out);
}

/** 予約チャット（と予約サイト（架空））から入った予約を、台帳の形にする */
export function resolveChatReservations(menus: Menu[], customers: Customer[], list: ChatReservation[]): Reservation[] {
  const out: Reservation[] = [];
  for (const r of list) {
    // 1回の来店で複数のメニュー（cut+headspa）も、時間を足した1つのメニューにする
    const menu = resolveMenu(menus, r.menuId);
    const customer = customers.find((c) => c.id === r.customerId);
    if (!menu || !customer) continue;
    out.push(make(r.id, r.date, r.start, r.status, menu, customer, r.via === "site" ? "site" : r.via === "owner" ? "owner" : "chat"));
  }
  return out;
}

/** 判定（judge.ts）に渡す形。確定・仮押さえのどちらも枠はふさがっている */
export function toBooked(r: Reservation): Booked {
  return {
    date: r.date,
    start: r.start,
    menuIds: "parts" in r.menu && Array.isArray(r.menu.parts) ? (r.menu.parts as string[]) : [r.menu.id],
    newCustomer: r.customer.firstVisit,
    customerId: r.customer.id,
  };
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
export function checkHours(shop: ShopSettings, all: Reservation[]): CheckResult {
  const problems: string[] = [];
  for (const r of all) {
    const d = calDay(shop, r.date);
    if (!d.hours) {
      problems.push(`${d.label} ${r.start} ${r.menu.name}：お休みの日に入っています`);
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
export function checkSeats(shop: ShopSettings, all: Reservation[]): CheckResult {
  const problems: string[] = [];
  const dates = [...new Set(all.map((r) => r.date))].sort();
  for (const date of dates) {
    const list = all.filter((r) => r.date === date);
    // 始まりの時刻ごとに、そのとき入っている数を数える（重なりの最大はどれかの始まりで起きる）
    for (const r of list) {
      const n = list.filter((x) => x.startMin <= r.startMin && r.startMin < x.endMin).length;
      if (n > shop.seats) {
        problems.push(`${calDay(shop, date).label} ${r.start}：${n}件が重なっています（同じ時間に受けるのは${shop.seats}人まで）`);
        break;
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * 画面で使う形にまとめて返す（全部の予約・7日分の台帳・今日の件数・プログラムの確認）。
 * anchor は最初の状態を数える起点（ふつうはそのブラウザで初めて開いた日）、chat は予約チャットから入った分。
 */
export function loadBook(
  shop: ShopSettings,
  menus: Menu[],
  today: CalDay,
  anchor: CalDay = today,
  chat: Reservation[] = [],
) {
  const all = sortReservations([...resolveReservations(shop, menus, anchor), ...chat]);
  const ahead = all.filter((r) => r.date >= today.date);
  return {
    all,
    ahead,
    week: weekLedger(shop, today, all),
    todayCount: all.filter((r) => r.date === today.date).length,
    checks: { hours: checkHours(shop, ahead), seats: checkSeats(shop, ahead) },
  };
}

export type FreeRange = { start: string; end: string; free: number };

/**
 * その日の席の空き（枠の長さごと）。同じ空きの数が続く所は1つにまとめる。満席の所は入れない。
 * from（HH:MM）があれば、それより前に始まる枠は数えない（もう過ぎた時間）。
 * ルール（何分前まで・間を空ける など）は見ない。受けられるかは予約チャット（judge.ts）で確かめる。
 */
export function freeRanges(
  shop: ShopSettings,
  day: CalDay,
  reservations: Reservation[],
  from?: string,
): { ranges: FreeRange[]; seatSlots: number } {
  if (!day.hours) return { ranges: [], seatSlots: 0 };
  const step = Math.max(5, shop.slotMinutes);
  const list = reservations.filter((r) => r.date === day.date);
  const ranges: FreeRange[] = [];
  let seatSlots = 0;
  for (let t = toMinutes(day.hours.open); t + step <= toMinutes(day.hours.close); t += step) {
    if (from && toHHMM(t) < from) continue;
    const used = list.filter((r) => r.startMin < t + step && t < r.endMin).length;
    const free = Math.max(0, shop.seats - used);
    seatSlots += free;
    const last = ranges[ranges.length - 1];
    if (free === 0) continue;
    if (last && last.end === toHHMM(t) && last.free === free) last.end = toHHMM(t + step);
    else ranges.push({ start: toHHMM(t), end: toHHMM(t + step), free });
  }
  return { ranges, seatSlots };
}
