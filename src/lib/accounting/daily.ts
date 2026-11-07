// 経理の日報：その日の売上（支払い方法ごと）と来店を、オーナーが自分で入れる。
// このブラウザの中だけに残すオーナーの記録（docs/SPEC.md §1.8・§5.1）。freee にも会計にも AI にも送らない。
// 数の確かめ・重ね方・月の選び・「まだ」の日は、どれもここ（プログラム）が決める。画面（SalesReport.tsx）とテストが同じここを使う。
// 画面に依らない形（ブラウザに書く所は deps で受け取る。dailyStore.ts）。

import type { BrowserWrite } from "../browser";
import { SAVE_FAILED_MESSAGE } from "../browser";
import { calDay } from "../calendar";
import type { SalesDay, SalesMonth } from "../data/types";
import type { JournalWho } from "../journal";
import type { DailyLimits, ShopSettings } from "../settings";
import { summarizeSales, yen, type SalesDayCell, type SalesSummary } from "./sales";

/** 1日分の日報 */
export type DailyReport = {
  /** YYYY-MM-DD */
  date: string;
  /** 来店（施術したお客様の人数。店販だけの方は数えない） */
  visits: number;
  /** 支払い方法ごとの売上（税込・手数料を引く前・店販も含む。円）。キーは seed の methods の id */
  pay: Record<string, number>;
  /**
   * 1日の売上の内訳（任意。入れた日だけ）。total = 1日の売上（税込）＝支払い方法ごとの合計・tech = 技術売上・retail = 店販売上（商品の売上）。
   * tech + retail = total。前に入れた日報（内訳の欄が無い）もそのまま読む（同じ v: 1 の形に欄を足しただけ）
   */
  split?: DailySplit;
  /** 最後に入れた・直した時刻（ISO） */
  at: string;
};

/** 1日の売上の内訳（円） */
export type DailySplit = { total: number; tech: number; retail: number };

export type DailyState = { v: 1; days: DailyReport[] };

export const EMPTY_DAILY: DailyState = { v: 1, days: [] };

/** 1枚の中に出す決まりの一言 */
export const DAILY_RULE_NOTE =
  "売上は、お客様から受け取った税込の金額（カードなどの手数料を引く前。店販も含める）。来店は、施術したお客様の人数（店販だけの方は数えない）";

/** 売上の欄の説明の文 */
export const DAILY_SECTION_NOTE = "日報はこのブラウザに保存します（どこにも送りません）。最初に戻すと消えます。数はどれもプログラムが日ごとの数から出しています。";

/** 「最初に戻す」の後に、戻す前に入れかけた数を保存しようとした時の1文 */
export const DAILY_RESET_MESSAGE = "最初に戻したので、入れかけた数は保存しませんでした。";

/** 1枚の内訳の欄の説明 */
export const DAILY_SPLIT_NOTE = "なくてもよい欄です。入れる時は3つとも入れます（技術売上＋店販売上＝1日の売上・1日の売上＝支払い方法ごとの合計）。";

/** 内訳の欄の名前（画面とエラーの文が同じ物を使う） */
export const SPLIT_LABEL = { total: "1日の売上（税込）", tech: "技術売上", retail: "店販売上（商品の売上）" } as const;

/** 内訳の欄の id（DailyField）。parts = 技術＋店販が1日の売上と合わない時 */
export const SPLIT_FIELD = { total: "split.total", tech: "split.tech", retail: "split.retail", parts: "split.parts" } as const;

/** 本当にある日付（YYYY-MM-DD） */
export function isRealDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return y >= 1900 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** 2026-11-06 → 2026-11 */
export const monthOf = (date: string) => date.slice(0, 7);

