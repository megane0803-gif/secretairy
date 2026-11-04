// 空きと可否を、プログラムで出す所。予約チャットの道具・例文・テストがみな同じここを使う。
// 数（時刻・空き）はここが出す。AI は作らない・変えない。判定は judge.ts（ルールは strictest.ts を通る）。

import { addDays, calDay, toHHMM, toMinutes, type CalDay } from "../calendar";
import { scopeTag } from "../rules/describe";
import { judge, type Verdict } from "../rules/judge";
import type { Rule } from "../rules/types";
import type { Menu, ShopSettings } from "../settings";
import type { BookedRow, Candidate } from "./wire";

export type SlotContext = {
  shop: ShopSettings;
  menus: Menu[];
  /** 鍵つき＋オーナーのルール */
  rules: Rule[];
  booked: BookedRow[];
  customer: { id: string; surname: string; firstVisit: boolean };
  /** 店の時間帯での、いまの日付と時刻 */
  now: { date: string; time: string };
  today: CalDay;
};

/** 代わりを探す日数（カレンダーの日数） */
export const SEARCH_DAYS = 14;
/** 候補は2つまで */
export const MAX_CANDIDATES = 2;

export function menuOf(ctx: Pick<SlotContext, "menus">, id: string): Menu | undefined {
  return ctx.menus.find((m) => m.id === id);
}

export function menuName(ctx: Pick<SlotContext, "menus">, id: string): string {
  return menuOf(ctx, id)?.name ?? id;
}

/** 「11/6（金）15:00–16:00 カット」 */
export function candidateLabel(ctx: Pick<SlotContext, "shop" | "menus">, c: Candidate): string {
  const m = menuOf(ctx, c.menuId);
  const end = m ? `–${toHHMM(toMinutes(c.start) + m.minutes)}` : "";
  return `${calDay(ctx.shop, c.date).label} ${c.start}${end} ${m?.name ?? c.menuId}`;
}

export function sameSlot(a: Candidate, b: Candidate): boolean {
  return a.menuId === b.menuId && a.date === b.date && a.start === b.start;
}

/** その予約を受けてよいか（店の設定＋ルール）。台帳の予約（確定・仮押さえ）はどれも枠をふさぐ */
export function judgeSlot(ctx: SlotContext, c: Candidate): Verdict {
  const day = calDay(ctx.shop, c.date);
  return judge({
    rules: ctx.rules,
    booking: { date: c.date, start: c.start, menuIds: [c.menuId], newCustomer: ctx.customer.firstVisit },
    now: ctx.now,
    hours: day.hours,
    seats: ctx.shop.seats,
    menus: ctx.menus,
    existing: ctx.booked.map((b) => ({ date: b.date, start: b.start, menuIds: [b.menuId], newCustomer: b.newCustomer })),
    tab: "reservations",
  });
}

/** 外した理由の札。ルールなら「[どこに効くか] ルールの文」、店の設定ならその名前 */
export type Exclusion = { key: string; kind: "rule" | "base"; label: string; reason: string };

/** 受けられない理由のうち、最初の1つ（店の設定 → ルールの順） */
export function firstProblem(ctx: Pick<SlotContext, "menus">, v: Verdict): Exclusion | null {
  const b = v.base.find((x) => !x.ok);
  if (b) return { key: `base:${b.id}`, kind: "base", label: b.label, reason: b.reason };
  const r = v.results.find((x) => !x.ok);
  if (r)
    return {
      key: `rule:${r.rule.id}`,
      kind: "rule",
      label: `[${scopeTag(r.rule, (id) => menuName(ctx, id))}] ${r.rule.label}`,
      reason: r.reason,
    };
  return null;
}

/** 理由の最後のかっこ（「（24時間前まで）」など）を外す。1文の中でかっこが重ならないように */
export function plainReason(reason: string): string {
  return reason.replace(/（[^（）]*）$/, "");
}

