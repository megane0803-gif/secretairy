// freee（テスト事業所）の窓口（src/app/api/freee/）の中身。AI は呼ばない。サーバーには何も残さない。
// 窓口のファイルは薄くして、ここに道具立て（deps）を渡す。テストでは fetch・時刻・乱数・環境変数を置きかえる。
//
// 守り（どの窓口も）：
// - 本番（VERCEL_ENV=production）で、本番のサイトの名前（host）に来た呼び出しだけ。プレビューの URL では全部止める
// - 書く窓口（明細を入れる・登録する・読み直す・つなぎを外す・つなぐ）は POST だけで、Origin が本番のサイトの時だけ
// - 鍵は暗号化した cookie（HttpOnly・Secure・SameSite・このサイトだけ）。cookie が無い呼び出しは受けない（つなぐ・戻り先を除く）
// - 事業所の番号は、鍵の返事に入っていた番号（cookie の中）と FREEE_COMPANY_ID がちょうど同じ時だけ。ブラウザから来た番号は使わない
// - 許可の返事・どの返事もキャッシュさせない

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AccountingSeed, CardItem, CardUse } from "../data/types";
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
  type FetchLike,
  type FreeeClient,
} from "./api";
import { descriptionOf, lookup, markOf, pickCardAccount, pickOne, useAllowed, verdictOf, type Verdict } from "./match";
import { seal, unseal } from "./seal";

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
};

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