/** 2026-11 → 2026年11月 */
export function monthTitle(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${y}年${m}月`;
}

const sumPay = (pay: Record<string, number>) => Object.values(pay).reduce((a, b) => a + b, 0);

/**
 * 入れた文字を数にする。空欄は 0。0 以上の整数だけ（全角の数字・桁の「,」は読む）。
 * 負の数・小数・数でない物は null。
 */
export function parseCount(text: string): number | null {
  const t = text
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[,，]/g, "");
  if (t === "") return 0;
  if (!/^\d{1,12}$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

const okCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export function parseDaily(raw: string | null): DailyState {
  if (!raw) return EMPTY_DAILY;
  try {
    const d = JSON.parse(raw);
    if (!d || d.v !== 1 || !Array.isArray(d.days)) return EMPTY_DAILY;
    const seen = new Set<string>();
    const days: DailyReport[] = [];
    for (const r of d.days) {
      if (!r || typeof r.date !== "string" || !isRealDate(r.date) || seen.has(r.date)) continue;
      if (!okCount(r.visits) || !r.pay || typeof r.pay !== "object") continue;
      const pay: Record<string, number> = {};
      let bad = false;
      for (const [k, v] of Object.entries(r.pay)) {
        if (!okCount(v)) bad = true;
        else pay[k] = v;
      }
      if (bad) continue;
      seen.add(r.date);
      const split = readSplit(r.split);
      days.push({ date: r.date, visits: r.visits, pay, ...(split ? { split } : {}), at: typeof r.at === "string" ? r.at : "" });
    }
    return { v: 1, days: sortDays(days) };
  } catch {
    return EMPTY_DAILY;
  }
}

/** 内訳を読む。欄が無い（前の形）・形がおかしい・技術＋店販が合わない時は内訳なしで読む（その日の日報は残す） */
function readSplit(x: unknown): DailySplit | null {
  if (!x || typeof x !== "object") return null;
  const { total, tech, retail } = x as Record<string, unknown>;
  if (!okCount(total) || !okCount(tech) || !okCount(retail) || tech + retail !== total) return null;
  return { total, tech, retail };
}

const sortDays = (days: DailyReport[]) => [...days].sort((a, b) => a.date.localeCompare(b.date));

export const dailyOf = (state: DailyState, date: string) => state.days.find((d) => d.date === date) ?? null;

// ── 1枚に入れる物 ───────────────────────────────

export type Method = { id: string; name: string };

/** 内訳の入力（画面の文字のまま。空欄は「入れていない」で、0 とは分ける） */
export type DailySplitDraft = { total: string; tech: string; retail: string };

export const EMPTY_SPLIT_DRAFT: DailySplitDraft = { total: "", tech: "", retail: "" };

/** 1枚の入力（画面の文字のまま）。split が無いのは内訳を3つとも空欄にしたのと同じ */
export type DailyDraft = { date: string; visits: string; pay: Record<string, string>; split?: DailySplitDraft };

/** その日の数を読む順：その日の日報 → （最初から入っている月なら）最初から入っている数 → 空欄 */
export type DaySource = { from: "daily" | "seed" | "empty"; visits: number; pay: Record<string, number>; split?: DailySplit };

export function sourceFor(date: string, state: DailyState, seed: SalesMonth): DaySource {
  const own = dailyOf(state, date);
  if (own) return { from: "daily", visits: own.visits, pay: own.pay, ...(own.split ? { split: own.split } : {}) };
  const base = monthOf(date) === seed.month ? seed.days.find((d) => d.date === date) : undefined;
  if (base) return { from: "seed", visits: base.visits, pay: base.pay };
  return { from: "empty", visits: 0, pay: {} };
}

/** 日付を選んだ（変えた）時の1枚の中身。空欄の日は全部空にする */
export function draftFor(date: string, state: DailyState, seed: SalesMonth): { draft: DailyDraft; from: DaySource["from"] } {
  const src = sourceFor(date, state, seed);
  const empty = src.from === "empty";
  const pay: Record<string, string> = {};
  for (const m of seed.methods) pay[m.id] = empty ? "" : String(src.pay[m.id] ?? 0);
  // 内訳は入れた日報の数だけ出す（最初から入っている数と、内訳の無い日報は空欄）
  const split: DailySplitDraft = src.split
    ? { total: String(src.split.total), tech: String(src.split.tech), retail: String(src.split.retail) }
    : { ...EMPTY_SPLIT_DRAFT };
  return { draft: { date, visits: empty ? "" : String(src.visits), pay, split }, from: src.from };
}

export type DailyCheckContext = { today: string; methods: Method[]; limits: DailyLimits; shop: ShopSettings };

export type DailyField = "date" | "visits" | "total" | string;

export type DailyCheck =
  | { ok: true; report: Omit<DailyReport, "at">; total: number; errors: [] }
  | { ok: false; total: number | null; errors: { field: DailyField; text: string }[] };

/** 入れた数の確かめ（プログラム）。合計は足せた時だけ出す（足せない時は null） */
export function checkDaily(draft: DailyDraft, ctx: DailyCheckContext): DailyCheck {
  const errors: { field: DailyField; text: string }[] = [];
  if (!isRealDate(draft.date)) errors.push({ field: "date", text: "本当にある日付を選んでください。" });
  else if (draft.date > ctx.today) errors.push({ field: "date", text: `先の日の日報は入れられません（今日は ${calDay(ctx.shop, ctx.today).label}）。` });

  const visits = parseCount(draft.visits);
  if (visits === null) errors.push({ field: "visits", text: "来店は 0 以上の整数で入れてください（空欄は 0）。" });
  else if (visits > ctx.limits.maxVisits) errors.push({ field: "visits", text: `来店は1日 ${ctx.limits.maxVisits}人までです。` });

  const pay: Record<string, number> = {};
  let payOk = true;
  for (const m of ctx.methods) {
    const n = parseCount(draft.pay[m.id] ?? "");
    if (n === null) {
      payOk = false;
      errors.push({ field: m.id, text: `${m.name}は 0 以上の整数（円）で入れてください（空欄は 0）。` });
    } else pay[m.id] = n;
  }
  const total = payOk ? sumPay(pay) : null;
  if (total !== null && total > ctx.limits.maxTotalYen) errors.push({ field: "total", text: `売上の合計は1日 ${yen(ctx.limits.maxTotalYen)}までです。` });

  const split = checkSplit(draft.split ?? EMPTY_SPLIT_DRAFT, total, ctx.limits, errors);

  if (errors.length || visits === null || total === null) return { ok: false, total, errors };
  return { ok: true, report: { date: draft.date, visits, pay, ...(split ? { split } : {}) }, total, errors: [] };
}

/** 少ない・多いの言い方（ずれた円を出す） */
const gap = (have: number, want: number) => (have < want ? `${yen(want - have)}少ない` : `${yen(have - want)}多い`);

/**
 * 内訳の確かめ（プログラム）。3つとも空欄なら内訳なし（null。今の日報のまま保存できる）。
 * 1つでも入れたら3つとも要る。0 以上の整数で、上限は1日の売上の合計と同じ（limits.maxTotalYen）。
 * 技術売上＋店販売上＝1日の売上・1日の売上＝支払い方法ごとの合計（payTotal。足せない時は比べない）。合わない時は何円ずれているかを出す。
 */
export function checkSplit(
  d: DailySplitDraft,
  payTotal: number | null,
  limits: DailyLimits,
  errors: { field: DailyField; text: string }[],
): DailySplit | null {
  const keys = ["total", "tech", "retail"] as const;
  const filled = keys.filter((k) => d[k].trim() !== "");
  if (filled.length === 0) return null;
  const n: Partial<DailySplit> = {};
  let bad = false;
  for (const k of keys) {
    if (d[k].trim() === "") {
      bad = true;
      errors.push({ field: SPLIT_FIELD[k], text: `内訳を入れる時は3つとも要ります。${SPLIT_LABEL[k]}も入れてください（内訳を入れない時は3つとも空欄に）。` });
      continue;
    }
    const v = parseCount(d[k]);
    if (v === null) {
      bad = true;
      errors.push({ field: SPLIT_FIELD[k], text: `${SPLIT_LABEL[k]}は 0 以上の整数（円）で入れてください。` });
    } else if (v > limits.maxTotalYen) {
      bad = true;
      errors.push({ field: SPLIT_FIELD[k], text: `${SPLIT_LABEL[k]}は1日 ${yen(limits.maxTotalYen)}までです。` });
    } else n[k] = v;
  }
  if (bad) return null;
  const s = n as DailySplit;
  let ok = true;
  if (s.tech + s.retail !== s.total) {
    ok = false;
    errors.push({
      field: SPLIT_FIELD.parts,
      text: `技術売上と店販売上を足すと ${yen(s.tech + s.retail)}で、1日の売上（${yen(s.total)}）より ${gap(s.tech + s.retail, s.total)}です。`,
    });
  }
  if (payTotal !== null && s.total !== payTotal) {
    ok = false;
    errors.push({
      field: SPLIT_FIELD.total,
      text: `1日の売上（${yen(s.total)}）が、支払い方法ごとの合計（${yen(payTotal)}）より ${gap(s.total, payTotal)}です。`,
    });
  }
  return ok ? s : null;
}

// ── 入れる・直す・消す（ブラウザに書く前の形） ────────────────

export type DailyChange =
  | { ok: true; state: DailyState; kind: "add" | "edit" | "remove" }
  | { ok: false; reason: string };

/** 日数の上限（limits.maxDays）に達した時の1文 */
export const daysFullMessage = (limits: DailyLimits) =>
  `日報は ${limits.maxDays}日分まで保存できます。新しい日は足せません（古い日報は消していません。今ある日の直す・消すはできます）。`;

/** 入れる（無い日）・直す（ある日）。新しい日だけ、日数の上限で断る（古い日報は勝手に消さない） */
export function withDaily(state: DailyState, report: DailyReport, limits: DailyLimits): DailyChange {
  const has = dailyOf(state, report.date) !== null;
  if (!has && state.days.length >= limits.maxDays) return { ok: false, reason: daysFullMessage(limits) };
  const days = sortDays([...state.days.filter((d) => d.date !== report.date), report]);
  return { ok: true, state: { v: 1, days }, kind: has ? "edit" : "add" };
}

export function withoutDaily(state: DailyState, date: string): DailyChange {
  if (!dailyOf(state, date)) return { ok: false, reason: "この日の日報はありません。" };
  return { ok: true, state: { v: 1, days: state.days.filter((d) => d.date !== date) }, kind: "remove" };
}

// ── 月 ──────────────────────────────────────

/** 選べる月：最初から入っている月と、日報が入っている月（古い順） */
export function salesMonths(state: DailyState, seedMonth: string): string[] {
  return [...new Set([seedMonth, ...state.days.map((d) => monthOf(d.date))])].sort();
}

/** 開いた時の月：日報が入っている一番新しい月（日報が無ければ最初から入っている月） */
export function initialMonth(state: DailyState, seedMonth: string): string {
  // days は日付の順なので、いちばん後ろが一番新しい月
  const last = state.days.at(-1);
  return last ? monthOf(last.date) : seedMonth;
}

/** 消した後の月：見ていた月がもう選べなければ「日報が入っている一番新しい月 → 最初から入っている月」 */
export function monthAfterRemove(current: string, state: DailyState, seedMonth: string): string {
  return salesMonths(state, seedMonth).includes(current) ? current : initialMonth(state, seedMonth);
}

/**
 * その月の日だけの売上。最初から入っている月は、最初の数に日報を重ねる
 * （日報がある日は、来店とすべての支払い方法の数をまるごと日報の数に置き換える。足さない）。
 */
export function monthSales(month: string, seed: SalesMonth, state: DailyState): SalesMonth {
  const own = state.days.filter((d) => monthOf(d.date) === month);
  const ownDates = new Set(own.map((d) => d.date));
  const base = month === seed.month ? seed.days.filter((d) => monthOf(d.date) === month && !ownDates.has(d.date)) : [];
  const days: SalesDay[] = [...base, ...own.map((d) => ({ date: d.date, visits: d.visits, pay: { ...d.pay } }))].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  return { month, methods: seed.methods, days };
}

export type MonthDayCell = SalesDayCell & {
  /** 日報から入った日 */
  daily: boolean;
  /** 数を出す日（営業日か、休業日でも日報がある日） */
  shown: boolean;
  /** 「まだ」の日：今日までの営業日で、日報も最初から入っている数も無い日（0円で入れた日は入れた日） */
  missing: boolean;
  /** 先の日で、数が無い日（表では「—」） */
  ahead: boolean;
  /** オーナーが決めた休みの日（calDay の holiday。定休日の曜日とは札を分ける） */
  holiday: boolean;
  /** その日の日報に入れた内訳（技術・店販。円）。入れていない日は null */
  split: { tech: number; retail: number } | null;
};

export type MonthSummary = Omit<SalesSummary, "days"> & {
  /** 2026-11 */
  key: string;
  year: number;
  days: MonthDayCell[];
  missingCount: number;
  /** その月の内訳：内訳を入れた日の技術・店販の合計と、その日数（プログラムが日ごとの数から足す） */
  split: { tech: number; retail: number; days: number };
};

/**
 * その月の数（大きい数字3つ・日ごとの棒・支払い方法の割合・表）。式は summarizeSales のまま。
 * shop は、店の設定に予約のページで決めた休みの日を重ねた物（holidays.ts の withHolidays）。休みの日は営業日に数えない（「まだ」にしない）。
 */
export function summarizeMonth(month: string, seed: SalesMonth, state: DailyState, shop: ShopSettings, today: string): MonthSummary {
  const sales = monthSales(month, seed, state);
  const s = summarizeSales(sales, shop);
  const ownDays = new Map(state.days.filter((d) => monthOf(d.date) === month).map((d) => [d.date, d]));
  const rows = new Set(sales.days.map((d) => d.date));
  const days = s.days.map((d) => {
    const mine = ownDays.get(d.date);
    const daily = mine !== undefined;
    const row = rows.has(d.date);
    const holiday = calDay(shop, d.date).holiday === true;
    const split = mine?.split ? { tech: mine.split.tech, retail: mine.split.retail } : null;
    return { ...d, daily, shown: d.open || daily, missing: d.open && d.date <= today && !row, ahead: d.date > today && !row, holiday, split };
  });
  const withSplit = days.filter((d) => d.split);
  const split = {
    tech: withSplit.reduce((a, d) => a + d.split!.tech, 0),
    retail: withSplit.reduce((a, d) => a + d.split!.retail, 0),
    days: withSplit.length,
  };
  return { ...s, key: month, year: Number(month.slice(0, 4)), days, missingCount: days.filter((d) => d.missing).length, split };
}

// ── 保存（人のボタン） ─────────────────────────────

export type DailyDeps = {
  /** 書く直前に読みなおす */
  read: () => DailyState;
  /** 書けたかを返す（writeBrowser の答え） */
  write: (s: DailyState) => BrowserWrite;
  journal: (...lines: { who: JournalWho; text: string }[]) => void;
  /** 今の台帳の「最初に戻す」の印（book/store.ts の currentEpoch） */
  epochNow: () => string | undefined;
  /** 書く時刻 */
  nowIso?: () => string;
};

export type DailyAction =
  | { kind: "save"; draft: DailyDraft }
  | { kind: "remove"; date: string };

export type DailyCommitInput = DailyCheckContext & {
  action: DailyAction;
  /** 1枚を開いた時の印 */
  epoch: string | undefined;
};

/**
 * ok: false の時：written = false は「ブラウザに書けなかった」（1枚は閉じずに数を残す）。
 * reset = true は「最初に戻した後」（1枚を閉じ、戻す前の数は保存しない）。どちらでもない時は決まりで断った（errors か reason）。
 */
export type DailyCommit =
  | { ok: true; state: DailyState; kind: "add" | "edit" | "remove"; date: string; month: string; message: string }
  | { ok: false; message: string; written: boolean; reset?: boolean; errors?: { field: DailyField; text: string }[] };

const DONE_MESSAGE = {
  add: "✓ 日報を入れました。",
  edit: "✓ 日報を直しました。",
  remove: "✓ 日報を消しました。",
} as const;

export function dailyJournalText(kind: "add" | "edit" | "remove", date: string, shop: ShopSettings, report?: Pick<DailyReport, "visits" | "pay" | "split">): string {
  const label = calDay(shop, date).label;
  if (kind === "remove") return `日報を消した（${label}）`;
  const verb = kind === "add" ? "入れた" : "直した";
  return `日報を${verb}（${label} 売上 ${yen(sumPay(report!.pay))}・来店 ${report!.visits}人・${report!.split ? "内訳あり" : "内訳なし"}）`;
}

/**
 * 🔒 人の「入れる」「直す」「消す」ボタンだけが呼ぶ。数はプログラムが確かめ、書けた時だけ日誌に1行書きに行く
 * （writeJournal は書けたかを返さないので、日誌が書けなかった時に日報を戻すことはしない）。
 * どこにも送らない（freee・会計・AI のどれも呼ばない）。
 */
export function commitDaily(deps: DailyDeps, input: DailyCommitInput): DailyCommit {
  if ((deps.epochNow() ?? "") !== (input.epoch ?? "")) return { ok: false, message: DAILY_RESET_MESSAGE, written: true, reset: true };
  const now = deps.read();
  let change: DailyChange;
  let report: DailyReport | undefined;
  if (input.action.kind === "save") {
    const c = checkDaily(input.action.draft, input);
    if (!c.ok) return { ok: false, message: c.errors[0].text, written: true, errors: c.errors };
    report = { ...c.report, at: deps.nowIso ? deps.nowIso() : new Date().toISOString() };
    change = withDaily(now, report, input.limits);
  } else {
    change = withoutDaily(now, input.action.date);
  }
  if (!change.ok) return { ok: false, message: change.reason, written: true };
  const date = report?.date ?? (input.action as { date: string }).date;
  const w = deps.write(change.state);
  if (!w.ok) return { ok: false, message: SAVE_FAILED_MESSAGE, written: false };
  const text = dailyJournalText(change.kind, date, input.shop, report);
  deps.journal({ who: "オーナー", text });
  return { ok: true, state: change.state, kind: change.kind, date, month: monthOf(date), message: DONE_MESSAGE[change.kind] };
}
