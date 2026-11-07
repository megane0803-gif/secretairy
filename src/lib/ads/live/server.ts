// 広告のテスト用アカウントの窓口（src/app/api/ads/live/）の中身（サーバーの側だけ。docs/SPEC.md §1.7.8）。AI は呼ばない。
// 窓口のファイルは薄くして、ここに道具立て（deps）を渡す。テストでは fetch・時刻・乱数・置き場（KvStore）・環境変数を置きかえる。
//
// 守り（どの窓口も）：
// - 本番のサイトか・受ける形・Origin は共通の守り（src/lib/server/site.ts の siteCheck。freee と同じ物）
// - 鍵と2つの番号の3つのどれかが無い・プレビューの時は、止めて「テスト用の広告アカウントにつないでいません」（エラーにしない）
// - 書く「用意」「送る」は、Origin に加えてオーナー用の合言葉（GOOGLE_ADS_OWNER_PASSCODE。16文字より短い・無いなら動かない）が合う時だけ。
//   比べ方は共通（src/lib/server/passcode.ts。試験と同じ物）。間違いの数は窓口全体で1つ（10分に maxWrong 回まで。こえたら合っていても受けない）
// - 1日の上限（用意・送る・読み直す・止めるの数）と間違いの数は置き場（KvStore。LINE と同じ Upstash）で、先に incr で足してから比べる。
//   置き場が無い・読めない時は、数えられないので動かさない（サーバーの記憶だけで数えない）
// - 「用意」「送る」は「動いている印」（SET NX＋期限）を取れた時だけ（取れなければ「いま送っています」）
// - 番号はリクエストから受け取らない（環境変数の数字だけの値）。書き込む前に毎回テスト用アカウントかを確かめる（api.ts の mutate の入口）
// - ブラウザから来た「承認した案」は信じない：形・キャンペーンの名前・売りの言葉・町の名前・数をここで確かめ直す
// - 返事には resourceName・番号・メールを入れない（言葉の文字も、メールや長い数字の形は伏せる）。ログには何も出さない
//
// だれでも試す窓口（try。直しU）：合言葉は要らない。来た人が承認した1件を、テスト用アカウントを「元の形」に戻してから送る。
// - ブラウザから受け取るのは種類と番号の2つだけ。言葉はサーバーが最初の表（trial.ts）から引く（好きな文字を書かせない）
// - 書けるのは、テスト用アカウントの作品のキャンペーン・広告グループの中だけ。中身は表の1件と、元の形に戻す操作だけ
// - 同時に1回の印はオーナーの「用意」「送る」と同じ（withLock）。上限はオーナーの daily とは別に数える（try の day・minute・perSourceDay）
// - 送り元は Vercel が付ける送り元の IP（x-real-ip、無ければ x-vercel-forwarded-for）だけを、日ごとの塩（KV に置き2日で消える）と
//   合わせたハッシュにして数える。生の IP・ハッシュは KV のキーのほかに置かず、返事にもログにも出さない
// - Origin の確かめは、ほかのサイトからの呼び出しを止めるための物で、人の確かめではない（直に呼ばれても上の上限で止める）
// - 「最後に元の形に戻した時刻」は mutate の前に KV に置く（置けなければ書かない）。送るのに失敗しても、オーナーの印の比べが
//   「比べない側」に倒れるだけ

import { createHash, randomBytes } from "node:crypto";
import { shopNow } from "../../calendar";
import type { KvStore } from "../../line/store";
import { checkPasscode, passcodeUsable } from "../../server/passcode";
import { siteCheck } from "../../server/site";
import type { AdsLiveSettings } from "../../settings";
import { RESULT_FORMAT, SYNC_FORMAT, SYNC_VERSION, type SyncKind } from "../connect";
import { featuredWordIn } from "../featured";
import { townIn } from "../report";
import { gaqlString as q, mutate, search, verifyTestAccount, type ApiCtx } from "./api";
import { liveReady, type LiveEnv } from "./env";
import { LIVE_ERROR_MESSAGE, LiveError, unknownAfterSend } from "./errors";
import type { FetchLike } from "./token";
import {
  BUSY_MESSAGE,
  NOT_CONNECTED_MESSAGE,
  type LiveFail,
  type LiveKeyword,
  type LiveLine,
  type LiveNegative,
  type LiveReadResponse,
  type LiveResult,
  type LiveSendResponse,
  type LiveSetupResponse,
  type LiveStatusResponse,
  type LiveTryLine,
  type LiveTryResponse,
  NOT_READY_MESSAGE,
  TRY_BUSY_MESSAGE,
  type TryKind,
} from "./wire";
import type { TrialTable } from "./trial";

export type LiveDeps = {
  env: LiveEnv;
  settings: AdsLiveSettings;
  /** キャンペーンと足す先の広告グループの名前（config/ads.json の connect。直しR と同じ作り物の名前） */
  connect: { campaign: string; adGroup: string; maxItems: number };
  towns: string[];
  /** 売りの言葉（featured.ts の featuredWords） */
  words: string[];
  /** 用意で作る言葉（今の作品の「広告を出す言葉」） */
  setupKeywords: string[];
  /** だれでも試す窓口が番号から言葉を引く最初の表（trial.ts） */
  trial: TrialTable;
  siteOrigin: string;
  fetch: FetchLike;
  now: () => number;
  store: KvStore | null;
  timeZone: string;
  random?: (n: number) => Buffer;
};

// ---- 返事 ----

const NO_STORE = {
  "Cache-Control": "no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, "Content-Type": "application/json; charset=utf-8" } });
}
const fail = (code: string, message: string, status: number): Response => json({ ok: false, code, message } satisfies LiveFail, status);

// ---- 置き場の鍵（LINE・試験の鍵と分ける） ----

export const LIVE_KEY = {
  lock: "ads:live:lock",
  wrong: "ads:live:passwrong",
  /** 間違いが上限に届いた時から wrongWindowSeconds 秒、合っていても受けない印 */
  locked: "ads:live:passlock",
  day: (date: string, kind: "setup" | "send" | "read" | "stop") => `ads:live:day:${date}:${kind}`,
  /** だれでも試す窓口の数（オーナーの day とは別）。どれも DAY_SECONDS（2日）か2分で消える */
  tryDay: (date: string) => `ads:live:try:day:${date}`,
  tryMinute: (minute: number) => `ads:live:try:min:${minute}`,
  /** 送り元ごとの数。hash は日ごとの塩と送り元の IP のハッシュ（生の IP は入れない） */
  trySource: (date: string, hash: string) => `ads:live:try:src:${date}:${hash}`,
  /** 日ごとの塩（サーバーが作る。2日で消える） */
  trySalt: (date: string) => `ads:live:try:salt:${date}`,
  /** 最後に「元の形」に戻した時刻（ISO） */
  resetAt: "ads:live:resetat",
};
const DAY_SECONDS = 2 * 86_400;

class StoreDown extends Error {}

async function kv<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch {
    throw new StoreDown();
  }
}

