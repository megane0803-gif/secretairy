// リサーチャー（プログラム）：その言葉の4週の数・予約・お金・前の判定を、店のデータから並べる。
// 数・日時・値段は、ここ（プログラム）だけが入れる。AI（分身・野党・補佐）には書かせない。
// 分身と野党に渡す「材料」の文も、ここで作る（2人とも同じ材料を、別々に読む）。

import { businessDayAt, calDay } from "../../calendar";
import type { AdPastDecision } from "../../data/types";
import { baseShop } from "../../holidays";
import type { ShopSettings } from "../../settings";
import { actionFor, actionVerb, findRow, totalOf, townIn, WEEK_LABELS, yen, type AdAction, type AdTable } from "../report";
import { VERDICT_LABEL, type AdJudgement } from "../results";
import type { AdProposal, AdsState } from "../state";
import type { PastDecision, PastJudgement, Research, TeamSnapshot } from "./types";

const MAX_OTHER_JUDGEMENTS = 3;

/** 案の中身（会議を始めた時の印にする） */
export function snapshotOf(p: Pick<AdProposal, "action" | "no" | "text" | "reason">): TeamSnapshot {
  return { action: p.action, no: p.no, text: p.text, reason: p.reason };
}

export function sameSnapshot(a: TeamSnapshot, b: TeamSnapshot): boolean {
  return a.action === b.action && a.no === b.no && a.text === b.text && a.reason === b.reason;
}

function toPastJudgement(j: Pick<AdJudgement, "no" | "text" | "action" | "verdict">): PastJudgement {
  return { no: j.no, text: j.text, action: j.action, verdict: j.verdict };
}

/** 案の言葉を表から調べる。表に無い・止める／外すが合わない時は null */
export function research(table: AdTable, p: Pick<TeamSnapshot, "action" | "no">, judgements: PastJudgement[], towns: string[]): Research | null {
  const row = findRow(table, p.no);
  if (!row || actionFor(row.kind) !== p.action) return null;
  const mine = judgements.filter((j) => j.no === row.no);
  return {
    no: row.no,
    text: row.text,
    action: p.action,
    kind: row.kind,
    featured: row.featured,
    town: townIn(row.text, towns),
    weeks: row.weeks.map((w) => ({ ...w })),
    total: totalOf(row),
    judgements: mine,
    otherJudgements: judgements.filter((j) => j.no !== row.no).slice(0, MAX_OTHER_JUDGEMENTS),
  };
}

/** 広告の記録（ブラウザの中）にある判定を、新しい順に */
export function judgementsOf(ads: Pick<AdsState, "judgements">): PastJudgement[] {
  return [...(ads.judgements ?? [])].sort((a, b) => b.judgedAt.localeCompare(a.judgedAt)).map(toPastJudgement);
}

/**
 * 前のオーナーの判断：広告の記録にある承認・見送り（state の approved / skipped と decidedAt）と、
 * 架空の最初の状態の判断（seed/ads.json の past。起点の日から数えた営業日）。新しい順に max 件。
 * 理由は入れない（記録にある理由は AI が案を出した時の理由なので、オーナーの理由として使わない）。
 */
export function pastDecisions(
  ads: Pick<AdsState, "proposals">,
  seedPast: AdPastDecision[],
  ctx: { shop: ShopSettings; anchor: string; excludeId?: string; max: number },
): PastDecision[] {
  const fromState: PastDecision[] = ads.proposals
    .filter((p) => p.id !== ctx.excludeId && (p.state === "approved" || p.state === "skipped") && p.decidedAt)
    .map((p) => ({
      text: p.text,
      action: p.action,
      decision: p.state as "approved" | "skipped",
      date: (p.decidedAt as string).slice(0, 10),
      bookings: p.total.bookings,
    }));
  // 最初の状態の日付は、オーナーの休みの日を外した店で数える（holidays.ts の baseShop）
  const base = baseShop(ctx.shop);
  const anchor = calDay(base, ctx.anchor);
  const fromSeed: PastDecision[] = seedPast.flatMap((d) => {
    const day = businessDayAt(base, anchor, d.day);
    return day ? [{ text: d.text, action: d.action, decision: d.decision, date: day.date, bookings: d.bookings }] : [];
  });
  return [...fromState, ...fromSeed].sort((a, b) => b.date.localeCompare(a.date)).slice(0, Math.max(0, ctx.max));
}

const decisionWord = (d: PastDecision["decision"]) => (d === "approved" ? "承認" : "見送り");

