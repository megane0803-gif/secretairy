// ホームの「AI の仕事」の流れ（docs/SPEC.md §1.12）。押した時に、これから来る物を1行ずつ動かし、結果をそれぞれの場所に届ける。
//   予約の相談 … 架空のお客様の文1件を、予約チャットと同じ /api/ai/reserve へ → 返事をして仮押さえ → 承認の箱へ
//   新しい明細 … 経理の「次の明細（試し）」の架空の明細を、いま効く自動のルールで仕分け（AI なし）→ 迷う物は経理タブへ
//   広告の見直し … 広告タブと同じ /api/ai/ads → 画面でももう一度門 → 承認の箱へ（今週の案がもうある時は動かさない）
//   メモ … 架空のメモ1件を、メモを投げると同じ /api/ai/todo → ToDo へ
//   予約サイトから予約が入る … 予約サイト（架空）の「ここで予約が入る（デモ）」と同じ（AI なし。book/site.ts）→ 台帳へ（承認の箱は通さない）
//
// 置き場所（JobStore）と AI の窓口（JobAsk）は外から渡す：画面はブラウザの中と fetch、テストはメモリと決まった返事。
// 🔒 確定は人：ここから呼ぶのは仮押さえ（withHold）・承認の箱に入れる（withProposal）・ToDo に足すだけ。確定の変え方は呼ばない。
// 🔒 AI を呼ぶ回数は、1回押した時に config/ai.json の jobs.maxAiCallsPerPress まで（足りない行は動かさない）。

import { getAccounting, getAds, getJobSeeds, getTodos } from "../data/seed";
import type { AccountingSeed, AdReport, JobSeed } from "../data/types";
import { sortTrial, type AccountingState } from "../accounting/state";
import { checkDraft, proposalLabel } from "../ads/gate";
import { buildTable } from "../ads/report";
import { canPropose, offNos, withProposal, type AdsState } from "../ads/state";
import type { AdsRequest, AdsResponse } from "../ads/wire";
import { candidateLabel } from "../ai/slots";
import { NO_AI_MESSAGE, parseHoldOffer, type Candidate, type HoldOffer, type ReserveEvent, type ReserveRequest } from "../ai/wire";
import type { BookData } from "../book/data";
import { siteBook, type SiteOutcome } from "../book/site";
import { activeChat, withChatTodo, withHold, type BookState } from "../book/state";
import { businessDayAt, calDay, demoClock } from "../calendar";
import { resolveMenu } from "../combo";
import type { JournalWho } from "../journal";
import { allKartes, resolveSeedKartes, toVisits } from "../karte/record";
import { loadBook, resolveChatReservations, sortReservations } from "../reservations";
import type { Rule } from "../rules/types";
import type { AdSettings } from "../settings";
import type { TabId } from "../tabs";
import { memoDue } from "../todo/due";
import { resolveSeedTodos, withMemoTodo } from "../todo/items";
import { maskNames, restoreNames } from "../todo/names";
import type { TodoRequest, TodoResponse } from "../todo/wire";
import { JOB_IDS, isJobDone, withJobDone, type JobId, type JobsState } from "./state";

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
};

/**
 * 1行の結果。done = 済み（結果を短く）/ skip = 動かさなかった（今週の案はもうあります・もう済み）
 * no-ai = AI につながらない（済みにしない。決まった返事で動かせる）/ limit = 1回押した時の AI の上限で動かさなかった
 * failed = うまくいかなかった（済みにしない）
 */
