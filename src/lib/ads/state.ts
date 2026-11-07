// 広告の承認の箱と、「広告の管理画面」で止めた・外した言葉を、見ている人のブラウザの中だけに残す形（docs/SPEC.md §5.1）。
// ここは形と変え方だけ（どこにも書かない）。書くのは useAds.ts と画面の部品。
//
// 🔒 確定は人：止める・外す（withAdApproved / approveAd）と足す（approveAdd）を呼ぶのは、人が画面の「承認」ボタンを押したときだけ
// （止める・外すは合言葉でつないだ LINE のボタンも。足すは LINE には送らない）。
// AI・サーバー・自動の処理からは呼ばない。サーバーが出せるのは門を通った案まで。
//
// 足す案（adds）は止める・外すの案（proposals）とは別の行で持つ：LINE のボタン・AI のチームの会議・効いたかの判定・戻す案・
// 毎週の見直しの報告は、止める・外すの行（proposals・applied）だけを見るので、足すの行を拾わない。
// 「承認待ちは1つ」「案は7日に1つ」は、1回の見直しで出た行（止める・外す＋足す）をまとめて1回と数える（canPropose）。

import { addDays, calDay } from "../calendar";
import type { AdWeek } from "../data/types";
import { withTodo, type AddedTodo, type BookState } from "../book/state";
import { withoutOldMark } from "../guestName";
import { adKey } from "../todo/keys";
import type { JournalWho } from "../journal";
import type { AdSettings, ShopSettings } from "../settings";
import type { GateCheck, GatedProposal } from "./gate";
import { ADD_CHECK_IDS, addLabel, checkAdd, type AddCheck, type AddRow } from "./add";
import { actionPast, buildTable, totalOf, type AdAction, type AdTable, type AddMark } from "./report";
import type { AdReport } from "../data/types";
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
  /** 本物の広告に反映済み（結果を読み込んだ時刻。connect.ts。無ければ持たない） */
  realAt?: string;
};

/** 承認の箱の1行（足す案）。お客さんが調べた言葉を、広告を出す言葉に足す（フレーズ一致） */
export type AdAddProposal = {
  id: string;
  /** 調べた言葉の番号 */
  no: number;
  text: string;
  /** AI の理由（1文。決まった返事の時は決まった文） */
  reason: string;
  /** その調べた言葉の4週の合計（プログラムが表から入れた数） */
  total: AdWeek;
  /** 足す用の門の確認（✓ 4つ。add.ts） */
  checks: AddCheck[];
  createdAt: string;
  state: AdProposalState;
  decidedAt?: string;
  mode: AdsMode;
  /** 本物の広告に反映済み（結果を読み込んだ時刻。connect.ts） */
  realAt?: string;
};

/** 「広告の管理画面」で止めた・外した言葉 */
export type AdApplied = { no: number; action: AdAction; at: string; proposalId: string };

/** 「広告の管理画面」の「広告を出す言葉」に足した言葉（調べた言葉の番号。数はまだ無い） */
export type AdAdded = { no: number; text: string; at: string; proposalId: string };