function json(body: unknown, status = 200, cookies: string[] = []): Response {
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

type Session = { accessToken: string; companyId: number; expiresAt: number };

type Guarded = { ok: true; session: Session | null } | { ok: false; response: Response };

/**
 * どの窓口も最初に通す。
 * method：受ける形（ほかは 405）。session：cookie の鍵が要るか。
 */
export function guard(request: Request, deps: FreeeDeps, p: { method: "GET" | "POST"; session: boolean; needCompany?: boolean; envCheck?: boolean }): Guarded {
  const { env, settings } = deps;
  const site = new URL(settings.siteOrigin);
  // プレビュー・手元・本番の別の URL では、freee の窓口を全部止める
  if (env.vercelEnv !== "production" || (request.headers.get("host") ?? "").toLowerCase() !== site.host)
    return { ok: false, response: json({ ok: false, code: "off", message: "ここでは freee につなぎません（本番のサイトだけ）" }, 404) };
  if (request.method !== p.method) return { ok: false, response: json({ ok: false, code: "method", message: "受けない形です" }, 405) };
  if (p.method === "POST") {
    const origin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    if (origin !== site.origin || (fetchSite !== null && fetchSite !== "same-origin"))
      return { ok: false, response: json({ ok: false, code: "origin", message: "本番のサイトから来た呼び出しではないので受けません" }, 403) };
  }
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

async function readBody(request: Request, max: number): Promise<Record<string, unknown> | null> {
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
  return back("connected", [...cookies, cookie(TOKEN_COOKIE, seal(env.cookieKey!, "token", session, deps.random), { maxAge: seconds, sameSite: "Strict" })]);
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
  if (g.ok) return json({ ok: true, connected: true, expiresAt: new Date(g.session!.expiresAt).toISOString() });
  const code = ((await g.response.clone().json()) as { code?: unknown }).code;
  if (code === "no-cookie" || code === "expired") return notConnected(code, g.response.headers.getSetCookie());
  return g.response;
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
  return json({ ok: true }, 200, [clearToken()]);
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

/** 明細の期間（freee の明細を読む時に、取引日で絞る） */
function rangeOf(seed: AccountingSeed): { from: string; to: string } {
  return { from: seed.statement.from, to: seed.statement.to };
}

/** この呼び出しの持ち時間（窓口の時間の上限より短く。返事の時間を残す） */
function clientFor(deps: FreeeDeps, s: Session): FreeeClient {
  return freeeClient({
    fetch: deps.fetch,
    settings: deps.settings,
    accessToken: s.accessToken,
    now: deps.now,
    deadline: deps.now() + deps.settings.serverBudgetSeconds * 1000,
  });
}

async function cardOf(api: FreeeClient, deps: FreeeDeps, companyId: number) {
  return pickCardAccount(await api.walletables(companyId), deps.settings.cardName);
}

/**
 * stopped.kind：unknown（入れた結果が分からない。画面は待つ期限を出す）・failed（freee が受けなかった）・
 * time（持ち時間が残っていないので、次の書き込みの前に止めた。何も分からない物は無い。画面が続きを呼ぶ）。
 * done：20件を全部見終わった。
 */
export type ImportResult = {
  ok: true;
  total: number;
  created: number;
  existed: number;
  check: number;
  done: boolean;
  stopped: null | { no: number; kind: "unknown" | "failed" | "time"; reason: string };
};

/** 経理タブと同じ架空のカード明細を、1件ずつ freee の明細として入れる。同じ印の明細がもうあれば入れない */
export async function handleImport(request: Request, deps: FreeeDeps): Promise<Response> {
  const g = guard(request, deps, { method: "POST", session: true });
  if (!g.ok) return g.response;
  const s = g.session!;
  const api = clientFor(deps, s);
  const items = deps.seed.statement.items;
  let card, txns;
  try {
    card = await cardOf(api, deps, s.companyId);
    if (!card.ok) return json({ ok: false, code: "card", message: card.reason }, 409);
    txns = await api.walletTxns(s.companyId, card.walletable, rangeOf(deps.seed));
  } catch (e) {
    return readFailure(e);
  }
  const out: ImportResult = { ok: true, total: items.length, created: 0, existed: 0, check: 0, done: false, stopped: null };
  for (const item of items) {
    const mark = markOf(deps.settings.markPrefix, versionOf(deps.seed), item.no);
    const l = lookup(txns, { companyId: s.companyId, walletableId: card.walletable.id, mark, item });
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
        walletable_type: "credit_card",
        walletable_id: card.walletable.id,
        entry_side: "expense",
        amount: item.amount,
        date: item.date,
        description: descriptionOf(merchantNameOf(deps.seed, item), mark),
      });
      txns.push(made);
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
  | { ok: true; no: number; result: "registered"; dealIds: number[] }
  | { ok: true; no: number; result: "already" }
  | { ok: true; no: number; result: "check"; reason: string }
  | { ok: true; no: number; result: "failed"; reason: string }
  | { ok: true; no: number; result: "unknown"; reason: string };

/**
 * 「freee（テスト事業所）に登録」の1件。
 * 書く直前に freee の明細を読み（ページをめくって全部）、印で探して、日付・金額・出金かまで合う時だけ進む。
 * - 未処理で登録待ち＝明細の金額 → 店用は create_deal（内訳1行・科目1つ・税区分1つ）、私用は create_private_deal
 * - 処理済みで登録待ち0 → already（送り直さない）
 * - 無視・一部だけ・値が合わない・候補2件以上 → check（止める）
 * - 送った後に返事が途切れた → unknown（送り直さない）
 */
export async function handleRegister(request: Request, deps: FreeeDeps): Promise<Response> {
  const g = guard(request, deps, { method: "POST", session: true });
  if (!g.ok) return g.response;
  const s = g.session!;
  const body = await readBody(request, deps.settings.maxRequestChars);
  const no = body?.no;
  const use = body?.use;
  const item = typeof no === "number" ? deps.seed.statement.items.find((i) => i.no === no) : undefined;
  if (!item || (use !== "shop" && use !== "private")) return json({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  if (!useAllowed(item, use, deps.seed.rules)) return json({ ok: false, code: "bad-request", message: "店用・私用の選びが、購入先の自動のルールと合いません" }, 400);
  const answer = await registerOne(deps, s, item, use);
  if (answer === "expired") return expired();
  return json(answer);
}

async function registerOne(deps: FreeeDeps, s: Session, item: CardItem, use: CardUse): Promise<RegisterAnswer | "expired"> {
  const api = clientFor(deps, s);
  const no = item.no;
  const failed = (reason: string): RegisterAnswer => ({ ok: true, no, result: "failed", reason });
  let verdict: Verdict;
  let line: { account_item_id: number; tax_code: number } | null = null;
  try {
    const card = await cardOf(api, deps, s.companyId);
    if (!card.ok) return failed(card.reason);
    if (use === "shop") {
      const [items, taxes] = [await api.accountItems(s.companyId), await api.taxes(s.companyId)];
      const a = pickOne(items, (x) => x.name === deps.settings.accountItemName && x.available);
      if (!a.ok) return failed(`科目「${deps.settings.accountItemName}」が freee で${a.count === 0 ? "見つかりません" : `${a.count}つあります`}。1つに決まらないので止めました`);
      const t = pickOne(taxes, (x) => x.name_ja === deps.settings.taxName && x.available);
      if (!t.ok) return failed(`税区分「${deps.settings.taxName}」が freee で${t.count === 0 ? "見つかりません" : `${t.count}つあります`}。1つに決まらないので止めました`);
      line = { account_item_id: a.value.id, tax_code: t.value.code };
    }
    // 書く直前に読む
    const txns = await api.walletTxns(s.companyId, card.walletable, rangeOf(deps.seed));
    verdict = verdictOf(lookup(txns, { companyId: s.companyId, walletableId: card.walletable.id, mark: markOf(deps.settings.markPrefix, versionOf(deps.seed), no), item }));
  } catch (e) {
    if (e instanceof FreeeExpired) return "expired";
    const r = readFailure(e);
    return failed(((await r.json()) as { message: string }).message);
  }
  if (verdict.kind === "missing") return failed("freee にこの明細がありません。先に「freee に明細を入れる」を押してください");
  if (verdict.kind === "done") return { ok: true, no, result: "already" };
  if (verdict.kind === "check") return { ok: true, no, result: "check", reason: verdict.reason };

  try {
    if (use === "shop") {
      const dealIds = await api.createDeal(verdict.txn.id, {
        company_id: s.companyId,
        deal_lines: [{ amount: verdict.txn.amount, account_item_id: line!.account_item_id, tax_code: line!.tax_code }],
      });
      return { ok: true, no, result: "registered", dealIds };
    }
    const dealId = await api.createPrivateDeal(verdict.txn.id, s.companyId);
    return { ok: true, no, result: "registered", dealIds: [dealId] };
  } catch (e) {
    if (e instanceof FreeeExpired) return "expired";
    // 持ち時間が残っていないので、送る前に止めた（freee には何も送っていない）
    if (e instanceof FreeeOutOfTime) return failed("持ち時間が足りないので送りませんでした（freee には何も書いていません）。もう一度押してください");
    if (e instanceof FreeeRejected) return failed(`freee が受けませんでした（${e.status}）${e.messages.length ? `：${e.messages.join(" / ")}` : ""}`);
    // つながらない・待ちきれない・500 台・返事の形が違う：freee の中で済んだかもしれない
    return { ok: true, no, result: "unknown", reason: "送った後に freee の返事が途切れました。送り直さずに、freee から読み直して照らし合わせてください" };
  }
}

/** setup：店用の科目・税区分・カードの口座が、freee で「使える物1つ」に決まるか（読むだけ。本番の最初の確かめに使う） */
export type SetupCheck = { card: string | null; accountItem: { name: string; count: number }; tax: { name: string; count: number } };
export type CheckAnswer = { ok: true; items: { no: number; kind: "ready" | "done" | "check" | "missing"; reason?: string }[]; setup: SetupCheck };

/** 読み直して照らし合わせる（書かない）。「結果が分からない」の後と、「最初に戻す」の後に使う */
export async function handleCheck(request: Request, deps: FreeeDeps): Promise<Response> {
  const g = guard(request, deps, { method: "POST", session: true });
  if (!g.ok) return g.response;
  const s = g.session!;
  const body = await readBody(request, deps.settings.maxRequestChars);
  const nos = Array.isArray(body?.nos) ? (body!.nos as unknown[]) : null;
  const items = nos?.map((n) => deps.seed.statement.items.find((i) => i.no === n));
  if (!items || items.length === 0 || items.length > deps.seed.statement.items.length || items.some((i) => !i))
    return json({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  const api = clientFor(deps, s);
  try {
    const card = await cardOf(api, deps, s.companyId);
    if (!card.ok) return json({ ok: false, code: "card", message: card.reason }, 409);
    const txns = await api.walletTxns(s.companyId, card.walletable, rangeOf(deps.seed));
    const [accountItems, taxes] = [await api.accountItems(s.companyId), await api.taxes(s.companyId)];
    const setup: SetupCheck = {
      card: card.walletable.name,
      accountItem: { name: deps.settings.accountItemName, count: accountItems.filter((x) => x.name === deps.settings.accountItemName && x.available).length },
      tax: { name: deps.settings.taxName, count: taxes.filter((x) => x.name_ja === deps.settings.taxName && x.available).length },
    };
    const out: CheckAnswer = {
      ok: true,
      setup,
      items: (items as CardItem[]).map((item) => {
        const v = verdictOf(lookup(txns, { companyId: s.companyId, walletableId: card.walletable.id, mark: markOf(deps.settings.markPrefix, versionOf(deps.seed), item.no), item }));
        return v.kind === "check" ? { no: item.no, kind: "check", reason: v.reason } : { no: item.no, kind: v.kind };
      }),
    };
    return json(out);
  } catch (e) {
    return readFailure(e);
  }
}

/** 本番の道具立て（窓口のファイルから呼ぶ） */
export function defaultRandom(n: number): Buffer {
  return randomBytes(n);
}