/** 画面に出すリサーチャーの行（数はプログラムが入れる） */
export function researchLines(r: Research): { label: string; value: string }[] {
  const lines = [
    { label: "4週の合計", value: `押された ${r.total.clicks.toLocaleString("ja-JP")}回・お金 ${yen(r.total.cost)}・予約 ${r.total.bookings}件` },
    { label: "押された回数", value: r.weeks.map((w, i) => `${WEEK_LABELS[i] ?? `${i + 1}週目`} ${w.clicks}回`).join("・") },
    { label: "予約", value: r.weeks.map((w, i) => `${WEEK_LABELS[i] ?? `${i + 1}週目`} ${w.bookings}件`).join("・") },
    { label: "お金", value: r.weeks.map((w, i) => `${WEEK_LABELS[i] ?? `${i + 1}週目`} ${yen(w.cost)}`).join("・") },
    { label: "前の判定", value: judgementText(r) },
  ];
  const tags = [r.featured ? "売りのメニューの言葉" : "", r.town ? `町の名前（${r.town}）入り` : ""].filter(Boolean);
  if (tags.length) lines.push({ label: "印", value: tags.join("・") });
  return lines;
}

function judgementText(r: Research): string {
  const mine = r.judgements.map((j) => `この言葉 → ${VERDICT_LABEL[j.verdict]}`);
  const others = r.otherJudgements.map((j) => `「${j.text}」を${j.action === "stop" ? "止めた" : "外した"} → ${VERDICT_LABEL[j.verdict]}`);
  if (mine.length === 0 && others.length === 0) return "まだありません";
  return [...(mine.length ? mine : ["この言葉はまだありません"]), ...others].join("・");
}

/**
 * 分身と野党に渡す材料（2人とも同じ物）。数はプログラムが書いた物で、AI は読むだけ（書かない）。
 * 前のオーナーの判断は、対象・止める／外す・承認か見送りか・決めた日・その時の予約の数だけ（理由は無い）。
 */
export function materialText(
  r: Research,
  snapshot: TeamSnapshot,
  past: PastDecision[],
  shop: ShopSettings,
): string {
  const kind = r.kind === "keyword" ? "広告を出す言葉" : "お客さんが調べた言葉";
  const lines = [
    "# 案（AI が出した案。決めるのはオーナー）",
    `- ${r.no}番「${r.text}」（${kind}）を${actionVerb(r.action)}`,
    `- 案を出した時の AI の理由：${snapshot.reason}`,
    "",
    "# リサーチャー（プログラム）が店のデータから並べた数",
    ...r.weeks.map((w, i) => `- ${WEEK_LABELS[i] ?? `${i + 1}週目`}：押された${w.clicks}回・${w.cost}円・予約${w.bookings}件`),
    `- 4週の合計：押された${r.total.clicks}回・${r.total.cost}円・予約${r.total.bookings}件${r.total.bookings === 0 ? "（予約につながっていない）" : ""}`,
  ];
  if (r.featured) lines.push("- 売りのメニューの言葉");
  if (r.town) lines.push(`- 町の名前（${r.town}）が入った言葉`);
  lines.push(`- 前の判定：${judgementText(r)}`);
  lines.push("", "# 数を言葉で言うと（答えにはこの言い方を使い、数字・日付・値段は書かない）");
  for (const w of researchWords(r)) lines.push(`- ${w}`);
  lines.push("", "# 広告の記録にある、前のオーナーの判断（対象・止める／外す・承認か見送りか・決めた日。理由は残っていません）");
  if (past.length === 0) lines.push("- （過去の判断はまだありません）");
  for (const d of past)
    lines.push(
      `- ${calDay(shop, d.date).label}：「${d.text}」を${actionVerb(d.action)}案 → ${decisionWord(d.decision)}（その時の4週の予約${d.bookings}件${d.bookings === 0 ? "・予約につながっていなかった" : ""}）`,
    );
  return lines.join("\n");
}

/**
 * リサーチャーの数を、数字を使わない言葉にする（プログラム）。AI は答えにこの言い方を使う（数字・日付・値段は書かない）。
 * 例：「予約がない（予約につながっていない）」「お金がかかっている」「押された回数は増えている」
 */
export function researchWords(r: Research): string[] {
  const first = r.weeks[0]?.clicks ?? 0;
  const last = r.weeks[r.weeks.length - 1]?.clicks ?? 0;
  const withBooking = r.weeks.filter((w) => w.bookings > 0).length;
  return [
    r.total.bookings === 0
      ? "予約：ずっと予約がない（予約につながっていない）"
      : withBooking < r.weeks.length
        ? "予約：予約は少しある（予約のない週もある）"
        : "予約：毎週予約につながっている",
    r.total.cost > 0 ? "お金：毎週お金がかかっている" : "お金：お金はかかっていない",
    last > first ? "押された回数：だんだん増えている" : last < first ? "押された回数：だんだん減っている" : "押された回数：あまり変わらない",
  ];
}

/** 「外す」→「外さずに残す」のように、案のとおりにしない言い方 */
export function keepVerb(a: AdAction): string {
  return a === "stop" ? "止めずに残す" : "外さずに残す";
}
