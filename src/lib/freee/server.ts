// freee（テスト事業所）の窓口（src/app/api/freee/）の中身。AI は呼ばない。サーバーには何も残さない。
// 窓口のファイルは薄くして、ここに道具立て（deps）を渡す。テストでは fetch・時刻・乱数・環境変数を置きかえる。
//
// 守り（どの窓口も）：
// - 本番（VERCEL_ENV=production）で、本番のサイトの名前（host）に来た呼び出しだけ。プレビューの URL では全部止める
// - 書く窓口（明細を入れる・登録する・読み直す・つなぎを外す・つなぐ）は POST だけで、Origin が本番のサイトの時だけ
// - 鍵は暗号化した cookie（HttpOnly・Secure・SameSite・このサイトだけ）。cookie が無い呼び出しは受けない（つなぐ・戻り先を除く）
//   （置き場（KV）の鍵でこの窓口は通さない。KV の鍵を使うのは、来た人用の窓口 /api/freee/try だけ。src/lib/freee/try.ts）
// - オーナーが1回つないだら、更新用の鍵ごと置き場に暗号化して置く（src/lib/freee/kv.ts）。「つなぎを外す」で、先に来た人の試しを元に戻してから消す
// - 書く窓口（明細を入れる・登録）は、来た人の登録・元に戻すと同じ「同時に1回」の印を取る（置き場がある時）
// - 事業所の番号は、鍵の返事に入っていた番号（cookie の中）と FREEE_COMPANY_ID がちょうど同じ時だけ。ブラウザから来た番号は使わない
// - 許可の返事・どの返事もキャッシュさせない

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { accountOf, listRange, sideOf, type ListedTxn } from "../accounting/rows";
import { isRealDate } from "../calendar";
import type { AccountingSeed, CardItem, CardUse, StatementAccount } from "../data/types";
import type { KvStore } from "../line/store";
import type { FreeeSettings } from "../settings";
import {
  exchangeCode,
  freeeClient,
  FreeeBadShape,
  FreeeExpired,
  FreeeNoAnswer,
  FreeeOutOfTime,
  FreeeRejected,
  FreeeServerError,
  isOpen,
  type FetchLike,
  type FreeeClient,
  type WalletTxn,
} from "./api";
import {
  descriptionOf,
  lookup,
  lookupById,
  markOf,
  pickBankAccount,
  pickCardAccount,
  pickOne,
  useAllowed,
  verdictOf,
  WALLETABLE_TYPE,
  type BankAccount,
  type Verdict,
} from "./match";
import { siteCheck } from "../server/site";
import { currentGen, dropKvToken, putKvToken, readKvToken, StoreDown, withWriteLock, type KvCtx } from "./kv";
import { seal, unseal } from "./seal";
import { clearRepairedTrial, loadTrial, restoreTrial, type RestoreResult } from "./trial";

export const TOKEN_COOKIE = "__Host-secretairy-freee";
export const STATE_COOKIE = "__Host-secretairy-freee-state";

export type FreeeEnv = {
  vercelEnv: string | null;
  clientId: string | null;
  clientSecret: string | null;
  /** FREEE_COMPANY_ID。空なら null（その時だけ、許可の後に番号を出して止める） */
  companyId: number | null;
  /** FREEE_COMPANY_ID に数でない物が入っている */
  companyIdBad: boolean;
  cookieKey: Buffer | null;
  /** FREEE_COOKIE_KEY に何か入っている（32バイトでない時に「無い」と分けて出すため） */
  cookieKeyGiven: boolean;
};

export type FreeeDeps = {
  env: FreeeEnv;
  settings: FreeeSettings;
  seed: AccountingSeed;
  fetch: FetchLike;
  now: () => number;
  random: (n: number) => Buffer;
  /** 店の時間帯（読む期間の「今日」を決める。config/shop.json の timezone） */
  timeZone: string;
  /** 置き場（Upstash。KV の環境変数が無ければ null。その時は、来た人用の窓口は動かず、オーナーの窓口は印なしで今どおり） */
  store?: KvStore | null;
};

/** 置き場の道具（置き場と暗号の鍵がある時だけ） */
export function kvCtxOf(deps: FreeeDeps): KvCtx | null {
  if (!deps.store || !deps.env.cookieKey) return null;
  return { store: deps.store, cookieKey: deps.env.cookieKey, settings: deps.settings, now: deps.now, random: deps.random };
}

export function envFrom(e: Record<string, string | undefined>, cookieKey: Buffer | null): FreeeEnv {
  const raw = (e.FREEE_COMPANY_ID ?? "").trim();
  const ok = /^[1-9]\d{0,18}$/.test(raw);
  return {
    vercelEnv: e.VERCEL_ENV ?? null,
    clientId: e.FREEE_CLIENT_ID?.trim() || null,
    clientSecret: e.FREEE_CLIENT_SECRET?.trim() || null,
    companyId: ok ? Number(raw) : null,
    companyIdBad: raw !== "" && !ok,
    cookieKey,
    cookieKeyGiven: !!e.FREEE_COOKIE_KEY?.trim(),
  };
}

/**
 * つなぐのに要る環境変数のうち、サーバーが読めていない物の名前（中身は出さない）。空ならつなげる。
 * FREEE_COMPANY_ID が空なのは問題にしない（許可の後に番号を出して止めるため）。
 */