const today = (d: LiveDeps) => shopNow({ timezone: d.timeZone }, new Date(d.now())).date;

// ---- 守り ----

type Gate = { ok: true } | { ok: false; response: Response };

/** どの窓口も最初に通す（本番のサイト・受ける形・Origin・3つの環境変数） */
function gate(request: Request, d: LiveDeps, method: "GET" | "POST"): Gate {
  const site = siteCheck(request, { vercelEnv: d.env.vercelEnv, siteOrigin: d.siteOrigin, method });
  if (site === "off") return { ok: false, response: fail("not-connected", NOT_CONNECTED_MESSAGE, 200) };
  if (site === "method") return { ok: false, response: fail("method", "受けない形です", 405) };
  if (site === "origin") return { ok: false, response: fail("origin", "本番のサイトから来た呼び出しではないので受けません", 403) };
  if (!liveReady(d.env)) return { ok: false, response: fail("not-connected", NOT_CONNECTED_MESSAGE, 200) };
  return { ok: true };
}

async function readBody(request: Request, max: number): Promise<Record<string, unknown> | "big" | null> {
  const raw = await request.text();
  if (raw.length > max) return "big";
  if (!raw) return {};
  try {
    const b = JSON.parse(raw);
    return b && typeof b === "object" && !Array.isArray(b) ? b : null;
  } catch {
    return null;
  }
}

const NO_STORE_MESSAGE = "数を数える置き場につながらないので、動かしません";
const LOCKED_MESSAGE = "オーナー用の合言葉を何回もまちがえたので、10分ほど待ってからもう一度押してください";

/**
 * オーナー用の合言葉。間違いの数は窓口全体で1つ（だれが間違えても同じ数に足す）。
 * 間違えた時は先に incr で足す。上限（maxWrong）に届いたら、その時から wrongWindowSeconds 秒の「受けない印」を置き、
 * 印がある間は、合っている合言葉でも受けない（どちらにも同じ文を返す＝合っているかを漏らさない）。
 */
async function owner(d: LiveDeps, given: unknown): Promise<Response | null> {
  const p = d.settings.passcode;
  if (!passcodeUsable(d.env.ownerPasscode, p.minChars))
    return fail("no-passcode", "オーナー用の合言葉が設定されていないので、用意と送るは動きません", 503);
  const store = d.store!;
  const r = checkPasscode(given, d.env.ownerPasscode, { maxChars: p.maxChars, minChars: p.minChars });
  if (await kv(() => store.get(LIVE_KEY.locked))) return fail("locked", LOCKED_MESSAGE, 429);
  if (r !== "ok") {
    const n = await kv(() => store.incr(LIVE_KEY.wrong, p.wrongWindowSeconds));
    if (n >= p.maxWrong) await kv(() => store.set(LIVE_KEY.locked, "1", { ex: p.wrongWindowSeconds, nx: true }));
    return n > p.maxWrong ? fail("locked", LOCKED_MESSAGE, 429) : fail("wrong", "オーナー用の合言葉がちがいます", 401);
  }
  const n = Number((await kv(() => store.get(LIVE_KEY.wrong))) ?? 0);
  if (n >= p.maxWrong) return fail("locked", LOCKED_MESSAGE, 429);
  return null;
}

/** 1日の上限：先に足してから比べる（同時に来ても数えもれが無い） */
async function underDaily(d: LiveDeps, kind: "setup" | "send" | "read"): Promise<boolean> {
  const n = await kv(() => d.store!.incr(LIVE_KEY.day(today(d), kind), DAY_SECONDS));
  return n <= d.settings.daily[kind];
}

/** 「動いている印」を取って中身を動かし、終わったら自分の印だけ消す（用意・送る・だれでも試すの3つが同じ印） */
async function withLock(d: LiveDeps, run: () => Promise<Response>, busyMessage = BUSY_MESSAGE): Promise<Response> {
  const store = d.store!;
  const mine = (d.random ?? randomBytes)(16).toString("hex");
  const got = await kv(() => store.set(LIVE_KEY.lock, mine, { ex: d.settings.lockSeconds, nx: true }));
  if (!got) return fail("busy", busyMessage, 409);
  startClock(d);
  try {
    return await run();
  } finally {
    // 読んで消すの間に期限が切れて、ほかの印に替わることは、印の期限（lockSeconds 120秒）が窓口の持ち時間（45秒）と
    // Vercel の上限（maxDuration 60秒）より長いので起きにくい（起きても、ほかの印を消すのは1回だけ）
    try {
      if ((await store.get(LIVE_KEY.lock)) === mine) await store.del(LIVE_KEY.lock);
    } catch {
      // 消せなくても期限で消える
    }
  }
}

/** 書く窓口の前半（守り → 大きさと形 → 置き場 → 合言葉）。通れば中身 */
async function writeGate(request: Request, d: LiveDeps): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const g = gate(request, d, "POST");
  if (!g.ok) return g;
  const body = await readBody(request, d.settings.maxRequestChars);
  if (body === "big") return { ok: false, response: fail("too-big", "送る物が大きすぎます", 413) };
  if (!body) return { ok: false, response: fail("bad-request", "形がおかしいです", 400) };
  if (!d.store) return { ok: false, response: fail("no-store", NO_STORE_MESSAGE, 503) };
  const o = await owner(d, body.passcode);
  if (o) return { ok: false, response: o };
  return { ok: true, body };
}

// 窓口ごとの持ち時間（始めた時から serverBudgetSeconds）。読む・送るの全部の呼び出しが同じ締め切りを使う
const deadlines = new WeakMap<LiveDeps, number>();
const startClock = (d: LiveDeps) => deadlines.set(d, d.now() + d.settings.serverBudgetSeconds * 1000);
const ctxOf = (d: LiveDeps): ApiCtx => ({ env: d.env, settings: d.settings, fetch: d.fetch, now: d.now, deadline: deadlines.get(d) });

/** うまくいかなかった訳を返事に（決まった文だけ。not-test は「テスト用アカウントではないので送りませんでした」） */
function liveFail(e: unknown): Response {
  if (e instanceof StoreDown) return fail("no-store", NO_STORE_MESSAGE, 503);
  if (e instanceof LiveError) return fail(e.code, e.message, e.code === "not-test" ? 403 : 502);
  return fail("failed", "うまくいきませんでした", 500);
}

/** 窓口の中で投げられた物を、決まった返事に（元のエラーはログにも出さない） */
async function safely(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (e) {
    return liveFail(e);
  }
}

// ---- 読む（GAQL。REMOVED は除く・名前と文字はコードでも比べ直す・ほかのアカウントの resourceName は捨てる） ----

type Row = Record<string, unknown>;
const obj = (x: unknown): Row => (x && typeof x === "object" && !Array.isArray(x) ? (x as Row) : {});
const str = (x: unknown) => (typeof x === "string" ? x : "");

