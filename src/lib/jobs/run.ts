// ホームの「AI の仕事」の流れ（docs/SPEC.md §1.12）。押した時に、これから来る物を1行ずつ動かし、結果をそれぞれの場所に届ける。
//   予約の相談 … 架空のお客様の文1件を、予約チャットと同じ /api/ai/reserve へ → 返事をして仮押さえ → 承認の箱へ
//   新しい明細 … 経理の「次の明細（試し）」の架空の明細を、いま効く自動のルールで仕分け（AI なし）→ 迷う物は経理タブへ
//   広告の見直し … 広告タブと同じ /api/ai/ads → 画面でももう一度門 → 承認の箱へ（足す案も同じ決まりで。今週の案がもうある時は動かさない）
//   メモ … 架空のメモ1件を、メモを投げると同じ /api/ai/todo → ToDo へ
//   予約サイトから予約が入る … 予約サイトの「ここで予約が入る（デモ）」と同じ（AI なし。book/site.ts）→ 台帳へ（承認の箱は通さない）
//
// 置き場所（JobStore）と AI の窓口（JobAsk）は外から渡す：画面はブラウザの中と fetch、テストはメモリと決まった返事。
// 🔒 確定は人：ここから呼ぶのは仮押さえ（withHold）・承認の箱に入れる（withProposal）・ToDo に足すだけ。確定の変え方は呼ばない。
// 🔒 AI を呼ぶ回数は、1回押した時に config/ai.json の jobs.maxAiCallsPerPress まで（足りない行は動かさない）。

import { getAccounting, getAds, getJobSeeds, getTodos } from "../data/seed";
import type { AccountingSeed, AdReport, JobSeed } from "../data/types";
import { sortTrial, type AccountingState } from "../accounting/state";
import { checkDraft, proposalLabel } from "../ads/gate";
import { addLabel, addRowsFrom } from "../ads/add";
import { featuredWords } from "../ads/featured";
import { canPropose, tableOf, withReview, type AdsState } from "../ads/state";
import { buildWeeklyReport, withReport } from "../ads/weekly";
import type { AdsRequest, AdsResponse } from "../ads/wire";
import { AI_FAILED_MESSAGE, reasonOf } from "../ai/busy";
import { candidateLabel } from "../ai/slots";
import { NO_AI_MESSAGE, parseHoldOffer, type Candidate, type HoldOffer, type ReserveEvent, type ReserveRequest } from "../ai/wire";
import type { BookData } from "../book/data";
import { siteBook, type SiteOutcome } from "../book/site";
import { withChatTodo, withHold, type BookState } from "../book/state";
import { businessDayAt, calDay, demoClock, demoInstant } from "../calendar";
import { resolveMenu } from "../combo";
import type { JournalWho } from "../journal";
import { allKartes, resolveSeedKartes, toVisits, withSeedKarteEdits } from "../karte/record";
import { assembleBook } from "../book/assemble";
import type { Rule } from "../rules/types";
import { getAdsMaxAdds, type AdSettings } from "../settings";
import type { TabId } from "../tabs";
import { memoDue } from "../todo/due";
import { resolveSeedTodos, withMemoTodo } from "../todo/items";
import { maskNames, restoreNames } from "../todo/names";
import type { TodoRequest, TodoResponse } from "../todo/wire";
import { JOB_APPROVAL_RESULT, JOB_IDS, isJobDone, jobApprovalResult, withJobDone, type JobId, type JobsState } from "./state";

/** ai = Claude / script = 決まった返事（AI なし。テストと同じ物） */
export type JobMode = "ai" | "script";

/** 置き場所。読むときは毎回読みなおし、書くときは読みなおしてから変える（別の窓で変えた分を消さない） */
export type JobStore = {
  book(): BookState;
  setBook(f: (s: BookState) => BookState): void;
  ads(): AdsState;
  setAds(f: (s: AdsState) => AdsState): void;
  accounting(): AccountingState;
  jobs(): JobsState;
  setJobs(f: (s: JobsState) => JobsState): void;
};

/** AI の窓口（/api/ai/ の下の今の物）。つながらない時は no-ai を返す（投げない） */
export type JobAsk = {
  reserve(body: ReserveRequest): Promise<ReserveEvent[]>;
  ads(body: AdsRequest): Promise<AdsResponse>;
  todo(body: TodoRequest): Promise<TodoResponse>;
};

