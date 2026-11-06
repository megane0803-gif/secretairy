// 広告の承認の箱と、「広告の管理画面」で止めた・外した言葉を、見ている人のブラウザの中だけに残す形（docs/SPEC.md §5.1）。
// ここは形と変え方だけ（どこにも書かない）。書くのは useAds.ts と画面の部品。
//
// 🔒 確定は人：止める・外す（withAdApproved / approveAd）を呼ぶのは、人が画面の「承認」ボタンを押したときだけ。
// AI・サーバー・自動の処理からは呼ばない。サーバーが出せるのは門を通った案まで。

import { addDays, calDay } from "../calendar";
import type { AdWeek } from "../data/types";
import { withTodo, type AddedTodo, type BookState } from "../book/state";
import { withoutOldMark } from "../guestName";
import { adKey } from "../todo/keys";
import type { JournalWho } from "../journal";
import type { AdSettings, ShopSettings } from "../settings";
import type { GateCheck, GatedProposal } from "./gate";
import { actionPast, totalOf, type AdAction, type AdTable } from "./report";
import { parseJudgements, parseReports, type AdJudgement, type AdWeeklyReport } from "./results";
import type { AdsMode } from "./wire";
import { parseTeamRecord } from "./team/state";
import type { TeamRecord } from "./team/types";

export type AdProposalState = "pending" | "approved" | "skipped";

/** 承認の箱の1行（広告の案） */
export type AdProposal = {
  id: string;
  action: AdAction;
  no: number;
  text: string;
  /** AI の理由（1文） */
  reason: string;
  /** 4週の合計（プログラムが表から入れた数。AI は書かない） */
  total: AdWeek;
  /** 門の確認（✓ の印） */
  checks: GateCheck[];
  createdAt: string;
  state: AdProposalState;
  decidedAt?: string;
  /** 「直す」を使った（2回目は受けない） */
  fixed: boolean;
  /** 直す前の案（「前 → 後」に出す） */
  before?: { action: AdAction; no: number; text: string };
  /** だれが作ったか（AI / 決まった返事） */
  mode: AdsMode;
  /** AI のチームの会議の印と答え（1つの案に1回まで。team/state.ts） */
  team?: TeamRecord;
};

/** 「広告の管理画面」で止めた・外した言葉 */
export type AdApplied = { no: number; action: AdAction; at: string; proposalId: string };

export type AdsState = {
  v: 1;
  proposals: AdProposal[];
  applied: AdApplied[];
  /** 効いたかの判定（verdict.ts。無ければ持たない） */
  judgements?: AdJudgement[];
  /** 毎週の見直しの報告（weekly.ts。新しい順。無ければ持たない） */
  reports?: AdWeeklyReport[];
};

export const EMPTY_ADS: AdsState = { v: 1, proposals: [], applied: [] };

const isStr = (x: unknown): x is string => typeof x === "string";
const isAction = (x: unknown): x is AdAction => x === "stop" || x === "exclude";
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;

