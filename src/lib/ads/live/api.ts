// 広告のテスト用アカウントの REST の呼び出し（サーバーの側だけ）。公式の資料の形：
//   検索：POST {apiBase}/{版}/customers/{番号}/googleAds:search  { query, pageToken? } → { results[], nextPageToken? }
//   変える：POST {apiBase}/{版}/customers/{番号}/googleAds:mutate { mutateOperations[], partialFailure, validateOnly }
//   見出し：Authorization: Bearer <通行証>・login-customer-id: <テスト用の管理アカウントの番号>（developer-token は送らない）
// 番号は環境変数から作った「数字だけの1つの値」（env.customerId）だけを使い、呼び出し（ブラウザ）から受け取らない。
//
// 一番大事な守り：書き込む（validateOnly も含む）関数 mutate は、入口で毎回
//   SELECT customer.id, customer.test_account, customer.manager FROM customer LIMIT 1
// を新しく読み、test_account が true・番号が設定の広告アカウントの番号と同じ・管理アカウントではない時だけ送る（結果は使い回さない）。
// mutate のほかに書き込む道は作らない（post は外に出さない）。CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION が返った時も「テスト用ではない」。
// エラーの文・返ってきた中身は捨て、決まった理由（errors.ts）だけにする。

import type { AdsLiveSettings } from "../../settings";
import type { LiveEnv } from "./env";
import { LiveError } from "./errors";
import { accessToken, type FetchLike } from "./token";

export type ApiCtx = {
  env: LiveEnv;
  settings: AdsLiveSettings;
  fetch: FetchLike;
  now: () => number;
};

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);

/** 返ってきたエラーの中の errorCode の値を全部集める（文は見ない） */
function errorCodes(body: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown, depth: number) => {
    if (depth > 8 || !x || typeof x !== "object") return;
    if (Array.isArray(x)) return x.forEach((y) => walk(y, depth + 1));
    for (const [k, v] of Object.entries(x)) {
      if (k === "errorCode" && isObj(v)) {
        for (const c of Object.values(v)) if (typeof c === "string") out.push(c);
      } else walk(v, depth + 1);
    }
  };
  walk(body, 0);
  return out;
}

const NOT_TEST = "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION";

/** 番号・通行証を持った URL と見出し（ここの1か所） */
function target(ctx: ApiCtx, method: "search" | "mutate"): { url: string; customerId: string; login: string } {
  const { customerId, loginCustomerId } = ctx.env;
  if (!customerId || !loginCustomerId || !ctx.env.key) throw new LiveError("token");
  const base = ctx.settings.apiBase.replace(/\/+$/, "");
  return { url: `${base}/${ctx.settings.apiVersion}/customers/${customerId}/googleAds:${method}`, customerId, login: loginCustomerId };
}

/** 1回呼ぶ（外に出さない）。うまくいかなければ決まった理由で投げる */
async function post(ctx: ApiCtx, method: "search" | "mutate", body: Json): Promise<Json> {
  const t = target(ctx, method);
  const token = await accessToken({ key: ctx.env.key!, settings: ctx.settings, fetch: ctx.fetch, now: ctx.now });
  let res: Response;
  try {
    res = await ctx.fetch(t.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "login-customer-id": t.login, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(ctx.settings.timeoutSeconds * 1000),
    });
  } catch (e) {
    throw new LiveError(e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network");
  }
  let j: unknown = null;
  try {
    j = await res.json();
  } catch {
    j = null;
  }
  if (!res.ok) {
    if (errorCodes(j).includes(NOT_TEST)) throw new LiveError("not-test");
    if (res.status === 401) throw new LiveError("auth");
    if (res.status === 403) throw new LiveError("permission");
    if (res.status === 429) throw new LiveError("quota");
    if (res.status >= 500) throw new LiveError("server");
    throw new LiveError("rejected");
  }
  if (!isObj(j)) throw new LiveError("bad-answer");
  if (errorCodes(j).includes(NOT_TEST)) throw new LiveError("not-test");
  return j;
}