export type JobEnv = {
  data: BookData;
  /** そのブラウザのルール（鍵つきはサーバーで先頭に足しなおすので、送るのはオーナーの物だけ） */
  rules: Rule[];
  mode: JobMode;
  store: JobStore;
  ask: JobAsk;
  journal: (...lines: { who: JournalWho; text: string }[]) => void;
  now: () => Date;
  adSettings: AdSettings;
  adReport?: AdReport;
  accounting?: AccountingSeed;
  seeds?: JobSeed[];
  newId?: () => string;
  /** オーナーが予約サイトで「ネットでは受けない」にした時間（予約サイトから入る行だけに効く。book/siteStops.ts） */
  siteStops?: string[];
};

/**
 * 1行の結果。done = 済み（結果を短く）/ skip = 動かさなかった（今週の案はもうあります・もう済み）
 * no-ai = AI につながらない（済みにしない。決まった返事で動かせる）/ limit = 1回押した時の AI の上限で動かさなかった
 * failed = うまくいかなかった（済みにしない）/ busy = AI の窓口が混んでいた（429。済みにしない。待ってから押しなおせる）
 */
export type JobOutcome =
  | { kind: "done"; result: string; tab: TabId }
  | { kind: "skip"; note: string }
  | { kind: "no-ai" }
  | { kind: "busy" }
  | { kind: "limit" }
  | { kind: "failed"; note: string };

/** 1回押した時に、AI の窓口を呼べる残りの回数 */
export type JobBudget = { left: number };

/** その行が AI の窓口を呼ぶ回数の多い方（予約は「相談」と「1つ目で」の2回） */
export const AI_CALLS: Record<JobId, number> = { reserve: 2, card: 0, ads: 1, memo: 1, site: 0 };

export const JOB_NAME: Record<JobId, string> = {
  reserve: "予約の相談",
  card: "新しい明細",
  ads: "広告の見直し",
  memo: "メモ",
  site: "予約サイトから予約が入る",
};

export const ALREADY_THIS_WEEK = "今週の案はもうあります";

const CHOOSE_FIRST = "1つ目で";

export function seedOf<K extends JobId>(seeds: JobSeed[], id: K): Extract<JobSeed, { id: K }> | null {
  return (seeds.find((s) => s.id === id) as Extract<JobSeed, { id: K }> | undefined) ?? null;
}

/** 台帳を、画面と同じ組み立て方で（useBook と同じ部品）。AI に送る台帳・カルテの日付・今日 */
export function bookView(data: BookData, state: BookState, now: Date) {
  const clock = demoClock(data.shop, now, state.dayOffset);
  const nowIso = now.toISOString();
  // 台帳を組み立てる1か所（book/assemble.ts。画面の useBook と同じ。起点は休みの日を見ない・人が直した最初の予約も重ねる）
  const { anchor, all, booked } = assembleBook(data, state, clock.today, nowIso);
  const visits = toVisits(allKartes(withSeedKarteEdits(resolveSeedKartes(data.seedKartes, all), state.seedKarteEdits), state.kartes));
  return { clock, anchor, booked, visits, nowIso };
}

/** 予約の相談の文。日は「何番目の営業日」から、その日の言い方で作る（予約チャットの例文と同じ形） */
export function reserveText(data: BookData, state: BookState, now: Date, seed: Extract<JobSeed, { id: "reserve" }>): string | null {
  const { clock } = bookView(data, state, now);
  const day = businessDayAt(data.shop, clock.today, seed.day);
  const menu = resolveMenu(data.menus, seed.menuId);
  if (!day || !menu) return null;
  return `${day.label}の${seed.start}から${menu.name}をお願いします`;
}

function seedsOf(env: JobEnv): JobSeed[] {
  return env.seeds ?? getJobSeeds();
}