export type AdsState = {
  v: 1;
  proposals: AdProposal[];
  applied: AdApplied[];
  /** 足す案の行（無ければ持たない） */
  adds?: AdAddProposal[];
  /** 足した言葉（無ければ持たない） */
  added?: AdAdded[];
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
        ...(isStr(p.realAt) ? { realAt: p.realAt } : {}),
      } satisfies AdProposal;
    });
  const adds: AdAddProposal[] = arr(d.adds)
    .filter(
      (p) =>
        p &&
        isStr(p.id) &&
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
      return {
        id: p.id as string,
        no: p.no as number,
        text: (p.text as string).slice(0, 40),
        reason: withoutOldMark(p.reason as string).slice(0, 200),
        total: { clicks: isInt(t.clicks) ? t.clicks : 0, cost: isInt(t.cost) ? t.cost : 0, bookings: isInt(t.bookings) ? t.bookings : 0 },
        checks: arr(p.checks)
          .filter((c) => c && ADD_CHECK_IDS.includes(c.id as AddCheck["id"]) && isStr(c.label))
          .map((c) => ({
            id: c.id as AddCheck["id"],
            label: c.label as string,
            ok: c.ok === true ? true : c.ok === false ? false : null,
            ...(isStr(c.reason) ? { reason: c.reason } : {}),
          })),
        createdAt: p.createdAt as string,
        state: p.state as AdProposalState,
        ...(isStr(p.decidedAt) ? { decidedAt: p.decidedAt } : {}),
        mode: p.mode === "script" ? "script" : "ai",
        ...(isStr(p.realAt) ? { realAt: p.realAt } : {}),
      } satisfies AdAddProposal;
    });
  const added: AdAdded[] = arr(d.added)
    .filter((a) => a && isInt(a.no) && isStr(a.text) && isStr(a.at) && isStr(a.proposalId))
    .map((a) => ({ no: a.no as number, text: (a.text as string).slice(0, 40), at: a.at as string, proposalId: a.proposalId as string }));
  const applied: AdApplied[] = arr(d.applied)
    .filter((a) => a && isInt(a.no) && isAction(a.action) && isStr(a.at) && isStr(a.proposalId))
    .map((a) => ({ no: a.no as number, action: a.action as AdAction, at: a.at as string, proposalId: a.proposalId as string }));
  const judgements = parseJudgements(d.judgements);
  const reports = parseReports(d.reports);
  return {
    v: 1,
    proposals,
    applied,
    ...(adds.length ? { adds } : {}),
    ...(added.length ? { added } : {}),
    ...(judgements.length ? { judgements } : {}),
    ...(reports.length ? { reports } : {}),
  };
}

/** 何も残っていない（ブラウザから消してよい）か */
export function isEmptyAds(s: AdsState): boolean {
  return s.proposals.length === 0 && s.applied.length === 0 && !s.adds?.length && !s.added?.length && !s.judgements?.length && !s.reports?.length;
}

/** 承認待ちの足す案（作った順） */
export function pendingAdds(s: AdsState): AdAddProposal[] {
  return (s.adds ?? []).filter((p) => p.state === "pending");
}

/** 調べた言葉の番号ごとの、足す案の印（もう足した > 承認待ち > 見送った） */
export function addMarks(s: AdsState): [number, AddMark][] {
  const out = new Map<number, AddMark>();
  const rank: Record<AddMark, number> = { skipped: 1, pending: 2, added: 3 };
  const put = (no: number, m: AddMark) => {
    const was = out.get(no);
    if (!was || rank[m] > rank[was]) out.set(no, m);
  };
  for (const p of s.adds ?? []) {
    if (p.state === "pending") put(p.no, "pending");
    else if (p.state === "skipped") put(p.no, "skipped");
  }
  for (const a of s.added ?? []) put(a.no, "added");
  return [...out];
}

