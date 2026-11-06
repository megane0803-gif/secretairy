// 空きと可否を、プログラムで出す所。予約チャットの道具・例文・テストがみな同じここを使う。
// 数（時刻・空き）はここが出す。AI は作らない・変えない。判定は judge.ts（ルールは strictest.ts を通る）。

import { addDays, calDay, toHHMM, toMinutes, type CalDay } from "../calendar";
import { comboIdOf, partsOf, resolveMenu } from "../combo";
import { scopeTag } from "../rules/describe";
import { HOLIDAY_REASON, judge, type Verdict } from "../rules/judge";
import { expandMenuIds } from "../rules/strictest";
import { baseSay, CLOSED_DAY_SAY, COMBO_REFUSAL, comboSay, INTERNAL_REFUSAL, plainReason, ruleSay, tellsRule } from "../rules/tellable";
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
    holiday: !!day.holiday,
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

export { plainReason };

/**
 * 外した理由の札。ルールなら「[どこに効くか] ルールの文」、店の設定ならその名前（AI の手順・日誌に出す。お客様には出さない）。
 * tell = お客様に理由を伝えてよいか（rules/tellable.ts）。say = 伝えてよいときの、お客様への決まった1文
 */
export type Exclusion = {
  key: string;
  kind: "rule" | "base";
  label: string;
  reason: string;
  tell: boolean;
  say?: string;
};

/** 受けられない理由を全部（店の設定 → ルールの順） */
export function problems(ctx: Pick<SlotContext, "menus">, v: Verdict): Exclusion[] {
  const name = (id: string) => menuName(ctx, id);
  return [
    ...v.base
      .filter((x) => !x.ok)
      .map((b): Exclusion => {
        const say = baseSay(b.id, b.reason);
        return { key: `base:${b.id}`, kind: "base", label: b.label, reason: b.reason, tell: say !== null, ...(say ? { say } : {}) };
      }),
    ...v.results
      .filter((x) => !x.ok)
      .map((r): Exclusion => {
        const tell = tellsRule(r.rule);
        return {
          key: `rule:${r.rule.id}`,
          kind: "rule",
          label: `[${scopeTag(r.rule, name)}] ${r.rule.label}`,
          reason: r.reason,
          tell,
          ...(tell ? { say: ruleSay(r.rule) } : {}),
        };
      }),
  ];
}

/** 受けられない理由のうち、最初の1つ（店の設定 → ルールの順） */
export function firstProblem(ctx: Pick<SlotContext, "menus">, v: Verdict): Exclusion | null {
  return problems(ctx, v)[0] ?? null;
}

/**
 * お客様への断りの1文。tell = 理由を伝えてよいか。
 * 伝えてよい理由が1つでもあれば、その最初の1つの決まった文（表の文）。
 * 伝えてよい理由が無ければ「その時間はお受けできません。」だけ（伝えない理由の中身は入れない）。
 */
export type Refusal = { text: string; tell: boolean };

export function refusalOf(ctx: Pick<SlotContext, "menus">, v: Verdict): Refusal {
  const all = problems(ctx, v);
  if (all.length === 0) return { text: "お受けできます。", tell: true };
  const told = all.find((p) => p.tell && p.say);
  if (told) return { text: told.say!, tell: true };
  return { text: INTERNAL_REFUSAL, tell: false };
}

/**
 * オーナーに見せる理由（LINE のオーナー側の返事・AI の手順）。店の中の決まりもそのまま書く。
 * お客様への文ではないので、AI（予約チャット）には渡さない。
 */
export function ownerRefusal(ctx: Pick<SlotContext, "menus">, v: Verdict): string {
  const p = firstProblem(ctx, v);
  if (!p) return "お受けできます。";
  if (p.tell && p.say) return p.say;
  if (p.kind === "rule") return `「${p.label.replace(/^\[[^\]]*\] /, "")}」という決まりがあるので、お受けできません（${plainReason(p.reason)}）。`;
  return `${p.label}で、お受けできません（${p.reason}）。`;
}