/** 1行を動かす。済んだ行は動かさない。済んだら JobsState に印を付け、日誌に結果を1行 */
export async function runJob(id: JobId, env: JobEnv, budget: JobBudget): Promise<JobOutcome> {
  if (isJobDone(env.store.jobs(), id)) return { kind: "skip", note: "もう済んでいます" };
  if (!seedOf(seedsOf(env), id)) return { kind: "skip", note: "これから来る物がありません" };
  const out = await (id === "reserve"
    ? reserveJob(env, budget)
    : id === "card"
      ? cardJob(env)
      : id === "ads"
        ? adsJob(env, budget)
        : id === "site"
          ? siteJob(env)
          : memoJob(env, budget));
  if (out.kind === "done") {
    const done = { at: env.now().toISOString(), result: out.result, tab: out.tab };
    env.store.setJobs((s) => withJobDone(s, id, done));
    env.journal({ who: "プログラム", text: `AI の仕事：${JOB_NAME[id]} → 済み（${out.result}）` });
  } else if (out.kind === "skip") env.journal({ who: "プログラム", text: `AI の仕事：${JOB_NAME[id]}は動かさなかった（${out.note}）` });
  else if (out.kind === "limit") env.journal({ who: "プログラム", text: `AI の仕事：${JOB_NAME[id]}は動かさなかった（1回に AI を呼ぶ回数の上限）` });
  else if (out.kind === "no-ai") env.journal({ who: "プログラム", text: `AI の仕事：${JOB_NAME[id]}は${NO_AI_MESSAGE}でした（済みにしていません）` });
  else if (out.kind === "busy") env.journal({ who: "プログラム", text: `AI の仕事：${JOB_NAME[id]}は、AI の窓口が混んでいたので動かさなかった（済みにしていません）` });
  else env.journal({ who: "プログラム", text: `AI の仕事：${JOB_NAME[id]}はうまくいきませんでした（${out.note}）` });
  return out;
}

/**
 * まとめて動かす：上から1つずつ順に。済んだ行は飛ばす。
 * AI につながらなかったら、その後の AI の行は呼ばずに no-ai にする（AI を使わない行は動かす）。
 */
export async function runJobs(
  ids: readonly JobId[],
  env: JobEnv,
  budget: JobBudget,
  onStep: (id: JobId, phase: "running" | JobOutcome) => void = () => {},
): Promise<Partial<Record<JobId, JobOutcome>>> {
  const order = JOB_IDS.filter((id) => ids.includes(id));
  const out: Partial<Record<JobId, JobOutcome>> = {};
  // つながらない・混んでいる（429）となったら、その後の AI の行は呼ばない（混んでいる時に続けて呼ぶと、また断られる）
  let aiDown: "no-ai" | "busy" | null = null;
  for (const id of order) {
    if (isJobDone(env.store.jobs(), id)) continue;
    if (aiDown && AI_CALLS[id] > 0) {
      out[id] = { kind: aiDown };
      onStep(id, out[id]!);
      continue;
    }
    onStep(id, "running");
    const r = await runJob(id, env, budget);
    out[id] = r;
    if (r.kind === "no-ai" || r.kind === "busy") aiDown = r.kind;
    onStep(id, r);
  }
  return out;
}

function take(budget: JobBudget, n: number): boolean {
  if (budget.left < n) return false;
  budget.left -= n;
  return true;
}

// ── 予約の相談 ─────────────────────────────────────────────

type ReserveRound = { reply: string; candidates: Candidate[]; hold: HoldOffer | null; todo: boolean; noAi: boolean; busy: boolean; bad: string | null };