/** 受けられない理由を1文で（お客様にそのまま伝えられる言葉） */
export function refusalSentence(ctx: Pick<SlotContext, "menus">, v: Verdict): string {
  const b = v.base.find((x) => !x.ok);
  if (b) {
    switch (b.id) {
      case "future":
        return "もう過ぎた時刻なので、お受けできません。";
      case "open-day":
        return "その日はお休み（定休日）なので、お受けできません。";
      case "hours":
        return `営業時間に収まらないので、お受けできません（${plainReason(b.reason)}）。`;
      case "menu-last":
        return `最終受付を過ぎるので、お受けできません（${b.reason}）。`;
      case "seats":
        return "その時間はもう埋まっているので、お受けできません。";
      default:
        return `お受けできません（${b.reason}）。`;
    }
  }
  const r = v.results.find((x) => !x.ok);
  if (r) return `「${r.rule.label}」という決まりがあるので、お受けできません（${plainReason(r.reason)}）。`;
  return "お受けできます。";
}

/** その日の、始められる時刻の並び（開店から、枠の長さごと） */
function startsOf(ctx: SlotContext, day: CalDay): string[] {
  if (!day.hours) return [];
  const out: string[] = [];
  const step = Math.max(5, ctx.shop.slotMinutes);
  for (let t = toMinutes(day.hours.open); t < toMinutes(day.hours.close); t += step) out.push(toHHMM(t));
  return out;
}

export type SlotSearch = {
  slots: Candidate[];
  /** 調べた中で外した枠の数（理由ごと） */
  excluded: { ex: Exclusion; count: number }[];
};

/**
 * 受けられる枠を、from（日付・時刻）から先へ順に探す（count 個まで・SEARCH_DAYS 日まで）。
 * 外した枠は、理由ごとに数えておく（AI の手順に「どのルールで外したか」を出すため）。
 */
export function findSlots(
  ctx: SlotContext,
  menuId: string,
  from: { date: string; time?: string },
  count = MAX_CANDIDATES,
  skip: Candidate[] = [],
): SlotSearch {
  const slots: Candidate[] = [];
  const excluded = new Map<string, { ex: Exclusion; count: number }>();
  const startDate = from.date < ctx.today.date ? ctx.today.date : from.date;
  for (let i = 0; i < SEARCH_DAYS && slots.length < count; i++) {
    const day = calDay(ctx.shop, addDays(startDate, i));
    if (!day.open) {
      const key = "base:open-day";
      const cur = excluded.get(key) ?? { ex: { key, kind: "base", label: "営業日", reason: "お休みの日です" }, count: 0 };
      cur.count += 1;
      excluded.set(key, cur);
      continue;
    }
    for (const start of startsOf(ctx, day)) {
      if (slots.length >= count) break;
      if (i === 0 && from.time && start < from.time) continue;
      const c = { menuId, date: day.date, start };
      if (skip.some((s) => sameSlot(s, c))) continue;
      const v = judgeSlot(ctx, c);
      if (v.ok) {
        slots.push(c);
        continue;
      }
      const p = firstProblem(ctx, v);
      // まだ過ぎた時刻は数えない（外したとは言わない）
      if (!p || p.key === "base:future") continue;
      const cur = excluded.get(p.key) ?? { ex: p, count: 0 };
      cur.count += 1;
      excluded.set(p.key, cur);
    }
  }
  return { slots, excluded: [...excluded.values()] };
}

/** その日・その時刻のそばで、代わりの時間（2つまで）。頼まれた枠そのものは入れない */
export function alternativesFor(ctx: SlotContext, c: Candidate): SlotSearch {
  return findSlots(ctx, c.menuId, { date: c.date, time: c.start }, MAX_CANDIDATES, [c]);
}

/** その方の前回の来店（今日より前の確定の予約のうち、いちばん新しい物） */
export function previousVisit(ctx: SlotContext): BookedRow | null {
  const past = ctx.booked
    .filter((b) => b.customerId === ctx.customer.id && b.status === "confirmed" && b.date < ctx.today.date)
    .sort((a, b) => (a.date === b.date ? (a.start < b.start ? 1 : -1) : a.date < b.date ? 1 : -1));
  return past[0] ?? null;
}
