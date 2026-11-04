// 空きと可否を、プログラムで出す所。予約チャットの道具・例文・テストがみな同じここを使う。
// 数（時刻・空き）はここが出す。AI は作らない・変えない。判定は judge.ts（ルールは strictest.ts を通る）。

import { addDays, calDay, toHHMM, toMinutes, type CalDay } from "../calendar";
import { partsOf, resolveMenu } from "../combo";
import { scopeTag } from "../rules/describe";
import { judge, type Verdict } from "../rules/judge";
import { expandMenuIds } from "../rules/strictest";
import type { Rule } from "../rules/types";
import type { Menu, ShopSettings } from "../settings";
import type { BookedRow, Candidate, Visit } from "./wire";

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
/** 候補は2つまで（日が複数のときも、日ごとに1つずつで2日分まで） */
export const MAX_CANDIDATES = 2;
/** 同じ日に2つ出すときは、この分より離す（「1時間以内」の2つは並べない） */
export const SAME_DAY_GAP_MINUTES = 60;

/** メニュー。設定に無い組み合わせ（cut+headspa）は時間を足して作る（combo.ts） */
export function menuOf(ctx: Pick<SlotContext, "menus">, id: string): Menu | undefined {
  return resolveMenu(ctx.menus, id);
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
    // 1回の来店で複数のメニューなら、中身を並べて渡す（時間は足され、どのメニューの最終受付・ルールも効く）
    booking: {
      date: c.date,
      start: c.start,
      menuIds: partsOf(ctx.menus, c.menuId),
      newCustomer: ctx.customer.firstVisit,
      customerId: ctx.customer.id,
    },
    now: ctx.now,
    hours: day.hours,
    seats: ctx.shop.seats,
    menus: ctx.menus,
    existing: ctx.booked.map((b) => ({
      date: b.date,
      start: b.start,
      menuIds: partsOf(ctx.menus, b.menuId),
      newCustomer: b.newCustomer,
      customerId: b.customerId,
    })),
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

/** 同じ日の候補どうしが近すぎないか（重ならず、1時間より離れている） */
function farEnough(ctx: SlotContext, picked: Candidate[], c: Candidate): boolean {
  const minutes = menuOf(ctx, c.menuId)?.minutes ?? 0;
  const gap = Math.max(SAME_DAY_GAP_MINUTES + 1, minutes);
  return picked.every((p) => p.date !== c.date || Math.abs(toMinutes(p.start) - toMinutes(c.start)) >= gap);
}

function countOut(excluded: Map<string, { ex: Exclusion; count: number }>, ex: Exclusion) {
  const cur = excluded.get(ex.key) ?? { ex, count: 0 };
  cur.count += 1;
  excluded.set(ex.key, cur);
}

const CLOSED_DAY: Exclusion = { key: "base:open-day", kind: "base", label: "営業日", reason: "お休みの日です" };

/**
 * 始める時刻を、希望の時刻（near）に近い順に並べる。同じ近さなら、希望の時刻より後の方を先に
 * （「午後」「夕方」と言われたのに、次の日の朝から出さないように）。near が無ければ開店からの順のまま。
 */
export function orderNear(starts: string[], near: string | undefined): string[] {
  if (!near) return starts;
  const n = toMinutes(near);
  return [...starts].sort((a, b) => {
    const da = Math.abs(toMinutes(a) - n);
    const db = Math.abs(toMinutes(b) - n);
    if (da !== db) return da - db;
    const la = toMinutes(a) >= n ? 0 : 1;
    const lb = toMinutes(b) >= n ? 0 : 1;
    if (la !== lb) return la - lb;
    return toMinutes(a) - toMinutes(b);
  });
}

/** 1日の中を順に見て、受けられる枠を出す（picked と近すぎる物は出さない）。near があれば、その時刻に近い順に見る */
function scanDay(
  ctx: SlotContext,
  menuId: string,
  day: CalDay,
  after: string | undefined,
  picked: Candidate[],
  limit: number,
  skip: Candidate[],
  excluded: Map<string, { ex: Exclusion; count: number }>,
  near?: string,
): Candidate[] {
  const out: Candidate[] = [];
  if (!day.open) {
    countOut(excluded, CLOSED_DAY);
    return out;
  }
  for (const start of orderNear(startsOf(ctx, day), near)) {
    if (out.length >= limit) break;
    if (after && start < after) continue;
    const c = { menuId, date: day.date, start };
    if (skip.some((s) => sameSlot(s, c))) continue;
    const v = judgeSlot(ctx, c);
    if (v.ok) {
      if (farEnough(ctx, [...picked, ...out], c)) out.push(c);
      continue;
    }
    const p = firstProblem(ctx, v);
    // まだ過ぎた時刻は数えない（外したとは言わない）
    if (!p || p.key === "base:future") continue;
    countOut(excluded, p);
  }
  // 近い順に見たときも、出すのは時刻の順
  return near ? out.sort((a, b) => toMinutes(a.start) - toMinutes(b.start)) : out;
}

/**
 * 受けられる枠を、from（日付・時刻）から先へ順に探す（count 個まで・SEARCH_DAYS 日まで）。
 * from.near（お客様が言った時刻）があれば、次の日からはその時刻に近い順に見る
 * （「火曜の午後」が定休日なら、水曜の朝ではなく水曜の午後から出す）。
 * 外した枠は、理由ごとに数えておく（AI の手順に「どのルールで外したか」を出すため）。
 */
export function findSlots(
  ctx: SlotContext,
  menuId: string,
  from: { date: string; time?: string; near?: string },
  count = MAX_CANDIDATES,
  skip: Candidate[] = [],
): SlotSearch {
  const slots: Candidate[] = [];
  const excluded = new Map<string, { ex: Exclusion; count: number }>();
  const startDate = from.date < ctx.today.date ? ctx.today.date : from.date;
  for (let i = 0; i < SEARCH_DAYS && slots.length < count; i++) {
    const day = calDay(ctx.shop, addDays(startDate, i));
    slots.push(
      ...scanDay(ctx, menuId, day, i === 0 ? from.time : undefined, slots, count - slots.length, skip, excluded, i === 0 ? undefined : from.near),
    );
  }
  return { slots, excluded: [...excluded.values()] };
}

/**
 * お客様が言った日（いくつか）で、日ごとに1つずつ探す（count 日分まで）。日の順に見て、空きのある日から出す。
 * 「11月の金曜」のような幅のある言い方は、当てはまる日を全部ここに渡す（daysInMonth）。
 */
export function findOnDays(
  ctx: SlotContext,
  menuId: string,
  dates: string[],
  after?: string,
  count = MAX_CANDIDATES,
  skip: Candidate[] = [],
): SlotSearch & { looked: string[] } {
  const slots: Candidate[] = [];
  const excluded = new Map<string, { ex: Exclusion; count: number }>();
  const looked = [...new Set(dates)].filter((d) => d >= ctx.today.date).sort();
  for (const date of looked) {
    if (slots.length >= count) break;
    slots.push(...scanDay(ctx, menuId, calDay(ctx.shop, date), after, slots, 1, skip, excluded));
  }
  return { slots, excluded: [...excluded.values()], looked };
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekdayKey = (typeof WEEKDAYS)[number];

/** その月（YYYY-MM）の、その曜日の日を全部（今日より前は入れない） */
export function daysInMonth(ctx: Pick<SlotContext, "today">, month: string, weekday?: WeekdayKey): string[] {
  const [y, m] = month.split("-").map(Number);
  const out: string[] = [];
  for (let d = 1; d <= 31; d++) {
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCMonth() !== m - 1) break;
    const iso = date.toISOString().slice(0, 10);
    if (iso < ctx.today.date) continue;
    if (weekday && WEEKDAYS[date.getUTCDay()] !== weekday) continue;
    out.push(iso);
  }
  return out;
}

/**
 * 組み合わせそのものが受けられないとき（「いっしょに受けない組み合わせ」のルール）、理由を1文で。受けられれば null。
 * 日時に関係なく断るので、空きを探す前に見る。
 */
export function comboRefusal(ctx: SlotContext, menuId: string): string | null {
  const mine = new Set(expandMenuIds(partsOf(ctx.menus, menuId), ctx.menus));
  for (const r of ctx.rules) {
    if (r.level !== "menu" || r.check.kind !== "notTogether") continue;
    if (mine.has(r.menuId) && mine.has(r.check.with))
      return `「${r.label}」という決まりがあるので、${menuName(ctx, r.menuId)}と${menuName(ctx, r.check.with)}をいっしょにはお受けできません。`;
  }
  return null;
}

/** 空きが1つも無かったときの理由（1文）。いちばん多く外した理由から */
export function noSlotSentence(search: SlotSearch): string {
  const top = [...search.excluded].filter((e) => e.ex.key !== "base:open-day").sort((a, b) => b.count - a.count)[0];
  if (!top) return "その日はお休み（定休日）なので、お受けできません。";
  switch (top.ex.key) {
    case "base:menu-last":
      return `最終受付に間に合う枠が無いので、お受けできません（${top.ex.reason}）。`;
    case "base:hours":
      return "営業時間の中に収まる枠が無いので、お受けできません。";
    case "base:seats":
      return "その日はもう埋まっているので、お受けできません。";
    default:
      return top.ex.kind === "rule"
        ? `「${top.ex.label.replace(/^\[[^\]]*\] /, "")}」という決まりがあるので、お受けできません。`
        : `お受けできません（${plainReason(top.ex.reason)}）。`;
  }
}

/** その日・その時刻のそばで、代わりの時間（2つまで）。次の日からは頼まれた時刻に近い順。頼まれた枠そのものは入れない */
export function alternativesFor(ctx: SlotContext, c: Candidate, skip: Candidate[] = []): SlotSearch {
  return findSlots(ctx, c.menuId, { date: c.date, time: c.start, near: c.start }, MAX_CANDIDATES, [c, ...skip]);
}

/**
 * その方の前回の来店。保存したカルテ（最初の状態の「前回までのカルテ」も含む）のうち、
 * 今日まででいちばん新しい物の日付とメニュー。カルテが無ければ null（「前回の記録なし」）。
 */
export function previousVisit(ctx: { visits: Visit[]; customer: { id: string }; today: CalDay }): Visit | null {
  const past = ctx.visits
    .filter((v) => v.customerId === ctx.customer.id && v.date <= ctx.today.date)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return past[0] ?? null;
}