async function reserveJob(env: JobEnv, budget: JobBudget): Promise<JobOutcome> {
  const seed = seedOf(seedsOf(env), "reserve")!;
  const customer = env.data.customers.find((c) => c.id === seed.customerId);
  if (!customer) return { kind: "failed", note: "お客様が見つかりません" };
  const text = reserveText(env.data, env.store.book(), env.now(), seed);
  if (!text) return { kind: "failed", note: "日にちかメニューが見つかりません" };
  if (!take(budget, AI_CALLS.reserve)) return { kind: "limit" };
  const who = `${customer.surname}様`;
  env.journal({ who: "オーナー", text: `AI の仕事を動かした：予約の相談（${who}「${text}」。${env.mode === "script" ? "決まった返事・AI なし" : "AI"}）` });

  const round = async (messages: ReserveRequest["messages"], candidates: Candidate[]): Promise<ReserveRound> => {
    const view = bookView(env.data, env.store.book(), env.now());
    const body: ReserveRequest = {
      mode: env.mode,
      messages,
      candidates,
      holds: [],
      customer: { id: customer.id, surname: customer.surname, firstVisit: customer.firstVisit },
      booked: view.booked,
      rules: env.rules.filter((r) => !r.locked),
      visits: view.visits.filter((v) => v.customerId === customer.id),
      dayOffset: view.clock.dayOffset,
      // 同じ時間に受ける人数（画面の台帳と同じ数）
      seats: env.data.shop.seats,
      // 休みの日（予約のページで決めた分。画面の台帳と同じ）
      holidays: env.data.shop.ownerHolidays ?? [],
      // 直したメニュー（ルールのタブ。画面の台帳と同じ data.menus）
      menus: env.data.menus,
    };
    const events = await env.ask.reserve(body);
    const r: ReserveRound = { reply: "", candidates: [], hold: null, todo: false, noAi: false, busy: false, bad: null };
    for (const e of events) {
      if (e.t === "text") r.reply += e.d;
      else if (e.t === "candidates") r.candidates = e.list;
      else if (e.t === "step") {
        if (e.step.kind === "reject" || e.step.kind === "limit")
          env.journal({ who: "プログラム", text: `${e.step.kind === "reject" ? "弾いた" : "止めた"}（${who}の相談）：${e.step.text}` });
        else if (e.step.kind === "ask") env.journal({ who: "プログラム", text: `聞き返した（${who}の相談）：${e.step.text}` });
        else if (e.step.kind === "tool") env.journal({ who: "AI", text: `道具を呼んだ（${who}の相談）：${e.step.text}` });
      } else if (e.t === "hold") {
        const h = parseHoldOffer(e.hold);
        if (!h || h.customerId !== customer.id || r.hold) continue;
        env.store.setBook((s) => withHold(s, h));
        r.hold = h;
        env.journal({ who: "AI", text: `仮押さえした：${who} ${candidateLabel(env.data, h)}（承認の箱へ）` });
      } else if (e.t === "todo") {
        let line: string | null = null;
        const today = bookView(env.data, env.store.book(), env.now()).clock.today.date;
        env.store.setBook((s) => {
          const o = withChatTodo(s, e.todo, customer.surname, env.now().toISOString(), today);
          line = o.journal;
          return o.state;
        });
        if (line) {
          r.todo = true;
          env.journal({ who: "プログラム", text: line });
        }
      } else if (e.t === "error") {
        if (e.code === "no-ai") r.noAi = true;
        else if (e.code === "busy") r.busy = true;
        else r.bad = reasonOf(e) ?? AI_FAILED_MESSAGE;
      }
    }
    return r;
  };

  const first = await round([{ role: "user", text }], []);
  if (first.noAi) return { kind: "no-ai" };
  if (first.busy) return { kind: "busy" };
  if (first.bad) return { kind: "failed", note: first.bad };
  let last = first;
  // 候補が出たら、お客様が「1つ目で」と選んだつもりで、もう1回（仮押さえまで）
  if (!first.hold && !first.todo && first.candidates.length > 0) {
    last = await round(
      [
        { role: "user", text },
        { role: "assistant", text: first.reply || "候補をお出ししました。" },
        { role: "user", text: CHOOSE_FIRST },
      ],
      first.candidates,
    );
    if (last.noAi) return { kind: "no-ai" };
    if (last.busy) return { kind: "busy" };
    if (last.bad) return { kind: "failed", note: last.bad };
  }
  if (first.hold || last.hold) return { kind: "done", result: JOB_APPROVAL_RESULT, tab: "reservations" };
  if (first.todo || last.todo) return { kind: "done", result: "ToDo に1件（お店に確かめる）", tab: "todo" };
  return { kind: "done", result: "仮押さえはしませんでした", tab: "reservations" };
}

// ── 新しい明細（AI なし） ─────────────────────────────────

/** 新しい明細の仕分け（経理の「次の明細（試し）」と同じ。いま効く自動のルールで分ける） */
export function cardSorted(seed: AccountingSeed, state: AccountingState) {
  const t = sortTrial(seed, state);
  return { total: seed.trial.items.length, auto: t.auto.length, manual: t.fresh.length + t.known.length, sorted: t };
}

async function cardJob(env: JobEnv): Promise<JobOutcome> {
  const seed = env.accounting ?? getAccounting();
  env.journal({ who: "オーナー", text: `AI の仕事を動かした：新しい明細 ${seed.trial.items.length}件（AI なし）` });
  const c = cardSorted(seed, env.store.accounting());
  env.journal({
    who: "プログラム",
    text: `新しい明細 ${c.total}件を自動のルールで仕分けた：自動 ${c.auto}件・迷う物 ${c.manual}件${c.manual ? "（経理タブへ）" : ""}`,
  });
  return { kind: "done", result: `自動 ${c.auto}件・迷う物 ${c.manual}件`, tab: "accounting" };
}