export function envProblems(env: FreeeEnv): string[] {
  const out: string[] = [];
  if (!env.clientId) out.push("FREEE_CLIENT_ID");
  if (!env.clientSecret) out.push("FREEE_CLIENT_SECRET");
  if (!env.cookieKey) out.push(env.cookieKeyGiven ? "FREEE_COOKIE_KEY（32バイトを base64 にした文字ではない）" : "FREEE_COOKIE_KEY");
  if (env.companyIdBad) out.push("FREEE_COMPANY_ID（数ではない）");
  return out;
}

// ---- 返事 ----

// どの返事も、ブラウザにも本番の CDN にも覚えさせない（cookie の有る無しで答えが変わるので Vary: Cookie も）
const NO_STORE = {
  "Cache-Control": "no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  Vary: "Cookie",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
};

export function json(body: unknown, status = 200, cookies: string[] = []): Response {
  const h = new Headers({ ...NO_STORE, "Content-Type": "application/json; charset=utf-8" });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(JSON.stringify(body), { status, headers: h });
}

function redirect(location: string, cookies: string[] = []): Response {
  const h = new Headers({ ...NO_STORE, Location: location });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(null, { status: 303, headers: h });
}

function cookie(name: string, value: string, p: { maxAge: number; sameSite: "Strict" | "Lax" }): string {
  return `${name}=${value}; Path=/; Max-Age=${Math.max(0, Math.floor(p.maxAge))}; HttpOnly; Secure; SameSite=${p.sameSite}`;
}
const clearToken = () => cookie(TOKEN_COOKIE, "", { maxAge: 0, sameSite: "Strict" });
const clearState = () => cookie(STATE_COOKIE, "", { maxAge: 0, sameSite: "Lax" });

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

// ---- 守り ----

export type Session = { accessToken: string; companyId: number; expiresAt: number };

type Guarded = { ok: true; session: Session | null } | { ok: false; response: Response };

/**
 * どの窓口も最初に通す。
 * method：受ける形（ほかは 405）。session：cookie の鍵が要るか。
 */
export function guard(request: Request, deps: FreeeDeps, p: { method: "GET" | "POST"; session: boolean; needCompany?: boolean; envCheck?: boolean }): Guarded {
  const { env, settings } = deps;
  // 本番のサイトか・受ける形・Origin は共通の守り（src/lib/server/site.ts。広告のテスト用アカウントの窓口も同じ物）
  const site = siteCheck(request, { vercelEnv: env.vercelEnv, siteOrigin: settings.siteOrigin, method: p.method });
  // プレビュー・手元・本番の別の URL では、freee の窓口を全部止める
  if (site === "off") return { ok: false, response: json({ ok: false, code: "off", message: "ここでは freee につなぎません（本番のサイトだけ）" }, 404) };
  if (site === "method") return { ok: false, response: json({ ok: false, code: "method", message: "受けない形です" }, 405) };
  if (site === "origin") return { ok: false, response: json({ ok: false, code: "origin", message: "本番のサイトから来た呼び出しではないので受けません" }, 403) };
  if (p.envCheck === false) return { ok: true, session: null };
  const missing = envProblems(env);
  if (missing.length) {
    // 名前だけをログに出す（中身は出さない）
    console.warn(`freee: 環境変数を読めていません：${missing.join("・")}`);
    return { ok: false, response: json({ ok: false, code: "not-set", message: "freee の環境変数がそろっていません", missing }, 503) };
  }
  if (p.needCompany !== false && env.companyId === null)
    return { ok: false, response: json({ ok: false, code: "no-company-id", message: "FREEE_COMPANY_ID がまだ空です" }, 503) };
  if (!p.session) return { ok: true, session: null };
  // 鍵の cookie を読むには暗号の鍵が要る（ここまで来て無いのは envCheck を外した時だけ。受けない）
  if (!env.cookieKey) return { ok: false, response: json({ ok: false, code: "not-set", message: "freee の環境変数がそろっていません", missing: envProblems(env) }, 503) };

  const sealed = readCookie(request, TOKEN_COOKIE);
  if (!sealed) return { ok: false, response: json({ ok: false, code: "no-cookie", message: "freee とつながっていません" }, 401) };
  const s = unseal(env.cookieKey, "token", sealed) as Partial<Session> | null;
  if (!s || typeof s.accessToken !== "string" || typeof s.companyId !== "number" || typeof s.expiresAt !== "number")
    return { ok: false, response: json({ ok: false, code: "no-cookie", message: "freee とつながっていません" }, 401, [clearToken()]) };
  if (s.expiresAt <= deps.now())
    return { ok: false, response: json({ ok: false, code: "expired", message: "freee の鍵が切れました。もう一度 freee とつないでください" }, 401, [clearToken()]) };
  // 鍵の返事に入っていた事業所の番号だけを、FREEE_COMPANY_ID と比べる
  if (s.companyId !== env.companyId)
    return { ok: false, response: json({ ok: false, code: "wrong-company", message: "テスト事業所ではないので止めました" }, 403, [clearToken()]) };
  return { ok: true, session: { accessToken: s.accessToken, companyId: s.companyId, expiresAt: s.expiresAt } };
}

export async function readBody(request: Request, max: number): Promise<Record<string, unknown> | null> {
  const raw = await request.text();
  if (raw.length > max) return null;
  if (!raw) return {};
  try {
    const b = JSON.parse(raw);
    return b && typeof b === "object" && !Array.isArray(b) ? b : null;
  } catch {
    return null;
  }
}