export type JobOutcome =
  | { kind: "done"; result: string; tab: TabId }
  | { kind: "skip"; note: string }
  | { kind: "no-ai" }
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
  const anchorDay = calDay(data.shop, state.anchor);
  const anchor = anchorDay.open ? anchorDay : clock.today;
  const chat = resolveChatReservations(data.menus, data.customers, activeChat(state, nowIso));
  const all = sortReservations(loadBook(data.shop, data.menus, clock.today, anchor, chat).all);
  const booked = all.map((r) => ({
    id: r.id,
    customerId: r.customer.id,
    menuId: r.menu.id,
    date: r.date,
    start: r.start,
    status: r.status,
    newCustomer: r.customer.firstVisit,
  }));
  const visits = toVisits(allKartes(resolveSeedKartes(data.seedKartes, all), state.kartes));
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
  let aiDown = false;
  for (const id of order) {
    if (isJobDone(env.store.jobs(), id)) continue;
    if (aiDown && AI_CALLS[id] > 0) {
      out[id] = { kind: "no-ai" };
      onStep(id, out[id]!);
      continue;
    }
    onStep(id, "running");
    const r = await runJob(id, env, budget);
    out[id] = r;
    if (r.kind === "no-ai") aiDown = true;
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

type ReserveRound = { reply: string; candidates: Candidate[]; hold: HoldOffer | null; todo: boolean; noAi: boolean; bad: string | null };

async function reserveJob(env: JobEnv, budget: JobBudget): Promise<JobOutcome> {
  const seed = seedOf(seedsOf(env), "reserve")!;
  const customer = env.data.customers.find((c) => c.id === seed.customerId);
  if (!customer) return { kind: "failed", note: "お客様が見つかりません" };
  const text = reserveText(env.data, env.store.book(), env.now(), seed);
  if (!text) return { kind: "failed", note: "日にちかメニューが見つかりません" };
  if (!take(budget, AI_CALLS.reserve)) return { kind: "limit" };
  const who = `${customer.surname}（架空）様`;
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
    };
    const events = await env.ask.reserve(body);
    const r: ReserveRound = { reply: "", candidates: [], hold: null, todo: false, noAi: false, bad: null };
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
        else r.bad = e.message;
      }
    }
    return r;
  };

  const first = await round([{ role: "user", text }], []);
  if (first.noAi) return { kind: "no-ai" };
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
    if (last.bad) return { kind: "failed", note: last.bad };
  }
  if (first.hold || last.hold) return { kind: "done", result: "承認待ち1件", tab: "reservations" };
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
  const nowIso = env.now().toISOString();
  const blocked = adsBlocked(env.store.ads(), nowIso, env.adSettings);
  if (blocked) return { kind: "skip", note: blocked };
  if (!take(budget, AI_CALLS.ads)) return { kind: "limit" };
  env.journal({ who: "オーナー", text: `AI の仕事を動かした：広告の見直し（${env.mode === "script" ? "決まった返事・AI なし" : "AI"}）` });
  const table = buildTable(env.adReport ?? getAds(), env.adSettings, offNos(env.store.ads()));
  const res = await env.ask.ads({ mode: env.mode, table, rules: env.rules.filter((r) => !r.locked) });
  if (!res.ok) {
    if (res.code === "no-ai") return { kind: "no-ai" };
    if (res.code === "bad-request") return { kind: "failed", note: res.message };
    env.journal(...res.steps);
    return { kind: "done", result: "案は出ませんでした（門を通らず）", tab: "ads" };
  }
  // 受け取った案を、画面でももう一度門で確かめてから承認の箱に入れる（広告タブと同じ）
  const again = checkDraft(table, env.adSettings.towns, {
    tool: res.proposal.action === "stop" ? "stop_keyword" : "exclude_term",
    action: res.proposal.action,
    no: res.proposal.no,
    reason: res.proposal.reason,
    extraKeys: [],
  });
  if (!again.ok) {
    env.journal(...res.steps, { who: "プログラム", text: `画面の確認で弾いた：${again.problems.join("。")}（案は出さなかった）` });
    return { kind: "done", result: "案は出ませんでした（門を通らず）", tab: "ads" };
  }
  const id = env.newId?.() ?? `ad-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let added = false;
  env.store.setAds((s) => {
    const next = withProposal(s, again.proposal, table, { id, checks: again.checks, nowIso, mode: env.mode }, env.adSettings);
    added = next !== s;
    return next;
  });
  if (!added) return { kind: "skip", note: ALREADY_THIS_WEEK };
  env.journal(...res.steps, { who: "プログラム", text: `承認の箱に入れた：広告の案「${proposalLabel(again.proposal)}」` });
  return { kind: "done", result: "承認待ち1件", tab: "ads" };
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
    return { kind: "failed", note: res.message };
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
  // 予約サイト（架空）の「ここで予約が入る（デモ）」と同じ変え方（空いている枠に1件。承認の箱は通さない）
  env.store.setBook((s) => {
    out = siteBook(s, { data: env.data, rules: env.rules, now: env.now() }, "free");
    return out.state;
  });
  const o = out as SiteOutcome | null;
  if (!o) return { kind: "failed", note: "台帳が読めませんでした" };
  if (!o.ok) return { kind: "failed", note: o.note };
  env.journal(...o.journal);
  return o.released.length
    ? { kind: "done", result: `台帳に1件・仮押さえを外して ToDo に${o.released.length}件`, tab: "todo" }
    : { kind: "done", result: `台帳に1件（${o.surname}（架空）様）`, tab: "reservations" };
}