/** 受けられない理由を1文で（お客様にそのまま伝えられる言葉。伝えない理由なら中身は言わない） */
export function refusalSentence(ctx: Pick<SlotContext, "menus">, v: Verdict): string {
  return refusalOf(ctx, v).text;
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

/** お休みの日で外した理由。オーナーの休みの日は「（定休日）」を付けない（tellable.ts の baseSay） */
function closedDay(day: CalDay): Exclusion {
  const reason = day.holiday ? HOLIDAY_REASON : "お休みの日です";
  return { key: "base:open-day", kind: "base", label: "営業日", reason, tell: true, say: baseSay("open-day", reason)! };
}

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
    countOut(excluded, closedDay(day));
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
 * tell = オーナーが「お客様に伝える」にしたルールか。伝えるならルールの名前をそのまま、伝えないなら「この組み合わせではお受けできません」。
 * without = その組み合わせにならない代わりのメニュー（ルールの2つのどちらかを外した物。日時を変えればよいと読まれないように）
 */
export function comboRefusal(ctx: Pick<SlotContext, "menus" | "rules">, menuId: string): { text: string; tell: boolean; rule: Rule; without: string[] } | null {
  const own = partsOf(ctx.menus, menuId);
  const mine = new Set(expandMenuIds(own, ctx.menus));
  for (const r of ctx.rules) {
    if (r.level !== "menu" || r.check.kind !== "notTogether") continue;
    const pair = [r.menuId, r.check.with];
    if (!pair.every((id) => mine.has(id))) continue;
    const tell = tellsRule(r);
    // ルールの2つのどちらかを外した組み合わせ（中のメニューに広げてから外し、もう一度メニューの id に戻す）
    const flat = expandMenuIds(own, ctx.menus).filter((id) => ctx.menus.some((m) => m.id === id && !m.includes?.length));
    const without: string[] = [];
    for (const drop of pair) {
      const rest = flat.filter((id) => id !== drop);
      const id = rest.length ? comboIdOf(ctx.menus, rest) : null;
      if (id && id !== menuId && !without.includes(id)) without.push(id);
    }
    return { text: tell ? comboSay(r) : COMBO_REFUSAL, tell, rule: r, without };
  }
  return null;
}

/** 空きが1つも無いときの、お客様への1文（伝えない理由のとき） */
export const NO_SLOT_INTERNAL = "ご希望の日には、お受けできる時間がありません。";

/**
 * 空きが1つも無かったときの理由（1文）。いちばん多く外した理由から。tell = 理由を伝えてよいか。
 * 伝えない理由（埋まっている・間をあける・何時間前まで など）なら、中身は言わない。
 */
export function noSlotOf(search: SlotSearch): { text: string; tell: boolean } {
  const top = [...search.excluded].filter((e) => e.ex.key !== "base:open-day").sort((a, b) => b.count - a.count)[0];
  // 頼まれた日がお休み：定休日なら「（定休日）」、オーナーの休みの日なら付けない（外した理由の文のまま）
  if (!top) return { text: search.excluded.find((e) => e.ex.key === "base:open-day")?.ex.say ?? CLOSED_DAY_SAY, tell: true };
  if (!top.ex.tell) return { text: NO_SLOT_INTERNAL, tell: false };
  if (top.ex.key === "base:hours") return { text: "営業時間の中に収まる枠が無いので、お受けできません。", tell: true };
  if (top.ex.key === "base:menu-last") return { text: `最終受付に間に合う枠が無いので、お受けできません（${top.ex.reason}）。`, tell: true };
  return { text: top.ex.say ?? NO_SLOT_INTERNAL, tell: !!top.ex.say };
}

export function noSlotSentence(search: SlotSearch): string {
  return noSlotOf(search).text;
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