/** ブラウザに残っていた文字を読む。形のおかしい物は落とす */
export function parseAds(raw: string | null): AdsState {
  if (!raw) return EMPTY_ADS;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(raw);
  } catch {
    return EMPTY_ADS;
  }
  if (!d || typeof d !== "object") return EMPTY_ADS;
  const arr = (x: unknown) => (Array.isArray(x) ? (x as Record<string, unknown>[]) : []);
  const states: AdProposalState[] = ["pending", "approved", "skipped"];
  const proposals: AdProposal[] = arr(d.proposals)
    .filter(
      (p) =>
        p &&
        isStr(p.id) &&
        isAction(p.action) &&
        isInt(p.no) &&
        isStr(p.text) &&
        isStr(p.reason) &&
        isStr(p.createdAt) &&
        states.includes(p.state as AdProposalState) &&
        p.total &&
        typeof p.total === "object",
    )
    .map((p) => {
      const t = p.total as Record<string, unknown>;
      const b = p.before as Record<string, unknown> | undefined;
      return {
        id: p.id as string,
        action: p.action as AdAction,
        no: p.no as number,
        text: (p.text as string).slice(0, 40),
        reason: withoutOldMark(p.reason as string).slice(0, 200),
        total: { clicks: isInt(t.clicks) ? t.clicks : 0, cost: isInt(t.cost) ? t.cost : 0, bookings: isInt(t.bookings) ? t.bookings : 0 },
        checks: arr(p.checks)
          .filter((c) => c && (c.id === "exists" || c.id === "noAdd" || c.id === "town") && isStr(c.label))
          .map((c) => ({ id: c.id as GateCheck["id"], label: c.label as string, ok: c.ok === true ? true : c.ok === false ? false : null })),
        createdAt: p.createdAt as string,
        state: p.state as AdProposalState,
        ...(isStr(p.decidedAt) ? { decidedAt: p.decidedAt } : {}),
        fixed: p.fixed === true,
        ...(b && isAction(b.action) && isInt(b.no) && isStr(b.text) ? { before: { action: b.action, no: b.no, text: b.text } } : {}),
        mode: p.mode === "script" ? "script" : "ai",
        ...(() => {
          const team = parseTeamRecord(p.team);
          return team ? { team } : {};
        })(),
      } satisfies AdProposal;
    });
  const applied: AdApplied[] = arr(d.applied)
    .filter((a) => a && isInt(a.no) && isAction(a.action) && isStr(a.at) && isStr(a.proposalId))
    .map((a) => ({ no: a.no as number, action: a.action as AdAction, at: a.at as string, proposalId: a.proposalId as string }));
  const judgements = parseJudgements(d.judgements);
  const reports = parseReports(d.reports);
  return { v: 1, proposals, applied, ...(judgements.length ? { judgements } : {}), ...(reports.length ? { reports } : {}) };
}

/** 承認待ちの広告の案（あれば1つ） */
export function pendingAd(s: AdsState): AdProposal | null {
  return s.proposals.find((p) => p.state === "pending") ?? null;
}

/** 止めた・外した番号 */
export function offNos(s: AdsState): number[] {
  return s.applied.map((a) => a.no);
}

/**
 * 新しく案を頼めるか。1週間に1つまで（oncePerDays）。もう案がある（承認待ち）ときは出さない。
 * 承認・見送りのどちらでも、出た案は1つと数える。
 */
export function canPropose(
  s: AdsState,
  nowIso: string,
  settings: Pick<AdSettings, "oncePerDays">,
): { ok: true } | { ok: false; reason: string; nextAt?: string } {
  if (pendingAd(s)) return { ok: false, reason: "もう案があります。承認の箱で決めてから頼んでください。" };
  const span = settings.oncePerDays * 86_400_000;
  const recent = s.proposals.filter((p) => Date.parse(nowIso) - Date.parse(p.createdAt) < span).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (recent) {
    const nextAt = new Date(Date.parse(recent.createdAt) + span).toISOString();
    return { ok: false, reason: `案は${settings.oncePerDays}日に1つまでです。`, nextAt };
  }
  return { ok: true };
}

/** 門を通った案を、承認の箱に1行入れる（数は表から入れる）。承認待ちがあるとき・1週間の上限のときは入れない */
export function withProposal(
  s: AdsState,
  p: GatedProposal,
  table: AdTable,
  extra: { id: string; checks: GateCheck[]; nowIso: string; mode: AdsMode },
  settings: Pick<AdSettings, "oncePerDays">,
): AdsState {
  if (!canPropose(s, extra.nowIso, settings).ok) return s;
  const row = [...table.keywords, ...table.searchTerms].find((r) => r.no === p.no);
  if (!row) return s;
  return {
    ...s,
    proposals: [
      ...s.proposals,
      {
        id: extra.id,
        action: p.action,
        no: p.no,
        text: row.text,
        reason: p.reason,
        total: totalOf(row),
        checks: extra.checks,
        createdAt: extra.nowIso,
        state: "pending",
        fixed: false,
        mode: extra.mode,
      },
    ],
  };
}

/** 直す：出しなおした案に差しかえる（同じ行のまま。直すは1回まで） */
export function withAdFixed(s: AdsState, id: string, p: GatedProposal, table: AdTable, checks: GateCheck[]): AdsState {
  const row = [...table.keywords, ...table.searchTerms].find((r) => r.no === p.no);
  if (!row) return s;
  return {
    ...s,
    proposals: s.proposals.map((x) =>
      x.id === id && x.state === "pending" && !x.fixed
        ? {
            ...x,
            before: { action: x.action, no: x.no, text: x.text },
            action: p.action,
            no: p.no,
            text: row.text,
            reason: p.reason,
            total: totalOf(row),
            checks,
            fixed: true,
          }
        : x,
    ),
  };
}