/** 最初の状態の表に、このブラウザで止めた・外した・足した分を重ねる（画面・AI・門で同じ物） */
export function tableOf(report: AdReport, settings: Pick<AdSettings, "featuredMenus">, s: AdsState): AdTable {
  return buildTable(report, settings, offNos(s), addMarks(s));
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
 * 承認・見送りのどちらでも、出た案は1つと数える。1回の見直しで出た行（止める・外す＋足す。同じ作った時刻）は、まとめて1回と数える。
 * どれか1行でも承認待ちなら、次の見直しは頼めない。
 */
export function canPropose(
  s: AdsState,
  nowIso: string,
  settings: Pick<AdSettings, "oncePerDays">,
): { ok: true } | { ok: false; reason: string; nextAt?: string } {
  if (pendingAd(s) || pendingAdds(s).length) return { ok: false, reason: "もう案があります。承認の箱で決めてから頼んでください。" };
  const span = settings.oncePerDays * 86_400_000;
  // 見直しの回ごとの時刻（同じ回の行は同じ時刻なので、1回と数える）
  const reviews = [...new Set([...s.proposals, ...(s.adds ?? [])].map((p) => p.createdAt))];
  const recent = reviews.filter((at) => Date.parse(nowIso) - Date.parse(at) < span).sort((a, b) => b.localeCompare(a))[0];
  if (recent) {
    const nextAt = new Date(Date.parse(recent) + span).toISOString();
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
  return withReview(s, { proposal: { ...p, id: extra.id, checks: extra.checks }, adds: [] }, table, extra, settings);
}

/**
 * 1回の見直しで出た行（止める・外すの案は0か1つ・足す案は0〜上限）を、まとめて承認の箱に入れる（同じ作った時刻＝1回と数える）。
 * 承認待ちがあるとき・1週間の上限のときは、どれも入れない。数は表から入れる。足す案は画面で確かめ直した物（add.ts の addRowsFrom）。
 */
export function withReview(
  s: AdsState,
  r: { proposal?: GatedProposal & { id: string; checks: GateCheck[] }; adds: AddRow[] },
  table: AdTable,
  extra: { nowIso: string; mode: AdsMode },
  settings: Pick<AdSettings, "oncePerDays">,
): AdsState {
  if (!canPropose(s, extra.nowIso, settings).ok) return s;
  const p = r.proposal;
  const row = p ? [...table.keywords, ...table.searchTerms].find((x) => x.no === p.no) : undefined;
  const proposal: AdProposal | null =
    p && row
      ? {
          id: p.id,
          action: p.action,
          no: p.no,
          text: row.text,
          reason: p.reason,
          total: totalOf(row),
          checks: p.checks,
          createdAt: extra.nowIso,
          state: "pending",
          fixed: false,
          mode: extra.mode,
        }
      : null;
  const adds: AdAddProposal[] = r.adds.flatMap((a) => {
    const t = table.searchTerms.find((x) => x.no === a.no);
    return t
      ? [{ id: a.id, no: a.no, text: t.text, reason: a.reason, total: totalOf(t), checks: a.checks, createdAt: extra.nowIso, state: "pending" as const, mode: extra.mode }]
      : [];
  });
  if (!proposal && adds.length === 0) return s;
  return {
    ...s,
    proposals: proposal ? [...s.proposals, proposal] : s.proposals,
    ...(adds.length ? { adds: [...(s.adds ?? []), ...adds] } : {}),
  };
}

/** 足す案の見送り：行を閉じる（次の見直しから、その言葉は足す候補にならない） */
export function withAddSkipped(s: AdsState, id: string, nowIso: string): AdsState {
  if (!s.adds?.some((x) => x.id === id && x.state === "pending")) return s;
  return { ...s, adds: s.adds.map((x) => (x.id === id && x.state === "pending" ? { ...x, state: "skipped" as const, decidedAt: nowIso } : x)) };
}

/**
 * 🔒 足す案の承認：「広告の管理画面」の「広告を出す言葉」に、足した印つきで1行（数は空。お金は動かない）。
 * 人が画面の「承認」を押したときだけ呼ぶ（LINE には送らないので LINE のボタンからは来ない）。
 * 押した時の表（このブラウザの今の状態から作った物）で、足す用の4つをもう一度確かめる。通らなければ足さない。
 * 「効いたか見る」の ToDo・効いたかの判定・戻す案・毎週の見直しの報告は作らない（効いたかの判定は次に作る物）。
 */
export function approveAdd(
  ads: AdsState,
  id: string,
  ctx: { nowIso: string; table: AdTable; words: readonly string[]; settings: Pick<AdSettings, "channel"> },
): { ads: AdsState; journal: { who: JournalWho; text: string }[]; ok: boolean; problems?: string[] } {
  const p = ads.adds?.find((x) => x.id === id && x.state === "pending");
  if (!p) return { ads, journal: [], ok: false };
  const c = checkAdd(ctx.table, ctx.words, p.no, { ownPending: true });
  if (!c.ok)
    return {
      ads,
      ok: false,
      problems: c.problems,
      journal: [{ who: "プログラム", text: `足さなかった：広告の案「${addLabel(p)}」（${c.problems.join("。")}）` }],
    };
  return {
    ok: true,
    ads: {
      ...ads,
      adds: (ads.adds ?? []).map((x) => (x.id === id ? { ...x, state: "approved" as const, decidedAt: ctx.nowIso } : x)),
      added: (ads.added ?? []).some((a) => a.no === p.no) ? ads.added : [...(ads.added ?? []), { no: p.no, text: p.text, at: ctx.nowIso, proposalId: p.id }],
    },
    journal: [
      {
        who: "オーナー",
        text: `承認：${ctx.settings.channel}で ${p.no}番「${p.text}」を広告を出す言葉に足した（フレーズ一致。数はまだ無い）。効いたかの判定は次に作る物`,
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