/** 言葉の比べ方：空白（全角も）をそろえ、英字の大小は見ない */
export function sameWords(a: string, b: string): boolean {
  return norm(a) === norm(b);
}
const norm = (s: string) => String(s).replace(/\s+/g, " ").trim().toLowerCase();
/** 送る時の言葉の形（空白を1つにそろえる） */
const tidy = (s: string) => String(s).replace(/\s+/g, " ").trim();

type Campaign = { rn: string; status: string };
type Kw = { rn: string; status: string; text: string; match: string; groupRn: string; groupName: string };
type Neg = { rn: string; text: string; match: string };
type Group = { rn: string; name: string; status: string };

function mine(d: LiveDeps, rn: string, kind: string): boolean {
  return rn.startsWith(`customers/${d.env.customerId}/${kind}/`);
}

async function campaignsNamed(d: LiveDeps, name: string): Promise<Campaign[]> {
  const rows = await search(
    ctxOf(d),
    `SELECT campaign.resource_name, campaign.name, campaign.status FROM campaign WHERE campaign.name = ${q(name)} AND campaign.status != 'REMOVED'`,
  );
  return rows
    .map((r) => obj(r.campaign))
    .filter((c) => str(c.name) === name && str(c.status) !== "REMOVED" && mine(d, str(c.resourceName), "campaigns"))
    .map((c) => ({ rn: str(c.resourceName), status: str(c.status) }));
}

async function keywordsIn(d: LiveDeps, campaignRn: string): Promise<Kw[]> {
  const rows = await search(
    ctxOf(d),
    "SELECT ad_group_criterion.resource_name, ad_group_criterion.status, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group.resource_name, ad_group.name " +
      `FROM ad_group_criterion WHERE ad_group.campaign = ${q(campaignRn)} AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE ` +
      "AND ad_group_criterion.status != 'REMOVED' AND ad_group.status != 'REMOVED'",
  );
  return rows
    .map((r) => ({ c: obj(r.adGroupCriterion), g: obj(r.adGroup) }))
    .filter(({ c, g }) => c.negative !== true && str(c.status) !== "REMOVED" && mine(d, str(c.resourceName), "adGroupCriteria") && mine(d, str(g.resourceName), "adGroups"))
    .map(({ c, g }) => ({
      rn: str(c.resourceName),
      status: str(c.status),
      text: str(obj(c.keyword).text),
      match: str(obj(c.keyword).matchType),
      groupRn: str(g.resourceName),
      groupName: str(g.name),
    }));
}

async function negativesIn(d: LiveDeps, campaignRn: string): Promise<Neg[]> {
  const rows = await search(
    ctxOf(d),
    "SELECT campaign_criterion.resource_name, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type, campaign_criterion.negative " +
      `FROM campaign_criterion WHERE campaign_criterion.campaign = ${q(campaignRn)} AND campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE ` +
      "AND campaign_criterion.status != 'REMOVED'",
  );
  return rows
    .map((r) => obj(r.campaignCriterion))
    .filter((c) => c.negative === true && mine(d, str(c.resourceName), "campaignCriteria"))
    .map((c) => ({ rn: str(c.resourceName), text: str(obj(c.keyword).text), match: str(obj(c.keyword).matchType) }));
}

async function groupsNamed(d: LiveDeps, campaignRn: string, name: string): Promise<Group[]> {
  const rows = await search(
    ctxOf(d),
    `SELECT ad_group.resource_name, ad_group.name, ad_group.status FROM ad_group WHERE ad_group.campaign = ${q(campaignRn)} AND ad_group.name = ${q(name)} AND ad_group.status != 'REMOVED'`,
  );
  return rows
    .map((r) => obj(r.adGroup))
    .filter((g) => str(g.name) === name && str(g.status) !== "REMOVED" && mine(d, str(g.resourceName), "adGroups"))
    .map((g) => ({ rn: str(g.resourceName), name: str(g.name), status: str(g.status) }));
}

async function budgetsNamed(d: LiveDeps, name: string): Promise<{ rn: string }[]> {
  const rows = await search(
    ctxOf(d),
    `SELECT campaign_budget.resource_name, campaign_budget.name, campaign_budget.status FROM campaign_budget WHERE campaign_budget.name = ${q(name)} AND campaign_budget.status != 'REMOVED'`,
  );
  return rows
    .map((r) => obj(r.campaignBudget))
    .filter((b) => str(b.name) === name && str(b.status) !== "REMOVED" && mine(d, str(b.resourceName), "campaignBudgets"))
    .map((b) => ({ rn: str(b.resourceName) }));
}

type Snapshot = { campaign: Campaign | null; campaigns: number; keywords: Kw[]; negatives: Neg[]; groups: Group[] };

async function snapshot(d: LiveDeps): Promise<Snapshot> {
  const list = await campaignsNamed(d, d.connect.campaign);
  if (list.length !== 1) return { campaign: null, campaigns: list.length, keywords: [], negatives: [], groups: [] };
  const c = list[0];
  const [keywords, negatives, groups] = [await keywordsIn(d, c.rn), await negativesIn(d, c.rn), await groupsNamed(d, c.rn, d.connect.adGroup)];
  return { campaign: c, campaigns: 1, keywords, negatives, groups };
}

// ---- 言葉の形（送る前に断る） ----

