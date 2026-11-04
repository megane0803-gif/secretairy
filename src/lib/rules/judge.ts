// 予約を受けてよいかを、プログラムで判定する所。AI はこの結果に従うだけ（数や判定を作らない・変えない）。
// ルールはかならず strictest.ts を通して「その場面で効く、厳しい方の1つ」にしてから使う。
// 文のルールはここでは判定しない（Claude への指示に入れる。prompt.ts）。

import { dayDiff, lastStartOf, toHHMM, toMinutes } from "../calendar";
import type { Hours } from "../settings";
import type { TabId } from "../tabs";
import { formatMinutes } from "./describe";
import { expandMenuIds, rulesFor, strictest, type Situation } from "./strictest";
import type { Rule } from "./types";

/** 判定したい予約 */
export type Booking = {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM */
  start: string;
  menuIds: string[];
  /** 初めての方 */
  newCustomer: boolean;
};

/** もう入っている予約（確定・仮押さえのどちらも、枠はふさがっている） */
export type Booked = Booking;

/** includes = 組み合わせのメニューに入っているメニュー。メニューごとのルールは、それを含む組み合わせにも効く */
export type JudgeMenu = { id: string; name: string; minutes: number; lastStart?: string; includes?: string[] };

export type JudgeInput = {
  /** 全部のルール（鍵つき＋オーナーのルール）。この中から場面に効く物を選ぶ */
  rules: Rule[];
  booking: Booking;
  /** 店の時間帯での、いまの日付と時刻 */
  now: { date: string; time: string };
  /** その日の営業時間（お休みなら null） */
  hours: Hours;
  seats: number;
  menus: JudgeMenu[];
  existing: Booked[];
  /** どのタブの判定か。予約の判定なので、ふつうは "reservations" */
  tab?: TabId;
};

/** 店の設定（営業時間・席・メニューの最終受付）で確かめた結果 */
export type BaseResult = { id: string; label: string; ok: boolean; reason: string };
/** ルールで確かめた結果 */
export type RuleResult = { rule: Rule; ok: boolean; reason: string };

export type Verdict = {
  ok: boolean;
  base: BaseResult[];
  results: RuleResult[];
  /** その場面で効く文のルール（プログラムは判定しない。Claude への指示に入れる） */
  texts: Rule[];
  situation: Situation;
};

type Span = { start: number; end: number };

function minutesOf(menuIds: string[], menus: JudgeMenu[]): number {
  return menuIds.reduce((s, id) => s + (menus.find((m) => m.id === id)?.minutes ?? 0), 0);
}

/** 新しい予約の時間の中で、いちばん多く重なるときの数（新しい予約も入れて） */
function peakOverlap(target: Span, others: Span[]): number {
  const all = [target, ...others];
  const points = all.map((s) => s.start).filter((t) => t >= target.start && t < target.end);
  points.push(target.start);
  let peak = 0;
  for (const t of points) {
    const n = all.filter((s) => s.start <= t && t < s.end).length;
    if (n > peak) peak = n;
  }
  return peak;
}