const b64url = (b: Buffer) => b.toString("base64url");
const redirectUri = (s: FreeeSettings) => new URL(s.callbackPath, s.siteOrigin).toString();

// ---- つなぐ（POST /api/freee/start → freee の許可の画面へ） ----

export async function handleStart(request: Request, deps: FreeeDeps): Promise<Response> {
  // FREEE_COMPANY_ID が空でも始められる（許可の後に番号を出して止めるため）
  const g = guard(request, deps, { method: "POST", session: false, needCompany: false });
  if (!g.ok) return g.response;
  const { settings, env } = deps;
  const state = b64url(deps.random(32));
  const verifier = b64url(deps.random(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const expiresAt = deps.now() + settings.stateMinutes * 60_000;
  const sealed = seal(env.cookieKey!, "state", { state, verifier, expiresAt }, deps.random);
  const url = new URL(settings.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.clientId!);
  url.searchParams.set("redirect_uri", redirectUri(settings));
  url.searchParams.set("state", state);
  // 事業所を選ぶ画面を出す指定
  url.searchParams.set("prompt", "select_company");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return redirect(url.toString(), [cookie(STATE_COOKIE, sealed, { maxAge: settings.stateMinutes * 60, sameSite: "Lax" })]);
}

// ---- 戻り先（GET /api/freee/callback） ----

function back(code: string, cookies: string[]): Response {
  return redirect(`/accounting?freee=${encodeURIComponent(code)}#freee`, cookies);
}

function companyIdPage(companyId: number): Response {
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>事業所の番号</title></head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 16px;line-height:1.7">
<h1 style="font-size:1.3rem">許可で選んだ事業所の番号</h1>
<p style="font-size:2rem;font-weight:bold">${companyId}</p>
<p>FREEE_COMPANY_ID がまだ空なので、ここで止めました。受け取った鍵は捨てました（どこにも残していません）。</p>
<p>テスト事業所の番号なら、Vercel の環境変数 FREEE_COMPANY_ID（Production）に入れて作り直してから、もう一度つないでください。</p>
<p><a href="/accounting">経理のタブに戻る</a></p>
</body></html>`;
  const h = new Headers({ ...NO_STORE, "Content-Type": "text/html; charset=utf-8" });
  h.append("Set-Cookie", clearState());
  h.append("Set-Cookie", clearToken());
  return new Response(html, { status: 200, headers: h });
}

export async function handleCallback(request: Request, deps: FreeeDeps): Promise<Response> {
  const g = guard(request, deps, { method: "GET", session: false, needCompany: false });
  if (!g.ok) return g.response;
  const { env, settings } = deps;
  // 合図は1回だけ：どの道でも state の cookie を消す
  const cookies = [clearState()];
  const q = new URL(request.url).searchParams;
  const sealed = readCookie(request, STATE_COOKIE);
  const saved = unseal(env.cookieKey!, "state", sealed) as { state?: unknown; verifier?: unknown; expiresAt?: unknown } | null;
  const given = q.get("state") ?? "";
  if (!saved || typeof saved.state !== "string" || typeof saved.verifier !== "string" || typeof saved.expiresAt !== "number") return back("state", cookies);
  if (saved.expiresAt <= deps.now()) return back("state", cookies);
  const a = Buffer.from(given);
  const b = Buffer.from(saved.state);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return back("state", cookies);
  if (q.get("error")) return back("denied", cookies);
  const code = q.get("code");
  if (!code || code.length > 2000) return back("failed", cookies);

  let token;
  try {
    token = await exchangeCode({
      fetch: deps.fetch,
      settings,
      clientId: env.clientId!,
      clientSecret: env.clientSecret!,
      code,
      codeVerifier: saved.verifier,
      redirectUri: redirectUri(settings),
    });
  } catch {
    return back("failed", cookies);
  }
  // 比べるのは、鍵の返事に入っていた事業所の番号だけ。無い・違う時は鍵を捨てて止める
  if (token.companyId === null) return back("no-company", [...cookies, clearToken()]);
  if (env.companyId === null) return companyIdPage(token.companyId);
  if (token.companyId !== env.companyId) return back("wrong-company", [...cookies, clearToken()]);
  const seconds = Math.min(token.expiresIn, settings.maxTokenSeconds);
  const session: Session = { accessToken: token.accessToken, companyId: token.companyId, expiresAt: deps.now() + seconds * 1000 };
  const tokenCookie = cookie(TOKEN_COOKIE, seal(env.cookieKey!, "token", session, deps.random), { maxAge: seconds, sameSite: "Strict" });
  // 置き場がある時：サーバーがつながりを持ち続ける（更新用の鍵ごと暗号化して置く）。置けなければ cookie だけ（来た人は試せない）
  const c = kvCtxOf(deps);
  if (!c) return back("connected", [...cookies, tokenCookie]);
  const shared = token.refreshToken !== null && (await putKvToken(c, { ...session, refreshToken: token.refreshToken }));
  if (shared) await afterConnect(deps, session);
  return back(shared ? "connected" : "connected-cookie", [...cookies, tokenCookie]);
}

/**
 * つないだ後：前の回に元に戻せなかった試しを、オーナーの鍵で元に戻す。要復旧の記録は、オーナーが freee の側で
 * 見本どおりの未処理に直してあれば消す（読むだけで確かめる。消す・作り直すはしない）。どちらもうまくいかなければ記録は残す。
 */
async function afterConnect(deps: FreeeDeps, s: Session): Promise<void> {
  try {
    const t = await loadTrial(deps.store!);
    if (t.items.length === 0 && !t.repair) return;
    await withWriteLock({ store: deps.store!, settings: deps.settings, now: deps.now, random: deps.random }, async (until) => {
      const ctx = { api: clientFor(deps, s, until), store: deps.store!, settings: deps.settings, seed: deps.seed, companyId: s.companyId, range: readRange(deps) };
      if (t.repair) await clearRepairedTrial(ctx);
      else await restoreTrial(ctx);
      return null;
    });
  } catch {
    // 記録は残る（次の呼び出しで続き）
  }
}

// ---- つながっているか（GET /api/freee/status） ----

/**
 * cookie が無い・読めない・鍵が切れた時は、環境変数の確かめより先に「つながっていない」（401）で返す。
 * canConnect：つなぐのに要る環境変数をサーバーが読めているか。missing：読めていない名前（中身は出さない）。
 * 環境変数が本当に欠けている時も、cookie が無ければ「つながっていない」＋ canConnect: false（画面はつなぐ所に名前を出す）。
 */
export async function handleStatus(request: Request, deps: FreeeDeps): Promise<Response> {
  const pre = guard(request, deps, { method: "GET", session: false, envCheck: false });
  if (!pre.ok) return pre.response;
  const missing = envProblems(deps.env);
  const canConnect = missing.length === 0;
  const notConnected = (code: "no-cookie" | "expired", cookies: string[] = []) =>
    json(
      {
        ok: false,
        code,
        message: code === "expired" ? "freee の鍵が切れました。もう一度 freee とつないでください" : "freee とつながっていません",
        canConnect,
        ...(missing.length ? { missing } : {}),
      },
      401,
      cookies,
    );
  if (!readCookie(request, TOKEN_COOKIE) || !deps.env.cookieKey) return notConnected("no-cookie");
  const g = guard(request, deps, { method: "GET", session: true });
  if (g.ok) return json({ ok: true, connected: true, expiresAt: new Date(g.session!.expiresAt).toISOString(), ...(await sharedState(deps)) });
  const code = ((await g.response.clone().json()) as { code?: unknown }).code;
  if (code === "no-cookie" || code === "expired") return notConnected(code, g.response.headers.getSetCookie());
  return g.response;
}

/**
 * オーナーの画面に出す：サーバーがつながりを持っているか（来た人も試せるか）と、元に戻す記録の様子。
 * 置き場が無い時は shared: false。読めない時は null（どちらも中身・番号は出さない）。
 */
async function sharedState(deps: FreeeDeps): Promise<{ shared: boolean | null; trial: "repair" | "pending" | null }> {
  const c = kvCtxOf(deps);
  if (!c) return { shared: false, trial: null };
  try {
    const got = await readKvToken(c);
    const shared = !!got && got.token.companyId === deps.env.companyId && got.token.gen === (await currentGen(c.store));
    const t = await loadTrial(c.store);
    return { shared, trial: t.repair ? "repair" : t.items.length ? "pending" : null };
  } catch {
    return { shared: null, trial: null };
  }
}

// ---- つなぎを外す（POST /api/freee/disconnect） ----

export async function handleDisconnect(request: Request, deps: FreeeDeps): Promise<Response> {
  const g = guard(request, deps, { method: "POST", session: true });
  // cookie が無い・切れた・違う事業所の時も、cookie は消す（受けた扱いにはしない）
  if (!g.ok) {
    const h = new Headers(g.response.headers);
    if (g.response.status === 401 || g.response.status === 403) h.append("Set-Cookie", clearToken());
    return new Response(g.response.body, { status: g.response.status, headers: h });
  }
  // 置き場の鍵も消す。その前に、まだ元に戻していない来た人の試しがあれば、オーナーの鍵で先に元に戻す
  // （戻せなければ、元に戻す記録（明細と取引の番号）は置き場に残す。次につないだ時に元に戻す）
  const c = kvCtxOf(deps);
  if (!c) return json({ ok: true, restored: "none" }, 200, [clearToken()]);
  let restored: RestoreResult | "none" | "busy" = "none";
  try {
    const t = await loadTrial(c.store);
    if (t.repair) restored = "repair";
    else if (t.items.length) {
      const s = g.session!;
      const r = await withWriteLock(c, async (until) =>
        restoreTrial({ api: clientFor(deps, s, until), store: c.store, settings: deps.settings, seed: deps.seed, companyId: s.companyId, range: readRange(deps) }).catch(() => "partial" as const),
      );
      restored = r;
    }
    await dropKvToken(c);
  } catch {
    return json({ ok: false, code: "no-store", message: "サーバーの置き場につながらないので、サーバーの鍵を消せませんでした。少し待ってから、もう一度押してください" }, 503, [clearToken()]);
  }
  return json({ ok: true, restored }, 200, [clearToken()]);
}

// ---- 明細を入れる・登録する・読み直す ----

const expired = () => json({ ok: false, code: "expired", message: "freee の鍵が切れました。もう一度 freee とつないでください" }, 401, [clearToken()]);

function readFailure(e: unknown): Response {
  if (e instanceof FreeeExpired) return expired();
  const message =
    e instanceof FreeeOutOfTime
      ? "持ち時間の中で freee を読み終わりませんでした"
      : e instanceof FreeeRejected
      ? `freee が受けませんでした（${e.status}）${e.messages.length ? `：${e.messages.join(" / ")}` : ""}`
      : e instanceof FreeeBadShape
        ? `freee の返事の形が違います：${e.message}`
        : "freee から返事がありません";
  return json({ ok: false, code: "read", message: `${message}（freee には何も書いていません）` }, 502);
}

function versionOf(seed: AccountingSeed): string {
  return seed.statement.version ?? "v1";
}

/** 架空の明細の期間（freee に入れる時に、もうあるかを読む期間） */
function importRange(seed: AccountingSeed): { from: string; to: string } {
  return { from: seed.statement.from, to: seed.statement.to };
}

/** 店の時間帯の今日（YYYY-MM-DD） */
export function todayIn(timeZone: string, nowMs: number): string {
  return new Date(nowMs).toLocaleDateString("en-CA", { timeZone });
}

/** 一覧と登録で読む期間：今日の listDays 日前から、架空の明細の最後の日と今日の遅い方まで */
export function readRange(deps: FreeeDeps): { from: string; to: string } {
  return listRange(todayIn(deps.timeZone, deps.now()), deps.seed.statement.to, deps.settings.listDays);
}

/**
 * この呼び出しの持ち時間（窓口の時間の上限より短く。返事の時間を残す）。
 * lockUntil：書く時の印の期限。印の期限の前に返事を待ち終えられない呼び出しは送らない（期限の後に書かない）。
 */
export function clientFor(deps: FreeeDeps, s: Pick<Session, "accessToken">, lockUntil?: number): FreeeClient {
  const budget = deps.now() + deps.settings.serverBudgetSeconds * 1000;
  return freeeClient({
    fetch: deps.fetch,
    settings: deps.settings,
    accessToken: s.accessToken,
    now: deps.now,
    deadline: lockUntil === undefined ? budget : Math.min(budget, lockUntil - 1000),
  });
}

/** 書く窓口の印：置き場がある時は、来た人の登録・元に戻すと同じ印を取る。取れなければ「少し待ってから」 */
export const WRITE_BUSY_MESSAGE = "いま ほかの書き込み（来た人の試し・元に戻す など）をしています。少し待ってから、もう一度押してください";

async function underWriteLock(deps: FreeeDeps, run: (lockUntil?: number) => Promise<Response>): Promise<Response> {
  if (!deps.store) return run();
  try {
    const r = await withWriteLock({ store: deps.store, settings: deps.settings, now: deps.now, random: deps.random }, (until) => run(until));
    return r === "busy" ? json({ ok: false, code: "busy", message: WRITE_BUSY_MESSAGE }, 409) : r;
  } catch (e) {
    if (e instanceof StoreDown) return json({ ok: false, code: "no-store", message: "サーバーの置き場につながらないので、書きませんでした。少し待ってから、もう一度押してください" }, 503);
    throw e;
  }
}

/** 読む口座は2つだけ：カード（無ければ止める）と銀行（無ければ銀行の分だけ出さない） */
export async function accountsOf(api: FreeeClient, deps: FreeeDeps, companyId: number) {
  const list = await api.walletables(companyId);
  return { card: pickCardAccount(list, deps.settings.cardName), bank: pickBankAccount(list, deps.settings.bankName) };
}

/**
 * stopped.kind：unknown（入れた結果が分からない。画面は待つ期限を出す）・failed（freee が受けなかった）・
 * time（持ち時間が残っていないので、次の書き込みの前に止めた。何も分からない物は無い。画面が続きを呼ぶ）。
 * done：入れる明細を全部見終わった（銀行の口座が無い時は、銀行の分を入れずに bank に理由）。
 */
export type ImportResult = {
  ok: true;
  total: number;
  created: number;
  existed: number;
  check: number;
  /** 銀行の口座が無いので入れなかった件数 */
  skipped: number;
  /** 銀行の口座が無い時の1行 */
  bank: string | null;
  done: boolean;
  stopped: null | { no: number; kind: "unknown" | "failed" | "time"; reason: string };
};

/**
 * 経理タブと同じ架空の明細（カード・銀行）を、1件ずつ freee の明細として入れる。カードは「SecretAIry カード」、銀行は「SecretAIry 口座」。
 * 同じ印の明細がもうあれば入れない。銀行の口座が無い時は、銀行の分だけ入れずに理由を返す。
 */
export async function handleImport(request: Request, deps: FreeeDeps): Promise<Response> {
  const g = guard(request, deps, { method: "POST", session: true });
  if (!g.ok) return g.response;
  const s = g.session!;
  return underWriteLock(deps, (until) => importUnderLock(deps, s, until));
}

async function importUnderLock(deps: FreeeDeps, s: Session, lockUntil?: number): Promise<Response> {
  const api = clientFor(deps, s, lockUntil);
  const items = deps.seed.statement.items;
  let accounts;
  const txns: Record<StatementAccount, WalletTxn[]> = { card: [], bank: [] };
  try {
    accounts = await accountsOf(api, deps, s.companyId);
    if (!accounts.card.ok) return json({ ok: false, code: "card", message: accounts.card.reason }, 409);
    txns.card = await api.walletTxns(s.companyId, accounts.card.walletable, importRange(deps.seed));
    if (accounts.bank.ok && items.some((i) => accountOf(i) === "bank")) txns.bank = await api.walletTxns(s.companyId, accounts.bank.walletable, importRange(deps.seed));
  } catch (e) {
    return readFailure(e);
  }
  const card = accounts.card;
  const bank: BankAccount = accounts.bank;
  const out: ImportResult = { ok: true, total: items.length, created: 0, existed: 0, check: 0, skipped: 0, bank: null, done: false, stopped: null };
  for (const item of items) {
    const account = accountOf(item);
    const w = account === "card" ? card.walletable : bank.ok ? bank.walletable : null;
    if (!w) {
      out.skipped++;
      if (!bank.ok) out.bank = bank.reason;
      continue;
    }
    const mark = markOf(deps.settings.markPrefix, versionOf(deps.seed), item.no);
    const l = lookup(txns[account], { companyId: s.companyId, walletableId: w.id, mark, item });
    if (l.kind === "found") {
      out.existed++;
      continue;
    }
    if (l.kind !== "missing") {
      out.check++;
      continue;
    }
    try {
      const made = await api.createWalletTxn({
        company_id: s.companyId,
        walletable_type: WALLETABLE_TYPE[account],
        walletable_id: w.id,
        entry_side: sideOf(item),
        amount: item.amount,
        date: item.date,
        description: descriptionOf(merchantNameOf(deps.seed, item), mark),
      });
      txns[account].push(made);
      out.created++;
    } catch (e) {
      if (e instanceof FreeeExpired) return expired();
      if (e instanceof FreeeOutOfTime) {
        // 送る前に止めた（何も分からない物は無い）。画面が続きを呼ぶ
        out.stopped = { no: item.no, kind: "time", reason: "持ち時間の中で入れ終わらないので、ここで区切りました" };
        break;
      }
      // 送った後に返事が途切れた時は、ここで止める（もう一度押すと、読み直して残りだけ入れる）
      const unknown = e instanceof FreeeNoAnswer || e instanceof FreeeServerError;
      out.stopped = {
        no: item.no,
        kind: unknown ? "unknown" : "failed",
        reason: unknown
          ? `${item.no}番を入れた結果が分かりません。もう一度押すと、freee から読み直して、まだ無い物だけ入れます`
          : `${item.no}番を freee が受けませんでした${e instanceof FreeeRejected && e.messages.length ? `：${e.messages.join(" / ")}` : ""}`,
      };
      break;
    }
  }
  out.done = out.stopped === null;
  return json(out);
}

function merchantNameOf(seed: AccountingSeed, item: CardItem): string {
  return seed.merchants.find((m) => m.id === item.merchantId)?.name ?? item.merchantId;
}

export type RegisterAnswer =
  | { ok: true; id: number; result: "registered"; dealIds: number[] }
  | { ok: true; id: number; result: "already" }
  | { ok: true; id: number; result: "check"; reason: string }
  | { ok: true; id: number; result: "failed"; reason: string }
  | { ok: true; id: number; result: "unknown"; reason: string };

/** 暦にある日付（YYYY-MM-DD。確かめ方は calendar.ts の1か所） */
const isDate = isRealDate;
const isId = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;

/** 登録で画面から来る物：freee の明細の番号・店用か私用か・口座・日付・金額（どれも freee から読み直して照らし合わせる） */
export type RegisterTarget = { id: number; use: CardUse; account: StatementAccount; date: string; amount: number };

function readTarget(body: Record<string, unknown> | null): RegisterTarget | null {
  const b = body ?? {};
  if (!isId(b.id) || (b.use !== "shop" && b.use !== "private") || (b.account !== "card" && b.account !== "bank") || !isDate(b.date) || !isId(b.amount)) return null;
  return { id: b.id, use: b.use, account: b.account, date: b.date, amount: b.amount };
}

/**
 * 「freee（テスト事業所）に登録」の1件（freee から読んだ明細。印の無い明細も）。
 * 書く直前に、その口座の明細を読む期間でページをめくって全部読み、明細の番号で探して、
 * 口座・日付・金額・出金・未処理（登録待ち＝明細の金額）が全部合う時だけ進む。
 * - 店用は create_deal（内訳1行・科目1つ・税区分1つ）、私用は create_private_deal
 * - 処理済みで登録待ち0 → already（送り直さない）
 * - 入金 → 登録しない（売上の入金は freee のルールで売上にしている）
 * - 無視・一部だけ・値が合わない・候補2件以上 → check（止める）
 * - 送った後に返事が途切れた → unknown（送り直さない）
 */
export async function handleRegister(request: Request, deps: FreeeDeps): Promise<Response> {
  const g = guard(request, deps, { method: "POST", session: true });
  if (!g.ok) return g.response;
  const s = g.session!;
  const target = readTarget(await readBody(request, deps.settings.maxRequestChars));
  if (!target) return json({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  const range = readRange(deps);
  if (target.date < range.from || target.date > range.to) return json({ ok: false, code: "bad-request", message: "読む期間の外の明細です" }, 400);
  return underWriteLock(deps, async (until) => {
    const answer = await registerOne(deps, s, target, range, until);
    if (answer === "expired") return expired();
    return json(answer);
  });
}

async function registerOne(deps: FreeeDeps, s: Session, target: RegisterTarget, range: { from: string; to: string }, lockUntil?: number): Promise<RegisterAnswer | "expired"> {
  const api = clientFor(deps, s, lockUntil);
  const p = await prepareOne(deps, api, s, target, range);
  if (p.kind === "answer") return p.answer;
  const w = await writeOne(api, s, target.use, p.txn, p.line);
  const id = target.id;
  if (w.kind === "expired") return "expired";
  if (w.kind === "registered") return { ok: true, id, result: "registered", dealIds: w.dealIds };
  if (w.kind === "time") return { ok: true, id, result: "failed", reason: "持ち時間が足りないので送りませんでした（freee には何も書いていません）。もう一度押してください" };
  if (w.kind === "rejected") return { ok: true, id, result: "failed", reason: `freee が受けませんでした（${w.status}）${w.messages.length ? `：${w.messages.join(" / ")}` : ""}` };
  return { ok: true, id, result: "unknown", reason: "送った後に freee の返事が途切れました。送り直さずに、freee から読み直して照らし合わせてください" };
}

export type DealLine = { account_item_id: number; tax_code: number };
export type Prepared = { kind: "answer"; answer: RegisterAnswer | "expired" } | { kind: "ready"; txn: WalletTxn; line: DealLine | null };

/**
 * 登録の前半（書かない）：書く直前に読んで照らし合わせ、店用なら科目と税区分を1つに決める。
 * txns：もう読んだその口座の明細（無ければここで読む）。extra：ほかに確かめる事（来た人用の見本との照らし合わせ）。止める時は理由の文。
 * fixedErrors：読めなかった時の理由を決まった文にする（freee の生の文を出さない。来た人用）。
 */
export async function prepareOne(
  deps: FreeeDeps,
  api: FreeeClient,
  s: Pick<Session, "companyId">,
  target: RegisterTarget,
  range: { from: string; to: string },
  opts: { txns?: WalletTxn[]; extra?: (txn: WalletTxn) => string | null; fixedErrors?: boolean } = {},
): Promise<Prepared> {
  const id = target.id;
  const failed = (reason: string): Prepared => ({ kind: "answer", answer: { ok: true, id, result: "failed", reason } });
  let verdict: Verdict;
  let line: DealLine | null = null;
  try {
    const accounts = await accountsOf(api, deps, s.companyId);
    if (!accounts.card.ok) return failed(accounts.card.reason);
    const acc = target.account === "card" ? accounts.card : accounts.bank;
    if (!acc.ok) return failed(acc.reason);
    // 書く直前に読む（その口座の、読む期間の全部）
    const txns = opts.txns ?? (await api.walletTxns(s.companyId, acc.walletable, range));
    const found = lookupById(txns, { companyId: s.companyId, walletable: acc.walletable, id, markPrefix: deps.settings.markPrefix });
    if (found.kind === "found" && found.txn.entry_side === "income")
      return failed("入金は登録しません（売上の入金は、freee のルールで売上にしています）");
    if (found.kind === "found" && !useAllowed(found.txn.description, target.use, deps.seed))
      return failed("店用・私用の選びが、購入先の自動のルールと合いません");
    if (found.kind === "found" && opts.extra) {
      const why = opts.extra(found.txn);
      if (why) return failed(why);
    }
    verdict = verdictOf(
      lookupById(txns, { companyId: s.companyId, walletable: acc.walletable, id, markPrefix: deps.settings.markPrefix, expect: { date: target.date, amount: target.amount } }),
    );
    if (verdict.kind === "ready" && target.use === "shop") {
      const [items, taxes] = [await api.accountItems(s.companyId), await api.taxes(s.companyId)];
      const a = pickOne(items, (x) => x.name === deps.settings.accountItemName && x.available);
      if (!a.ok) return failed(`科目「${deps.settings.accountItemName}」が freee で${a.count === 0 ? "見つかりません" : `${a.count}つあります`}。1つに決まらないので止めました`);
      const t = pickOne(taxes, (x) => x.name_ja === deps.settings.taxName && x.available);
      if (!t.ok) return failed(`税区分「${deps.settings.taxName}」が freee で${t.count === 0 ? "見つかりません" : `${t.count}つあります`}。1つに決まらないので止めました`);
      line = { account_item_id: a.value.id, tax_code: t.value.code };
    }
  } catch (e) {
    if (e instanceof FreeeExpired) return { kind: "answer", answer: "expired" };
    if (opts.fixedErrors) return failed(e instanceof FreeeOutOfTime ? "持ち時間の中で読み終わりませんでした（何も書いていません）" : "freee から読めませんでした（何も書いていません）");
    const r = readFailure(e);
    return failed(((await r.json()) as { message: string }).message);
  }
  if (verdict.kind === "missing") return failed("freee にこの明細がありません（読む期間の中に、この番号の明細がありません）。「freee から読み直す」を押してください");
  if (verdict.kind === "done") return { kind: "answer", answer: { ok: true, id, result: "already" } };
  if (verdict.kind === "check") return { kind: "answer", answer: { ok: true, id, result: "check", reason: verdict.reason } };
  return { kind: "ready", txn: verdict.txn, line };
}

export type Written =
  | { kind: "registered"; dealIds: number[] }
  | { kind: "expired" }
  | { kind: "time" }
  | { kind: "rejected"; status: number; messages: string[] }
  | { kind: "unknown" };

/** 登録の後半（書く）：店用は create_deal（内訳1行・科目1つ・税区分1つ）、私用は create_private_deal */
export async function writeOne(api: FreeeClient, s: Pick<Session, "companyId">, use: CardUse, txn: WalletTxn, line: DealLine | null): Promise<Written> {
  try {
    if (use === "shop") {
      const dealIds = await api.createDeal(txn.id, {
        company_id: s.companyId,
        deal_lines: [{ amount: txn.amount, account_item_id: line!.account_item_id, tax_code: line!.tax_code }],
      });
      return { kind: "registered", dealIds };
    }
    const dealId = await api.createPrivateDeal(txn.id, s.companyId);
    return { kind: "registered", dealIds: [dealId] };
  } catch (e) {
    if (e instanceof FreeeExpired) return { kind: "expired" };
    // 持ち時間が残っていないので、送る前に止めた（freee には何も送っていない）
    if (e instanceof FreeeOutOfTime) return { kind: "time" };
    if (e instanceof FreeeRejected) return { kind: "rejected", status: e.status, messages: e.messages };
    // つながらない・待ちきれない・500 台・返事の形が違う：freee の中で済んだかもしれない
    return { kind: "unknown" };
  }
}

/** setup：店用の科目・税区分・カードの口座が、freee で「使える物1つ」に決まるか（読むだけ。本番の最初の確かめに使う） */
export type SetupCheck = { card: string | null; bank: string | null; accountItem: { name: string; count: number }; tax: { name: string; count: number } };
export type CheckKind = "ready" | "done" | "check" | "missing";

/** 読み直した答え：まだ処理していない明細の一覧（新しい順・上限まで）と、頼まれた明細の番号ごとの状態 */
export type CheckAnswer = {
  ok: true;
  range: { from: string; to: string };
  rows: ListedTxn[];
  /** 上限をこえたので、新しい方から上限の件数だけ出している */
  capped: boolean;
  /** 銀行の口座が無い時の1行（カードの分は出す） */
  bank: string | null;
  items: { id: number; kind: CheckKind; reason?: string }[];
  setup: SetupCheck;
};

/**
 * freee から読む（書かない）。経理のタブを開いた時・「freee から読み直す」・登録の前の照らし合わせで使う。
 * 読む口座はカードと銀行の2つだけ。期間は今日の listDays 日前から、架空の明細の最後の日と今日の遅い方まで。
 * まだ処理していない明細（未処理で、登録待ちの金額が0より大きい）だけを、新しい順に maxListRows 件まで。
 * ids：照らし合わせる freee の明細の番号（記録で「結果が分からない」などの物）。
 */
export async function handleCheck(request: Request, deps: FreeeDeps): Promise<Response> {
  const g = guard(request, deps, { method: "POST", session: true });
  if (!g.ok) return g.response;
  const s = g.session!;
  const body = await readBody(request, deps.settings.maxRequestChars);
  const raw = body?.ids ?? [];
  if (!Array.isArray(raw) || raw.length > deps.settings.maxListRows || !raw.every(isId)) return json({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  const ids = [...new Set(raw as number[])];
  const max = deps.settings.maxListRows;
  const range = readRange(deps);
  const api = clientFor(deps, s);
  try {
    const accounts = await accountsOf(api, deps, s.companyId);
    if (!accounts.card.ok) return json({ ok: false, code: "card", message: accounts.card.reason }, 409);
    const read: ReadAccount[] = [];
    read.push({ account: "card", walletable: accounts.card.walletable, txns: await api.walletTxns(s.companyId, accounts.card.walletable, range, { stopAfterOpen: max }) });
    if (accounts.bank.ok)
      read.push({ account: "bank", walletable: accounts.bank.walletable, txns: await api.walletTxns(s.companyId, accounts.bank.walletable, range, { stopAfterOpen: max }) });
    const open = openRows(read, s.companyId);
    const capped = open.length > max;
    const [accountItems, taxes] = [await api.accountItems(s.companyId), await api.taxes(s.companyId)];
    const setup: SetupCheck = {
      card: accounts.card.walletable.name,
      bank: accounts.bank.ok ? accounts.bank.walletable.name : null,
      accountItem: { name: deps.settings.accountItemName, count: accountItems.filter((x) => x.name === deps.settings.accountItemName && x.available).length },
      tax: { name: deps.settings.taxName, count: taxes.filter((x) => x.name_ja === deps.settings.taxName && x.available).length },
    };
    const items = ids.map((id) => {
      for (const r of read) {
        const l = lookupById(r.txns, { companyId: s.companyId, walletable: r.walletable, id, markPrefix: deps.settings.markPrefix });
        if (l.kind === "missing") continue;
        const v = verdictOf(l);
        return v.kind === "check" ? { id, kind: "check" as const, reason: v.reason } : { id, kind: v.kind };
      }
      return capped ? { id, kind: "check" as const, reason: "明細が多くて読み切れず、見つかりませんでした" } : { id, kind: "missing" as const };
    });
    const out: CheckAnswer = { ok: true, range, rows: open.slice(0, max), capped, bank: accounts.bank.ok ? null : accounts.bank.reason, items, setup };
    return json(out);
  } catch (e) {
    return readFailure(e);
  }
}

export type ReadAccount = { account: StatementAccount; walletable: { id: number; type: WalletTxn["walletable_type"] }; txns: WalletTxn[] };

/** まだ処理していない明細（未処理で、登録待ちの金額が0より大きい）を、新しい順に（一覧の行の形） */
export function openRows(read: ReadAccount[], companyId: number): ListedTxn[] {
  const open: ListedTxn[] = [];
  for (const r of read)
    for (const t of r.txns)
      if (t.company_id === companyId && t.walletable_id === r.walletable.id && t.walletable_type === r.walletable.type && isOpen(t))
        open.push({ id: t.id, account: r.account, date: t.date, side: t.entry_side, description: t.description.slice(0, 200), amount: t.amount });
  open.sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1));
  return open;
}

/** 本番の道具立て（窓口のファイルから呼ぶ） */
export function defaultRandom(n: number): Buffer {
  return randomBytes(n);
}