/** 直したが門を通らなかった：前の案のまま、もう直せない */
export function withAdFixUsed(s: AdsState, id: string): AdsState {
  return { ...s, proposals: s.proposals.map((x) => (x.id === id && x.state === "pending" ? { ...x, fixed: true } : x)) };
}

/** 見送り：案を閉じる */
export function withAdSkipped(s: AdsState, id: string, nowIso: string): AdsState {
  return { ...s, proposals: s.proposals.map((x) => (x.id === id && x.state === "pending" ? { ...x, state: "skipped", decidedAt: nowIso } : x)) };
}

/** 🔒 承認：「広告の管理画面」でその言葉を止める（外す）。人が「承認」を押したときだけ呼ぶ */
export function withAdApproved(s: AdsState, id: string, nowIso: string): AdsState {
  const p = s.proposals.find((x) => x.id === id && x.state === "pending");
  if (!p) return s;
  return {
    ...s,
    proposals: s.proposals.map((x) => (x.id === id ? { ...x, state: "approved", decidedAt: nowIso } : x)),
    applied: s.applied.some((a) => a.no === p.no) ? s.applied : [...s.applied, { no: p.no, action: p.action, at: nowIso, proposalId: p.id }],
  };
}

/** 「効いたか見る」の期限。承認した日から checkAfterDays 日後（お休みの日なら次の営業日） */
export function checkDueDate(shop: ShopSettings, today: string, days: number): string {
  let d = addDays(today, days);
  for (let i = 0; i < 30 && !calDay(shop, d).open; i++) d = addDays(d, 1);
  return d;
}

export const AD_TODO_PREFIX = "td-ad-";

/** ToDo の言葉：「3週間後に効いたか見る（3番）」 */
export function adTodoTitle(no: number, days: number): string {
  const span = days % 7 === 0 ? `${days / 7}週間後` : `${days}日後`;
  return `${span}に効いたか見る（${no}番）`;
}

/**
 * 🔒 承認ボタンを押したときの全部：広告でその言葉を止める（外す）・ToDo に期限つきで1件・日誌に1行。
 * 人が画面の「承認」を押したときだけ呼ぶ（AdApprovalRows.tsx が押した事を確かめてから呼ぶ）。
 */
export function approveAd(
  ads: AdsState,
  book: BookState,
  id: string,
  ctx: { nowIso: string; today: string; shop: ShopSettings; settings: Pick<AdSettings, "checkAfterDays" | "channel"> },
): { ads: AdsState; book: BookState; journal: { who: JournalWho; text: string }[] } {
  const p = ads.proposals.find((x) => x.id === id && x.state === "pending");
  if (!p) return { ads, book, journal: [] };
  const due = checkDueDate(ctx.shop, ctx.today, ctx.settings.checkAfterDays);
  const todo: AddedTodo = {
    id: `${AD_TODO_PREFIX}${p.id}`,
    title: adTodoTitle(p.no, ctx.settings.checkAfterDays),
    createdAt: ctx.nowIso,
    done: false,
    due,
    source: "ad",
    key: adKey(p.no),
  };
  const label = calDay(ctx.shop, due).label;
  return {
    ads: withAdApproved(ads, id, ctx.nowIso),
    book: withTodo(book, todo),
    journal: [
      {
        who: "オーナー",
        text: `承認：${ctx.settings.channel}で ${p.no}番「${p.text}」を${actionPast(p.action)}。ToDo に「${todo.title}」（期限 ${label}）を足した`,
      },
    ],
  };
}

/** 広告を最初に戻す：止めた・外した言葉と広告の案を消し、広告から足した ToDo も消す（日誌には残す） */
export function resetAds(book: BookState): { ads: AdsState; book: BookState } {
  return { ads: EMPTY_ADS, book: { ...book, todos: book.todos.filter((t) => !t.id.startsWith(AD_TODO_PREFIX)) } };
}