/** GAQL の文字：' で囲み、中の \ と ' を \ で逃がす */
export function gaqlString(s: string): string {
  return `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** 検索（読むだけ）。ページは maxSearchPages まで */
export async function search(ctx: ApiCtx, query: string): Promise<Json[]> {
  const rows: Json[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < ctx.settings.maxSearchPages; i++) {
    const j = await post(ctx, "search", { query, ...(pageToken ? { pageToken } : {}) });
    const results = j.results;
    if (results !== undefined && !Array.isArray(results)) throw new LiveError("bad-answer");
    for (const r of results ?? []) if (isObj(r)) rows.push(r);
    pageToken = typeof j.nextPageToken === "string" && j.nextPageToken ? j.nextPageToken : undefined;
    if (!pageToken) return rows;
  }
  throw new LiveError("bad-answer");
}

export const VERIFY_QUERY = "SELECT customer.id, customer.test_account, customer.manager FROM customer LIMIT 1";

/** テスト用アカウントか（毎回新しく読む・使い回さない）。違えば LiveError "not-test" */
export async function verifyTestAccount(ctx: ApiCtx): Promise<void> {
  const rows = await search(ctx, VERIFY_QUERY);
  const c = rows.length === 1 && isObj(rows[0].customer) ? rows[0].customer : null;
  if (!c) throw new LiveError("not-test");
  // 値が無い時（JSON では false が省かれる）は false として扱う
  const id = typeof c.id === "string" || typeof c.id === "number" ? String(c.id) : "";
  if (c.testAccount !== true || id !== ctx.env.customerId || c.manager === true || id === ctx.env.loginCustomerId) throw new LiveError("not-test");
}

export type MutateAnswer = {
  /** 受けられなかった操作の番号（0 から） */
  failed: Set<number>;
  /** どの操作が受けられなかったか読めない（全部できなかったとして扱う） */
  allFailed: boolean;
  /** 返ってきた結果（resourceName だけ。サーバーの中だけで使い、ブラウザには返さない） */
  results: (string | null)[];
};

/** 部分の失敗（partialFailureError）から、受けられなかった操作の番号を読む */
function failedIndexes(j: Json, count: number): { failed: Set<number>; allFailed: boolean } {
  const pf = j.partialFailureError;
  const failed = new Set<number>();
  if (!isObj(pf) || !pf.code) return { failed, allFailed: false };
  if (errorCodes(pf).includes(NOT_TEST)) throw new LiveError("not-test");
  let allFailed = false;
  const details = Array.isArray(pf.details) ? pf.details : [];
  let seen = 0;
  for (const d of details) {
    if (!isObj(d) || !Array.isArray(d.errors)) continue;
    for (const e of d.errors) {
      seen += 1;
      const els = isObj(e) && isObj(e.location) && Array.isArray(e.location.fieldPathElements) ? e.location.fieldPathElements : [];
      const at = els.find((x) => isObj(x) && (x.fieldName === "mutate_operations" || x.fieldName === "mutateOperations") && typeof x.index === "number");
      const i = isObj(at) ? Number(at.index) : NaN;
      if (Number.isInteger(i) && i >= 0 && i < count) failed.add(i);
      else allFailed = true;
    }
  }
  if (seen === 0) allFailed = true;
  return { failed, allFailed };
}

/**
 * 書き込む（validateOnly も）。入口で必ずテスト用アカウントかを確かめる（ほかに書き込む道は無い）。
 * partialFailure = 操作ごとに受ける（止める・外す・足す）/ false = 全部できるか何もできないか（用意）。
 */
export async function mutate(ctx: ApiCtx, operations: Json[], p: { validateOnly: boolean; partialFailure: boolean }): Promise<MutateAnswer> {
  try {
    await verifyTestAccount(ctx);
  } catch (e) {
    // 確かめの所でうまくいかなかった時は、何も送っていない（「分からない」にしない）
    if (e instanceof LiveError && e.code !== "not-test") throw new LiveError(e.code, true);
    throw e;
  }
  if (operations.length === 0) return { failed: new Set(), allFailed: false, results: [] };
  const j = await post(ctx, "mutate", { mutateOperations: operations, partialFailure: p.partialFailure, validateOnly: p.validateOnly });
  const { failed, allFailed } = failedIndexes(j, operations.length);
  const list = Array.isArray(j.mutateOperationResponses) ? j.mutateOperationResponses : [];
  const results = operations.map((_, i) => {
    const r = list[i];
    if (!isObj(r)) return null;
    for (const v of Object.values(r)) if (isObj(v) && typeof v.resourceName === "string") return v.resourceName;
    return null;
  });
  return { failed, allFailed, results };
}