export function judge(input: JudgeInput): Verdict {
  const { booking, now, hours, seats, menus, existing } = input;
  const tab = input.tab ?? "reservations";
  // メニューごとのルールは、そのメニューを含む組み合わせ（例：カット＋カラー）にも効かせる
  const situation: Situation = { tab, menuIds: expandMenuIds(booking.menuIds, menus) };
  const effective = strictest(rulesFor(input.rules, situation));
  const texts = effective.filter((r) => r.check.kind === "text");

  const start = toMinutes(booking.start);
  const minutes = minutesOf(booking.menuIds, menus);
  const end = start + minutes;
  const lead = dayDiff(now.date, booking.date) * 1440 + start - toMinutes(now.time);
  const names = booking.menuIds.map((id) => menus.find((m) => m.id === id)?.name ?? id).join("・");

  // ---- 店の設定で確かめる ----
  const base: BaseResult[] = [];
  base.push({
    id: "future",
    label: "これからの時刻",
    ok: lead > 0,
    reason: lead > 0 ? "これから先の時刻です" : "もう過ぎた時刻です",
  });
  if (!hours) {
    base.push({ id: "open-day", label: "営業日", ok: false, reason: "お休みの日です" });
    return { ok: false, base, results: [], texts, situation };
  }
  const open = toMinutes(hours.open);
  const close = toMinutes(hours.close);
  base.push({
    id: "hours",
    label: "営業時間",
    ok: start >= open && end <= close,
    reason:
      start < open
        ? `開店（${hours.open}）より前です`
        : end > close
          ? `閉店（${hours.close}）までに終わりません（${toHHMM(end)}に終わります）`
          : `${hours.open}–${hours.close} の中で、${toHHMM(end)}に終わります`,
  });
  const menuLast = booking.menuIds
    .map((id) => menus.find((m) => m.id === id))
    .filter((m): m is JudgeMenu => !!m)
    .map((m) => ({ m, last: lastStartOf(m, hours.close) }));
  const lateMenu = menuLast.find((x) => start > toMinutes(x.last));
  base.push({
    id: "menu-last",
    label: "メニューの最終受付（店の設定）",
    ok: !lateMenu,
    reason: lateMenu
      ? `${lateMenu.m.name}の最終受付（${lateMenu.last}）を過ぎています`
      : menuLast.map((x) => `${x.m.name}は${x.last}まで`).join("・") || "メニューを選んでください",
  });

  const sameDay = existing.filter((b) => b.date === booking.date);
  const target: Span = { start, end };
  const plain = sameDay.map((b) => {
    const s = toMinutes(b.start);
    return { b, span: { start: s, end: s + minutesOf(b.menuIds, menus) } };
  });
  const seatPeak = peakOverlap(target, plain.map((p) => p.span));
  const seatsOk = seatPeak <= seats;
  base.push({
    id: "seats",
    label: "席",
    ok: seatsOk,
    reason: seatsOk ? `いちばん混むときで${seatPeak}席（席は${seats}つ）` : `その時間は席が空いていません（席は${seats}つ）`,
  });

  // ---- ルールで確かめる（その場面で効く、厳しい方の1つずつ） ----
  const results: RuleResult[] = [];
  for (const rule of effective) {
    const c = rule.check;
    switch (c.kind) {
      case "minLeadMinutes": {
        const ok = lead >= c.value;
        const left = Math.max(0, lead);
        results.push({
          rule,
          ok,
          reason: ok
            ? `来店まで${formatMinutes(left)}あります（${formatMinutes(c.value)}前まで）`
            : `来店まで${formatMinutes(left)}しかありません（${formatMinutes(c.value)}前まで）`,
        });
        break;
      }
      case "maxNewCustomersPerDay": {
        if (!booking.newCustomer) {
          results.push({ rule, ok: true, reason: "初めての方ではないので、数に入りません" });
          break;
        }
        const n = sameDay.filter((b) => b.newCustomer).length;
        const ok = n + 1 <= c.value;
        results.push({
          rule,
          ok,
          reason: ok
            ? `この日の初めての方は${n}人。入れると${n + 1}人（${c.value}人まで）`
            : `この日の初めての方はもう${n}人です（${c.value}人まで）`,
        });
        break;
      }
      case "noSameDay": {
        const ok = booking.date !== now.date;
        results.push({ rule, ok, reason: ok ? "来店の日より前の予約です" : "来店と同じ日の予約です" });
        break;
      }
      case "lastStart": {
        const ok = start <= toMinutes(c.time);
        results.push({
          rule,
          ok,
          reason: ok ? `${booking.start}に始まります（${c.time}まで）` : `${booking.start}は最終受付（${c.time}）を過ぎています`,
        });
        break;
      }
      case "bufferAfterMinutes":
      case "text":
        break; // 間を空けるは下でまとめて、文はプログラムでは判定しない
    }
  }

  // 間を空ける：それぞれの予約の後ろに、そのメニューに効く「間」を足して席を数える。
  // 新しい予約の側のルールだけでなく、すでに入っている予約の側のルール（例：前のカラーの後の15分）も効く。
  const bufferRule = (menuIds: string[]) =>
    strictest(rulesFor(input.rules, { tab, menuIds: expandMenuIds(menuIds, menus) })).find(
      (r) => r.check.kind === "bufferAfterMinutes",
    );
  const bufOf = (r: Rule | undefined) => (r && r.check.kind === "bufferAfterMinutes" ? r.check.value : 0);
  const ownRule = bufferRule(booking.menuIds);
  const others = plain.map((p) => ({ ...p, rule: bufferRule(p.b.menuIds) }));
  const withBuf = (useOwn: boolean, useOthers: boolean) =>
    peakOverlap(
      { start, end: end + (useOwn ? bufOf(ownRule) : 0) },
      others.map((o) => ({ start: o.span.start, end: o.span.end + (useOthers ? bufOf(o.rule) : 0) })),
    ) <= seats;

  if (seatsOk && !withBuf(true, true)) {
    // 席はあるのに、間を入れると足りない → どの「間」のせいかを出す
    const blamed = new Set<Rule>();
    if (ownRule && !withBuf(true, false)) blamed.add(ownRule);
    if (!withBuf(false, true) || blamed.size === 0) {
      // 後ろの「間」が、新しい予約の時間にかかっている予約
      const until = end + bufOf(ownRule);
      for (const o of others)
        if (o.rule && bufOf(o.rule) > 0 && o.span.end < until && o.span.end + bufOf(o.rule) > start) blamed.add(o.rule);
    }
    if (blamed.size === 0 && ownRule) blamed.add(ownRule);
    // ここまで来たら、どれかの「間」は 0 より大きい。念のため、空のまま通さない
    if (blamed.size === 0) for (const o of others) if (o.rule && bufOf(o.rule) > 0) blamed.add(o.rule);
    for (const rule of blamed) {
      const v = bufOf(rule);
      const own = rule === ownRule;
      results.push({
        rule,
        ok: false,
        reason: own
          ? `${names}の後の${v}分を入れると、席が足りません`
          : `前の予約の後の${v}分（${rule.label}）にかかって、席が足りません`,
      });
    }
  } else if (ownRule) {
    results.push({
      rule: ownRule,
      ok: true,
      reason: seatsOk ? `${names}の後の${bufOf(ownRule)}分を入れても、席が足ります` : "席が空いていないので、間は数えていません",
    });
  }

  const ok = base.every((b) => b.ok) && results.every((r) => r.ok);
  return { ok, base, results, texts, situation };
}