// ── 広告の見直し ──────────────────────────────────────────

/** 今週の案がもうある（承認待ち・1週間に1つまで）なら、その一言 */
export function adsBlocked(state: AdsState, nowIso: string, settings: Pick<AdSettings, "oncePerDays">): string | null {
  return canPropose(state, nowIso, settings).ok ? null : ALREADY_THIS_WEEK;
}

async function adsJob(env: JobEnv, budget: JobBudget): Promise<JobOutcome> {
  // 「7日に1つ」は広告タブと同じ時計（「翌日へ」で進めた日付。calendar.ts の demoInstant）で数える
  const nowIso = demoInstant(env.data.shop, env.now(), env.store.book().dayOffset).toISOString();
  const blocked = adsBlocked(env.store.ads(), nowIso, env.adSettings);
  if (blocked) return { kind: "skip", note: blocked };
  if (!take(budget, AI_CALLS.ads)) return { kind: "limit" };
  env.journal({ who: "オーナー", text: `AI の仕事を動かした：広告の見直し（${env.mode === "script" ? "決まった返事・AI なし" : "AI"}）` });
  const table = tableOf(env.adReport ?? getAds(), env.adSettings, env.store.ads());
  const res = await env.ask.ads({ mode: env.mode, table, rules: env.rules.filter((r) => !r.locked) });
  // 見直しを1回するたびに、広告タブに報告を1枚残す（広告タブと同じ。数はプログラムが表から入れる）
  const weekly = (x: Pick<Parameters<typeof buildWeeklyReport>[0], "proposal" | "failed">) =>
    buildWeeklyReport({
      id: `rp-${x.proposal?.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`}`,
      nowIso,
      today: demoClock(env.data.shop, env.now(), env.store.book().dayOffset).today.date,
      table,
      shop: env.data.shop,
      settings: env.adSettings,
      mode: env.mode,
      fromJobs: true,
      ...(res.ok || res.code === "gate" ? { rejected: res.rejected } : {}),
      ...x,
    });
  if (!res.ok) {
    if (res.code === "no-ai") return { kind: "no-ai" };
    if (res.code === "busy") return { kind: "busy" };
    if (res.code === "bad-request") return { kind: "failed", note: reasonOf(res) ?? AI_FAILED_MESSAGE };
  }
  const id = env.newId?.() ?? `ad-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // 受け取った案を、画面でももう一度門で確かめてから承認の箱に入れる（広告タブと同じ）
  const again = res.ok
    ? checkDraft(table, env.adSettings.towns, {
        tool: res.proposal.action === "stop" ? "stop_keyword" : "exclude_term",
        action: res.proposal.action,
        no: res.proposal.no,
        reason: res.proposal.reason,
        extraKeys: [],
      })
    : null;
  const stop = again?.ok ? again : null;
  // 足す案（広告タブと同じ：止める・外すの結果に関係なく、画面でも確かめなおす。同じ回に外す言葉は足さない）
  const addPart = addRowsFrom(table, featuredWords(env.adSettings, env.data.menus), res.adds?.picks, {
    baseId: id,
    maxAdds: getAdsMaxAdds(),
    ...(stop?.proposal.action === "exclude" ? { skipNo: stop.proposal.no } : {}),
  });
  const addSteps = [...(res.adds?.steps ?? []), ...addPart.refused];
  const addLabels = addPart.rows.map((r) => addLabel({ no: r.no, text: table.searchTerms.find((t) => t.no === r.no)?.text ?? "" }));
  const addLine = addLabels.length ? [{ who: "プログラム" as const, text: `承認の箱に入れた：足す案 ${addLabels.map((l) => `「${l}」`).join("・")}` }] : [];

  if (!res.ok || !stop) {
    const problems = !res.ok ? res.problems : again && !again.ok ? again.problems : [];
    env.journal(
      ...res.steps,
      ...(res.ok ? [{ who: "プログラム" as const, text: `画面の確認で弾いた：${problems.join("。")}（案は出さなかった）` }] : []),
      ...addSteps,
      ...addLine,
    );
    const failed = `案は${res.ok ? "画面" : "プログラム"}の確認を通らなかったので、出しませんでした（${problems.join("。")}）`;
    let added = 0;
    env.store.setAds((s) => {
      const next = addPart.rows.length ? withReview(s, { adds: addPart.rows }, table, { nowIso, mode: env.mode }, env.adSettings) : s;
      added = next === s ? 0 : addPart.rows.length;
      return withReport(next, weekly({ failed }), env.adSettings);
    });
    if (added) return { kind: "done", result: jobApprovalResult(added), tab: "ads" };
    return { kind: "done", result: "案は出ませんでした（門を通らず）", tab: "ads" };
  }
  let added = false;
  env.store.setAds((s) => {
    const next = withReview(s, { proposal: { ...stop.proposal, id, checks: stop.checks }, adds: addPart.rows }, table, { nowIso, mode: env.mode }, env.adSettings);
    added = next !== s;
    return added ? withReport(next, weekly({ proposal: { ...stop.proposal, id } }), env.adSettings) : next;
  });
  if (!added) return { kind: "skip", note: ALREADY_THIS_WEEK };
  env.journal(...res.steps, { who: "プログラム", text: `承認の箱に入れた：広告の案「${proposalLabel(stop.proposal)}」` }, ...addSteps, ...addLine);
  return { kind: "done", result: jobApprovalResult(1 + addPart.rows.length), tab: "ads" };
}

// ── メモ ─────────────────────────────────────────────────

async function memoJob(env: JobEnv, budget: JobBudget): Promise<JobOutcome> {
  const seed = seedOf(seedsOf(env), "memo")!;
  const memo = seed.text.replace(/\s+/g, " ").trim();
  if (!memo) return { kind: "failed", note: "メモが空です" };
  if (!take(budget, AI_CALLS.memo)) return { kind: "limit" };
  env.journal({ who: "オーナー", text: `AI の仕事を動かした：メモ「${memo}」（${env.mode === "script" ? "決まった返事・AI なし" : "AI"}）` });
  // お客様の名字は〔お客様〕に置きかえてから送る（メモを投げると同じ）
  const { masked, found } = maskNames(memo, env.data.customers);
  const res = await env.ask.todo({ mode: env.mode, memo: masked, rules: env.rules.filter((r) => !r.locked) });
  if (!res.ok) {
    if (res.code === "no-ai") return { kind: "no-ai" };
    if (res.code === "busy") return { kind: "busy" };
    return { kind: "failed", note: reasonOf(res) ?? AI_FAILED_MESSAGE };
  }
  const title = restoreNames(res.title, memo, found);
  const book = env.store.book();
  const view = bookView(env.data, book, env.now());
  const seedItems = resolveSeedTodos(env.data.shop, view.anchor, getTodos());
  let added: string | null = null;
  env.store.setBook((s) => {
    const r = withMemoTodo(s, seedItems, { title, memo, due: memoDue(memo, view.clock.today.date) }, env.now().toISOString(), env.data.shop);
    added = r.todo?.title ?? null;
    return r.state;
  });
  if (!added) return { kind: "done", result: "足しませんでした（同じ物があります）", tab: "todo" };
  env.journal(
    { who: res.via === "ai" ? "AI" : "プログラム", text: `メモを ToDo に足した${env.mode === "script" ? "（決まった返事）" : ""}：${title}（元のメモはそのまましまった）` },
    ...(res.note ? [{ who: "プログラム" as const, text: `メモを投げる：${res.note}` }] : []),
  );
  return { kind: "done", result: "ToDo に1件", tab: "todo" };
}

// ── 予約サイトから予約が入る（AI なし） ─────────────────────

async function siteJob(env: JobEnv): Promise<JobOutcome> {
  env.journal({ who: "オーナー", text: `AI の仕事を動かした：${JOB_NAME.site}（AI なし）` });
  let out: SiteOutcome | null = null;
  // 予約サイトの「ここで予約が入る（デモ）」と同じ変え方（空いている枠に1件。承認の箱は通さない）
  env.store.setBook((s) => {
    out = siteBook(s, { data: env.data, rules: env.rules, now: env.now(), stops: env.siteStops ?? [] }, "free");
    return out.state;
  });
  const o = out as SiteOutcome | null;
  if (!o) return { kind: "failed", note: "台帳が読めませんでした" };
  if (!o.ok) return { kind: "failed", note: o.note };
  env.journal(...o.journal);
  return o.released.length
    ? { kind: "done", result: `台帳に1件・仮押さえを外して ToDo に${o.released.length}件`, tab: "todo" }
    : { kind: "done", result: `台帳に1件（${o.surname}様）`, tab: "reservations" };
}