/** 言葉の形の問題（無ければ null）：空・80文字・10語をこえる・使えない印 */
export function keywordProblem(text: string, s: Pick<AdsLiveSettings, "maxKeywordChars" | "maxKeywordWords">): string | null {
  const t = tidy(text);
  if (!t) return "言葉が空です";
  if ([...t].length > s.maxKeywordChars) return `言葉が長すぎます（${s.maxKeywordChars}文字まで）`;
  if (t.split(" ").length > s.maxKeywordWords) return `言葉の語が多すぎます（${s.maxKeywordWords}語まで）`;
  // eslint-disable-next-line no-control-regex
  if (/["[\]\u0000-\u001f\u007f]/.test(t)) return "言葉に使えない印が入っています";
  return null;
}

/** ブラウザに返す前に、メールや長い数字（番号）の形を伏せる（言葉は作品の作り物のはずだが、念のため） */
export function scrub(s: string): string {
  return String(s)
    .replace(/[^\s@]+@[^\s@]+/g, "＊")
    .replace(/\d[\d-]{5,}\d/g, "＊")
    .slice(0, 80);
}

// ---- つながっているか（Google は呼ばない） ----

export async function handleLiveStatus(request: Request, d: LiveDeps): Promise<Response> {
  const site = siteCheck(request, { vercelEnv: d.env.vercelEnv, siteOrigin: d.siteOrigin, method: "GET" });
  if (site === "method") return fail("method", "受けない形です", 405);
  const connected = site === null && liveReady(d.env);
  const body: LiveStatusResponse = { ok: true, connected, canWrite: connected && passcodeUsable(d.env.ownerPasscode, d.settings.passcode.minChars) };
  return json(body);
}

// ---- 用意（テスト用アカウントに店の広告を作る。同じ名前の物があれば作らない） ----

type Op = Record<string, unknown>;

export async function handleLiveSetup(request: Request, d: LiveDeps): Promise<Response> {
  return safely(async () => {
    const w = await writeGate(request, d);
    if (!w.ok) return w.response;
    return withLock(d, async () => {
      if (!(await underDaily(d, "setup"))) return fail("limit", `今日の「用意」は${d.settings.daily.setup}回までです`, 429);
      return setup(d);
    });
  });
}

async function setup(d: LiveDeps): Promise<Response> {
  const ctx = ctxOf(d);
  const s = d.settings;
  const cid = d.env.customerId!;
  await verifyTestAccount(ctx);
  const lines: string[] = [];

  // 用意で作る言葉（形を確かめ、こえる物は送らない）
  const wanted: string[] = [];
  for (const k of d.setupKeywords) {
    const why = keywordProblem(k, s);
    if (why) lines.push(`「${scrub(k)}」は作りませんでした（${why}）`);
    else if (!wanted.some((x) => sameWords(x, k))) wanted.push(tidy(k));
  }

  const campaigns = await campaignsNamed(d, d.connect.campaign);
  if (campaigns.length > 1) return fail("many", "同じ名前のキャンペーンが2つ以上あるので、作りませんでした", 409);
  const ops: Op[] = [];
  // 仮の番号（-1・-2・-3）：種類が違っても同じ数を使わない
  const tmp = { budget: `customers/${cid}/campaignBudgets/-1`, campaign: `customers/${cid}/campaigns/-2`, group: `customers/${cid}/adGroups/-3` };
  let campaignRn: string;
  let groupRn: string | null = null;
  let have: Kw[] = [];
  const made: string[] = [];

  if (campaigns.length === 1) {
    campaignRn = campaigns[0].rn;
    const groups = await groupsNamed(d, campaignRn, d.connect.adGroup);
    if (groups.length > 1) return fail("many", "同じ名前の広告グループが2つ以上あるので、作りませんでした", 409);
    if (groups.length === 1) {
      groupRn = groups[0].rn;
      have = (await keywordsIn(d, campaignRn)).filter((k) => k.groupRn === groupRn);
    }
    lines.push(`キャンペーン「${d.connect.campaign}」はもうあったので作りませんでした`);
  } else {
    const budgets = await budgetsNamed(d, s.budgetName);
    if (budgets.length > 1) return fail("many", "同じ名前の予算が2つ以上あるので、作りませんでした", 409);
    let budgetRn: string;
    if (budgets.length === 1) {
      budgetRn = budgets[0].rn;
      lines.push(`予算「${s.budgetName}」はもうあったので、それを使います`);
    } else {
      budgetRn = tmp.budget;
      ops.push({
        campaignBudgetOperation: {
          create: { resourceName: tmp.budget, name: s.budgetName, amountMicros: String(s.budgetMicros), deliveryMethod: "STANDARD", explicitlyShared: false },
        },
      });
      made.push("予算");
    }
    campaignRn = tmp.campaign;
    ops.push({
      campaignOperation: {
        create: {
          resourceName: tmp.campaign,
          name: d.connect.campaign,
          advertisingChannelType: "SEARCH",
          // 書かないと ENABLED になるので、止めた状態を必ず書く
          status: "PAUSED",
          campaignBudget: budgetRn,
          manualCpc: {},
          containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
          networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
        },
      },
    });
    made.push("止めたキャンペーン");
  }
  if (!groupRn) {
    groupRn = tmp.group;
    ops.push({ adGroupOperation: { create: { resourceName: tmp.group, name: d.connect.adGroup, campaign: campaignRn, type: "SEARCH_STANDARD", status: "ENABLED" } } });
    made.push("広告グループ");
  } else lines.push(`広告グループ「${d.connect.adGroup}」はもうあったので作りませんでした`);
  const missing = wanted.filter((t) => !have.some((k) => sameWords(k.text, t) && k.match === s.keywordMatch));
  for (const text of missing)
    ops.push({ adGroupCriterionOperation: { create: { adGroup: groupRn, status: "ENABLED", keyword: { text, matchType: s.keywordMatch } } } });
  if (missing.length) made.push(`言葉${missing.length}つ`);
  if (wanted.length > missing.length) lines.push(`言葉${wanted.length - missing.length}つはもうあったので作りませんでした`);

  if (ops.length === 0) return json({ ok: true, created: false, lines: ["もう用意してあります（何も作りませんでした）", ...lines] } satisfies LiveSetupResponse);

  // 先に同じ中身を validateOnly で確かめ（何も作らない）、通ったら本当に送る（1回の mutate。全部できるか、何もできないか）
  try {
    const v = await mutate(ctx, ops, { validateOnly: true, partialFailure: false });
    if (v.allFailed || v.failed.size) return fail("rejected", "作る前の確かめで通らなかったので、何も作りませんでした", 502);
  } catch (e) {
    if (e instanceof LiveError && e.code !== "not-test") return fail(e.code, `作る前の確かめができなかったので、何も作りませんでした（${e.message}）`, 502);
    throw e;
  }
  let unknown = false;
  try {
    const r = await mutate(ctx, ops, { validateOnly: false, partialFailure: false });
    if (r.allFailed || r.failed.size) return fail("rejected", "作れませんでした（何も作っていません）", 502);
  } catch (e) {
    if (!(e instanceof LiveError) || e.code === "not-test") throw e;
    if (e.before || !unknownAfterSend(e.code)) return fail(e.code, `作れませんでした（${e.message}）`, 502);
    unknown = true;
  }
  // 読み直して、本当にできたか確かめる
  try {
    const after = await snapshot(d);
    const group = after.groups.length === 1 ? after.groups[0] : null;
    const kws = group ? after.keywords.filter((k) => k.groupRn === group.rn) : [];
    const okAll = !!after.campaign && !!group && wanted.every((t) => kws.some((k) => sameWords(k.text, t) && k.match === s.keywordMatch));
    if (after.campaign && campaigns.length === 0 && after.campaign.status !== "PAUSED") lines.push("読み直すと、キャンペーンが止めた状態になっていません");
    if (!okAll && unknown) return fail("unknown", "作れたか分かりません（読み直してください。もう一度「用意」を押すと、足りない物だけ作ります）", 502);
    if (!okAll)
      return fail("failed", "読み直すと、足りない物があります（もう一度「用意」を押すと、足りない物だけ作ります）", 502);
  } catch (e) {
    if (e instanceof LiveError && e.code === "not-test") throw e;
    return fail("unknown", "作れたか分かりません（読み直してください）", 502);
  }
  return json({ ok: true, created: true, lines: [`作りました：${made.join("・")}（広告文は作りません・キャンペーンは止めたまま）`, ...lines] } satisfies LiveSetupResponse);
}

// ---- 送る（承認した案：止める・外す・足す） ----

type Item = { id: string; kind: SyncKind; text: string };

const ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const KINDS: readonly SyncKind[] = ["stop", "exclude", "add"];

/** ブラウザから来た渡す中身を確かめる（形が違えば全部断る。言葉ごとの問題は「できなかった」の行にする） */
export function readPayload(x: unknown, d: Pick<LiveDeps, "connect" | "settings">): { ok: true; items: Item[] } | { ok: false; message: string } {
  const p = obj(x);
  if (p.format !== SYNC_FORMAT || p.version !== SYNC_VERSION || !Array.isArray(p.items)) return { ok: false, message: "渡す中身の形が違います" };
  if (p.campaign !== d.connect.campaign) return { ok: false, message: "キャンペーンの名前が設定と違うので、送りませんでした" };
  if (p.adGroup !== d.connect.adGroup) return { ok: false, message: "広告グループの名前が設定と違うので、送りませんでした" };
  const max = Math.min(d.settings.maxItems, d.connect.maxItems);
  if (p.items.length === 0) return { ok: false, message: "送る案がありません" };
  if (p.items.length > max) return { ok: false, message: `1回に送る案は${max}件までです` };
  const items: Item[] = [];
  for (const raw of p.items) {
    const i = obj(raw);
    const kind = i.kind as SyncKind;
    if (typeof i.id !== "string" || !ID.test(i.id) || !KINDS.includes(kind) || typeof i.text !== "string" || [...i.text].length > 200)
      return { ok: false, message: "渡す中身の形が違います" };
    if (typeof i.approvedAt !== "string" || Number.isNaN(Date.parse(i.approvedAt))) return { ok: false, message: "渡す中身の形が違います" };
    const want = kind === "exclude" ? "exact" : kind === "add" ? "phrase" : undefined;
    if (i.match !== want) return { ok: false, message: "合い方が違います（外す＝完全一致・足す＝フレーズ一致）" };
    items.push({ id: i.id, kind, text: i.text });
  }
  return { ok: true, items };
}

/** 言葉ごとに、送ってよいか（だめなら理由） */
function itemProblem(i: Item, d: LiveDeps): string | null {
  const shape = keywordProblem(i.text, d.settings);
  if (shape) return shape;
  if (i.kind === "exclude" && townIn(i.text, d.towns)) return "町の名前の入った言葉は外しません";
  if (i.kind === "add" && !featuredWordIn(i.text, d.words)) return "売りの言葉が入っていないので足しません";
  return null;
}

export async function handleLiveSend(request: Request, d: LiveDeps): Promise<Response> {
  return safely(async () => {
    const w = await writeGate(request, d);
    if (!w.ok) return w.response;
    const p = readPayload(w.body.payload, d);
    if (!p.ok) return fail("bad-request", p.message, 400);
    return withLock(d, async () => {
      if (!(await underDaily(d, "send"))) return fail("limit", `今日の「送る」は${d.settings.daily.send}回までです`, 429);
      return send(d, p.items);
    });
  });
}

type Plan = { item: Item; key: string; line: LiveLine; op?: Op; check?: (s: Snapshot) => boolean; sent?: "ok" | "unknown" };

const kindPast: Record<SyncKind, string> = { stop: "もう止まっていた", exclude: "もう外していた", add: "もうあった" };

async function send(d: LiveDeps, items: Item[]): Promise<Response> {
  const ctx = ctxOf(d);
  // 書かない時も、まずテスト用アカウントかを確かめる（違えば「もう〜だった」とも言わない）
  await verifyTestAccount(ctx);
  // 先に読み直す（返事が消えた後のもう一度の「送る」で、重ねて変えないように）
  const snap = await snapshot(d);
  const line = (i: Item, outcome: LiveLine["outcome"], reason?: string): LiveLine => ({ id: i.id, kind: i.kind, text: i.text, outcome, ...(reason ? { reason } : {}) });

  const plans: Plan[] = [];
  const firstOf = new Map<string, Plan>();
  for (const item of items) {
    const key = `${item.kind}:${norm(item.text)}`;
    const dup = firstOf.get(key);
    if (dup) {
      plans.push({ item, key, line: line(item, "failed", "同じ案が2つあります（1つ目だけ送りました）") });
      continue;
    }
    const plan: Plan = { item, key, line: line(item, "failed") };
    firstOf.set(key, plan);
    plans.push(plan);
    const why = itemProblem(item, d);
    if (why) {
      plan.line = line(item, "failed", why);
      continue;
    }
    if (!snap.campaign) {
      plan.line = line(item, "failed", snap.campaigns === 0 ? "キャンペーンが見つかりません（先に「用意」を押してください）" : "同じ名前のキャンペーンが2つ以上あります");
      continue;
    }
    const text = tidy(item.text);
    if (item.kind === "stop") {
      // 設定のキャンペーンの中で、文字が合う物（合い方ごとの組で見て、全部で）ちょうど1つだけ
      const hits = snap.keywords.filter((k) => sameWords(k.text, text));
      if (hits.length !== 1) {
        plan.line = line(item, "failed", hits.length === 0 ? "言葉が見つかりません" : "同じ言葉が2つ以上あります");
        continue;
      }
      const k = hits[0];
      if (k.status === "PAUSED") {
        plan.line = line(item, "already", kindPast.stop);
        continue;
      }
      plan.op = { adGroupCriterionOperation: { update: { resourceName: k.rn, status: "PAUSED" }, updateMask: "status" } };
      plan.check = (s) => s.keywords.some((x) => x.rn === k.rn && x.status === "PAUSED");
    } else if (item.kind === "exclude") {
      if (snap.negatives.some((n) => sameWords(n.text, text) && n.match === "EXACT")) {
        plan.line = line(item, "already", kindPast.exclude);
        continue;
      }
      plan.op = { campaignCriterionOperation: { create: { campaign: snap.campaign.rn, negative: true, keyword: { text, matchType: "EXACT" } } } };
      plan.check = (s) => s.negatives.some((n) => sameWords(n.text, text) && n.match === "EXACT");
    } else {
      if (snap.groups.length !== 1) {
        plan.line = line(item, "failed", snap.groups.length === 0 ? "広告グループが見つかりません（先に「用意」を押してください）" : "同じ名前の広告グループが2つ以上あります");
        continue;
      }
      const g = snap.groups[0];
      if (snap.keywords.some((k) => k.groupRn === g.rn && sameWords(k.text, text) && k.match === "PHRASE")) {
        plan.line = line(item, "already", kindPast.add);
        continue;
      }
      plan.op = { adGroupCriterionOperation: { create: { adGroup: g.rn, status: "ENABLED", keyword: { text, matchType: "PHRASE" } } } };
      plan.check = (s) => s.keywords.some((k) => k.groupRn === g.rn && sameWords(k.text, text) && k.match === "PHRASE");
    }
  }

  // 止めるの1日の数（外す・足すとは別）。送る案の中の止めるの数だけ先に足してから比べる
  const stops = plans.filter((p) => p.op && p.item.kind === "stop");
  if (stops.length) {
    let n = 0;
    for (let i = 0; i < stops.length; i++) n = await kv(() => d.store!.incr(LIVE_KEY.day(today(d), "stop"), DAY_SECONDS));
    const before = n - stops.length;
    const room = Math.max(0, d.settings.daily.stop - before);
    stops.slice(room).forEach((p) => {
      p.op = undefined;
      p.check = undefined;
      p.line = line(p.item, "failed", `今日の止めるは${d.settings.daily.stop}件までです`);
    });
  }

  // 送る前に validateOnly で全部を確かめ（何も変えない）、通った物だけを本当に送る
  let todo = plans.filter((p) => p.op);
  if (todo.length) {
    try {
      const v = await mutate(ctx, todo.map((p) => p.op!), { validateOnly: true, partialFailure: true });
      todo.forEach((p, i) => {
        if (v.allFailed || v.failed.has(i)) {
          p.op = undefined;
          p.line = line(p.item, "failed", "送る前の確かめで通りませんでした");
        }
      });
    } catch (e) {
      if (e instanceof LiveError && e.code !== "not-test") {
        todo.forEach((p) => {
          p.op = undefined;
          p.line = line(p.item, "failed", `送る前の確かめができませんでした（${e.message}）`);
        });
      } else throw e;
    }
  }
  todo = plans.filter((p) => p.op);
  if (todo.length) {
    try {
      const r = await mutate(ctx, todo.map((p) => p.op!), { validateOnly: false, partialFailure: true });
      todo.forEach((p, i) => {
        // どの操作が受けられなかったか読めない時は、どれも「分からない」にして、読み直しで決める
        if (r.allFailed) p.sent = "unknown";
        else if (r.failed.has(i)) {
          p.op = undefined;
          p.line = line(p.item, "failed", "送りましたが、受けられませんでした");
        } else p.sent = "ok";
      });
    } catch (e) {
      if (!(e instanceof LiveError) || e.code === "not-test") throw e;
      const unknown = !e.before && unknownAfterSend(e.code);
      todo.forEach((p) => {
        if (unknown) p.sent = "unknown";
        else {
          p.op = undefined;
          p.line = line(p.item, "failed", `送れませんでした（${e.message}）`);
        }
      });
    }
  }

  // 送った後に読み直し、本当に変わった物だけ「反映した」
  const sent = plans.filter((p) => p.sent);
  if (sent.length) {
    let after: Snapshot | null = null;
    try {
      after = await snapshot(d);
    } catch (e) {
      if (e instanceof LiveError && e.code === "not-test") throw e;
      after = null;
    }
    for (const p of sent) {
      if (!after) p.line = line(p.item, "unknown", "分かりません（読み直してください）");
      else if (p.check!(after)) p.line = line(p.item, "done");
      else p.line = p.sent === "unknown" ? line(p.item, "unknown", "分かりません（読み直してください）") : line(p.item, "failed", "読み直しても変わっていませんでした");
    }
  }

  // 同じ案の2つ目は、1つ目と同じにしない（送ったのは1つ目だけ）。結果は直しR の「受け取る結果」と同じ形
  const lines = plans.map((p) => ({ ...p.line, text: p.item.text }));
  const result: LiveResult = {
    format: RESULT_FORMAT,
    version: SYNC_VERSION,
    campaign: d.connect.campaign,
    createdAt: new Date(d.now()).toISOString(),
    // 分からない物は結果に入れない（印も「できなかった」も付けない）
    results: lines
      .filter((l) => l.outcome !== "unknown")
      .map((l) => ({
        id: l.id,
        kind: l.kind,
        text: l.text,
        status: l.outcome === "done" || l.outcome === "already" ? ("done" as const) : ("failed" as const),
        ...(l.reason ? { reason: l.reason } : {}),
      })),
  };
  return json({ ok: true, result, lines } satisfies LiveSendResponse);
}

// ---- 読み直す（だれでも。回数の上限） ----

const MATCH_WORD: Record<string, string> = { EXACT: "完全一致", PHRASE: "フレーズ一致", BROAD: "部分一致" };
const STATUS_WORD: Record<string, string> = { ENABLED: "出す設定", PAUSED: "止めている" };

export async function handleLiveRead(request: Request, d: LiveDeps): Promise<Response> {
  return safely(async () => {
    startClock(d);
    const g = gate(request, d, "POST");
    if (!g.ok) return g.response;
    if (!d.store) return fail("no-store", NO_STORE_MESSAGE, 503);
    if (!(await underDaily(d, "read"))) return fail("limit", `今日の「読み直す」は${d.settings.daily.read}回までです`, 429);
    await verifyTestAccount(ctxOf(d));
    const snap = await snapshot(d);
    return json(listOf(d, snap, await resetAtOf(d)));
  });
}

/** 最後に「元の形」に戻した時刻（無ければ undefined。形の違う物は無いのと同じ） */
async function resetAtOf(d: LiveDeps): Promise<string | undefined> {
  const v = await kv(() => d.store!.get(LIVE_KEY.resetAt));
  return v && !Number.isNaN(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : undefined;
}

/** 読み直しの一覧（言葉・合い方・状態・広告グループだけ。resourceName・番号は入れない）。読み直すと試すの返事が同じ形 */
function listOf(d: LiveDeps, snap: Snapshot, resetAt: string | undefined): Extract<LiveReadResponse, { ok: true }> {
  const at = resetAt ? { resetAt } : {};
  if (!snap.campaign) {
    return {
      ok: true,
      campaign: { found: false, status: "" },
      keywords: [],
      negatives: [],
      note: snap.campaigns === 0 ? "キャンペーンがまだありません（オーナーが「用意」を押すと作ります）" : "同じ名前のキャンペーンが2つ以上あります",
      ...at,
    };
  }
  const keywords: LiveKeyword[] = snap.keywords
    .map((k) => ({
      text: scrub(k.text),
      match: MATCH_WORD[k.match] ?? "ほかの合い方",
      status: STATUS_WORD[k.status] ?? "ほかの状態",
      group: k.groupName === d.connect.adGroup ? d.connect.adGroup : "ほかの広告グループ",
    }))
    .sort((a, b) => a.group.localeCompare(b.group, "ja") || a.text.localeCompare(b.text, "ja"));
  const negatives: LiveNegative[] = snap.negatives.map((n) => ({ text: scrub(n.text), match: MATCH_WORD[n.match] ?? "ほかの合い方" })).sort((a, b) => a.text.localeCompare(b.text, "ja"));
  return {
    ok: true,
    campaign: { found: true, status: snap.campaign.status === "PAUSED" ? "止めている（広告は出ません）" : (STATUS_WORD[snap.campaign.status] ?? "ほかの状態") },
    keywords,
    negatives,
    ...at,
  };
}

// ---- だれでも試す（承認した1件を、元の形に戻してから送る。合言葉なし。直しU） ----

const TRY_KINDS: readonly TryKind[] = ["stop", "exclude", "add"];

/** ブラウザから来た物を読む。種類と番号の2つだけを使う（text など、ほかの欄は読まない）。2件以上・形の違う物は断る */
export function readTryItem(body: Record<string, unknown>, d: Pick<LiveDeps, "trial" | "towns" | "words" | "setupKeywords" | "settings">):
  | { ok: true; item: { kind: TryKind; no: number; text: string } }
  | { ok: false; message: string } {
  if (Array.isArray(body.items) || Array.isArray(body.kind) || Array.isArray(body.no) || Array.isArray(body.payload)) return { ok: false, message: "1回に1件だけです" };
  const kind = body.kind as TryKind;
  const no = body.no;
  if (!TRY_KINDS.includes(kind) || typeof no !== "number" || !Number.isInteger(no) || no < 0) return { ok: false, message: "形がおかしいです" };
  const t = d.trial;
  const row = (kind === "stop" ? t.keywords : t.terms).find((r) => r.no === no);
  if (!row) return { ok: false, message: kind === "stop" ? `${no}番は止められる言葉の表にありません` : `${no}番はお客さんが調べた言葉の表にありません` };
  const shape = keywordProblem(row.text, d.settings);
  if (shape) return { ok: false, message: shape };
  if (kind === "stop" && !d.setupKeywords.some((k) => sameWords(k, row.text))) return { ok: false, message: "用意した言葉のほかは止めません" };
  if (kind === "exclude" && townIn(row.text, d.towns)) return { ok: false, message: "町の名前の入った言葉は外しません" };
  if (kind === "add") {
    if (!t.addable.includes(no) || !featuredWordIn(row.text, d.words)) return { ok: false, message: "足す案の確かめを通らない番号です" };
    if (d.setupKeywords.some((k) => sameWords(k, row.text))) return { ok: false, message: "もう広告を出す言葉にあります" };
  }
  return { ok: true, item: { kind, no, text: tidy(row.text) } };
}

/** 送り元（Vercel が付ける送り元の IP だけ。ブラウザが付けられる x-forwarded-for などは見ない） */
export function sourceIp(request: Request): string {
  const real = (request.headers.get("x-real-ip") ?? "").trim();
  if (real) return real.slice(0, 64);
  const vf = (request.headers.get("x-vercel-forwarded-for") ?? "").split(",")[0].trim();
  return vf ? vf.slice(0, 64) : "unknown";
}

/**
 * 数える単位（送り元の束）。IPv4 は1つの番地のまま。IPv6 は前の半分（/64）でまとめる
 * （1人が手元で後ろの半分を変えて、同じ送り元の上限をすり抜けられないように）。IPv4 を写した IPv6（::ffff:a.b.c.d）は IPv4 として数える。
 * 読めない形は、そのままの文字を1つの束にする（ハッシュにするので置き場には生の文字は残らない）。
 */
export function sourceBucket(ip: string): string {
  const s = ip.trim().replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  if (!s.includes(":")) return s;
  const v4tail = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  let text = s;
  if (v4tail) {
    const oct = v4tail[2].split(".").map(Number);
    if (oct.some((n) => n > 255)) return s;
    if (/^(0{0,4}:){0,5}:?ffff:$/.test(v4tail[1]) || v4tail[1] === "::ffff:") return v4tail[2];
    text = `${v4tail[1]}${((oct[0] << 8) | oct[1]).toString(16)}:${((oct[2] << 8) | oct[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return s;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return s;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (all.length !== 8 || all.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return s;
  return `${all
    .slice(0, 4)
    .map((h) => parseInt(h, 16).toString(16))
    .join(":")}::/64`;
}

/**
 * 日ごとの塩（サーバーが作って KV に置く。2日で消える）。置けない・読めない時は StoreDown。
 * 置けた（SET NX が true）時は、作った値をそのまま使う（置いた直後の GET は、まだ写っていない写しから null で返ることがある）。
 * 読むのは、ほかの呼び出しがもう置いていて置けなかった時だけ。
 */
async function saltOf(d: LiveDeps, date: string): Promise<string> {
  const store = d.store!;
  const fresh = (d.random ?? randomBytes)(16).toString("hex");
  if (await kv(() => store.set(LIVE_KEY.trySalt(date), fresh, { ex: DAY_SECONDS, nx: true }))) return fresh;
  const salt = await kv(() => store.get(LIVE_KEY.trySalt(date)));
  if (!salt) throw new StoreDown();
  return salt;
}

/** 送り元のハッシュ（塩と合わせる。生の IP は返さない・置かない） */
export function sourceHash(salt: string, ip: string): string {
  return createHash("sha256").update(`${salt}\n${ip}`).digest("hex").slice(0, 32);
}

/**
 * 試す窓口の上限（先に足してから比べる）。同じ送り元 → 1分 → 1日の順で、こえたらそこで止める。
 * 同時に1回の印を取る前に数える（上限をこえた呼び出しは印を取らない＝連打でオーナーの「用意」「送る」やほかの人の試しを 409 で止めない）。
 * 印が取れずに 409 になった時も、数は戻さない（呼んだ回数として数える）。
 */
async function underTryLimits(d: LiveDeps, request: Request): Promise<Response | null> {
  const store = d.store!;
  const t = d.settings.try;
  const date = today(d);
  const hash = sourceHash(await saltOf(d, date), sourceBucket(sourceIp(request)));
  if ((await kv(() => store.incr(LIVE_KEY.trySource(date, hash), DAY_SECONDS))) > t.perSourceDay)
    return fail("limit", `今日の試しは、同じ送り元から${t.perSourceDay}回までです。明日また試せます`, 429);
  if ((await kv(() => store.incr(LIVE_KEY.tryMinute(Math.floor(d.now() / 60_000)), 120))) > t.minute)
    return fail("limit", "いま試す人が多いので、1分ほど待ってから試してください", 429);
  if ((await kv(() => store.incr(LIVE_KEY.tryDay(date), DAY_SECONDS))) > t.day) return fail("limit", `今日の試しは、サイト全体で${t.day}回までです。明日また試せます`, 429);
  return null;
}

export async function handleLiveTry(request: Request, d: LiveDeps): Promise<Response> {
  return safely(async () => {
    const g = gate(request, d, "POST");
    if (!g.ok) return g.response;
    const body = await readBody(request, d.settings.try.maxRequestChars);
    if (body === "big") return fail("too-big", "送る物が大きすぎます", 413);
    if (!body) return fail("bad-request", "形がおかしいです", 400);
    const it = readTryItem(body, d);
    if (!it.ok) return fail("bad-request", it.message, 400);
    if (!d.store) return fail("no-store", NO_STORE_MESSAGE, 503);
    // 上限は印を取る前に（こえていたら印を取らずに 429）
    const over = await underTryLimits(d, request);
    if (over) return over;
    return withLock(d, () => tryOne(d, it.item), TRY_BUSY_MESSAGE);
  });
}

type TryItem = { kind: TryKind; no: number; text: string };
export type TryPlan = { ready: false } | { ready: true; ops: Op[] };

/**
 * 今の形（snapshot）から、「元の形」にその1件を足した形にする操作を決める（1つの物は1回だけさわる）。
 *   元の形：用意の言葉がみな「出す設定」（合い方は keywordMatch）・それ以外の言葉は無い・キャンペーンのキーワードの除外（完全一致）は無い・
 *   キャンペーンは止めたまま。言葉は作品の広告グループのキーワード（除外でない物）だけを見る。除外は作品のキャンペーンの
 *   キーワードの除外（完全一致）だけを消す（地域・言語・ほかの種類の除外や設定・予算・名前には触らない）。
 * キャンペーンが無い・2つ以上・広告グループが1つでない・用意の言葉が欠けている時は ready: false（何も書かない）。
 */
export function planTry(snap: Snapshot, d: Pick<LiveDeps, "setupKeywords" | "settings" | "env">, item: TryItem): TryPlan {
  if (!snap.campaign || snap.groups.length !== 1) return { ready: false };
  const group = snap.groups[0];
  const match = d.settings.keywordMatch;
  const wanted: string[] = [];
  for (const k of d.setupKeywords) if (!keywordProblem(k, d.settings) && !wanted.some((x) => sameWords(x, k))) wanted.push(tidy(k));
  const inGroup = snap.keywords.filter((k) => k.groupRn === group.rn);
  const keep = new Map<string, "ENABLED" | "PAUSED">();
  for (const w of wanted) {
    const k = inGroup.find((x) => sameWords(x.text, w) && x.match === match && !keep.has(x.rn));
    if (!k) return { ready: false };
    keep.set(k.rn, item.kind === "stop" && sameWords(item.text, w) ? "PAUSED" : "ENABLED");
  }
  const ops: Op[] = [];
  let addHave = false;
  if (item.kind === "add") {
    const k = inGroup.find((x) => sameWords(x.text, item.text) && x.match === "PHRASE" && !keep.has(x.rn));
    if (k) {
      keep.set(k.rn, "ENABLED");
      addHave = true;
    }
  }
  if (snap.campaign.status !== "PAUSED")
    ops.push({ campaignOperation: { update: { resourceName: snap.campaign.rn, status: "PAUSED" }, updateMask: "status" } });
  for (const k of inGroup) {
    const want = keep.get(k.rn);
    if (!want) ops.push({ adGroupCriterionOperation: { remove: k.rn } });
    else if (k.status !== want) ops.push({ adGroupCriterionOperation: { update: { resourceName: k.rn, status: want }, updateMask: "status" } });
  }
  if (item.kind === "add" && !addHave)
    ops.push({ adGroupCriterionOperation: { create: { adGroup: group.rn, status: "ENABLED", keyword: { text: item.text, matchType: "PHRASE" } } } });
  let negHave = false;
  for (const n of snap.negatives.filter((x) => x.match === "EXACT")) {
    if (item.kind === "exclude" && !negHave && sameWords(n.text, item.text)) negHave = true;
    else ops.push({ campaignCriterionOperation: { remove: n.rn } });
  }
  if (item.kind === "exclude" && !negHave)
    ops.push({ campaignCriterionOperation: { create: { campaign: snap.campaign.rn, negative: true, keyword: { text: item.text, matchType: "EXACT" } } } });
  // 念のため：さわる物はみな、このアカウントの物だけ（snapshot が mine() で選んだ物）
  const own = `customers/${d.env.customerId}/`;
  const refs = ops.flatMap((op) => {
    const inner = Object.values(op)[0] as Record<string, unknown>;
    const v = inner.remove ?? (inner.update as Op | undefined)?.resourceName ?? (inner.create as Op | undefined)?.adGroup ?? (inner.create as Op | undefined)?.campaign;
    return [String(v ?? "")];
  });
  if (refs.some((r) => !r.startsWith(own))) return { ready: false };
  return { ready: true, ops };
}

const TRY_FAILED_NOTE = "読み直すと、元の形にこの1件を足した形になっていませんでした";

async function tryOne(d: LiveDeps, item: TryItem): Promise<Response> {
  const ctx = ctxOf(d);
  await verifyTestAccount(ctx);
  const snap = await snapshot(d);
  const plan = planTry(snap, d, item);
  if (!plan.ready) return fail("not-ready", NOT_READY_MESSAGE, 409);
  const line = (outcome: LiveTryLine["outcome"], reason?: string): LiveTryLine => ({ kind: item.kind, no: item.no, text: item.text, outcome, ...(reason ? { reason } : {}) });
  // もうその形（元の形にこの1件）だった：何も書かない
  if (plan.ops.length === 0) return json({ ok: true, line: line("already", "もうその形でした"), list: listOf(d, snap, await resetAtOf(d)) } satisfies LiveTryResponse);

  // mutate の前に「最後に元の形に戻した時刻」を置く（置けなければ StoreDown で書かない）
  const at = new Date(d.now()).toISOString();
  const okSet = await kv(() => d.store!.set(LIVE_KEY.resetAt, at, { ex: d.settings.try.resetMarkDays * 86_400 }));
  if (!okSet) throw new StoreDown();

  // 先に validateOnly で確かめ（何も変えない）、通ったら1回の mutate で送る（全部できるか、何もできないか）
  try {
    const v = await mutate(ctx, plan.ops, { validateOnly: true, partialFailure: false });
    if (v.allFailed || v.failed.size) return fail("rejected", "送る前の確かめで通らなかったので、何も書きませんでした", 502);
  } catch (e) {
    if (e instanceof LiveError && e.code !== "not-test") return fail(e.code, `送る前の確かめができなかったので、何も書きませんでした（${e.message}）`, 502);
    throw e;
  }
  let sent: "ok" | "unknown" | "failed" = "ok";
  let why = "";
  try {
    const r = await mutate(ctx, plan.ops, { validateOnly: false, partialFailure: false });
    if (r.allFailed || r.failed.size) {
      sent = "failed";
      why = "送りましたが、受けられませんでした";
    }
  } catch (e) {
    if (!(e instanceof LiveError) || e.code === "not-test") throw e;
    if (!e.before && unknownAfterSend(e.code)) sent = "unknown";
    else {
      sent = "failed";
      why = `送れませんでした（${e.message}）`;
    }
  }
  // 同じ流れの中で読み直す（この窓口の1回に含める。「読み直す」の数には足さない）
  let after: Snapshot | null = null;
  try {
    after = await snapshot(d);
  } catch (e) {
    if (e instanceof LiveError && e.code === "not-test") throw e;
    after = null;
  }
  const list = after ? listOf(d, after, at) : null;
  if (!after) return json({ ok: true, line: line(sent === "failed" ? "failed" : "unknown", sent === "failed" ? why : "分かりません（読み直してください）"), list } satisfies LiveTryResponse);
  const p2 = planTry(after, d, item);
  const atTarget = p2.ready && p2.ops.length === 0;
  const outcome: LiveTryLine = atTarget
    ? line("done")
    : sent === "unknown"
      ? line("unknown", "分かりません（読み直してください）")
      : line("failed", sent === "failed" ? why : TRY_FAILED_NOTE);
  return json({ ok: true, line: outcome, list } satisfies LiveTryResponse);
}

export { LIVE_ERROR_MESSAGE };
