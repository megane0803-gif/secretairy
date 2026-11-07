// サービスアカウントの鍵から、1時間の通行証を作る（JWT を oauth2.googleapis.com/token に送る。範囲は adwords）。
// 新しい npm の部品は足さず、Node の crypto だけで署名する。通行証はサーバーの中だけで使い、ブラウザには返さない・保存しない。
// 続けて使う間だけ、このプロセスの記憶に持ち、切れる tokenReuseMarginSeconds 秒（5分）前まで使い回す。
// うまくいかない時は決まった理由（LiveError "token"）だけ。返ってきた中身・元のエラーは捨てる。

import { createHash, createSign } from "node:crypto";
import type { AdsLiveSettings } from "../../settings";
import type { ServiceKey } from "./env";
import { LiveError } from "./errors";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** 署名した JWT（鍵の持ち主のメール・範囲・行き先・作った時・切れる時） */
export function signedJwt(key: ServiceKey, s: Pick<AdsLiveSettings, "tokenUrl" | "scope" | "tokenSeconds">, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: "RS256", typ: "JWT", ...(key.id ? { kid: key.id } : {}) };
  const claims = { iss: key.email, scope: s.scope, aud: s.tokenUrl, iat, exp: iat + Math.min(3600, s.tokenSeconds) };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = createSign("RSA-SHA256").update(body).end().sign(key.privateKey);
  return `${body}.${b64url(sig)}`;
}

type Cached = { id: string; token: string; until: number };
let cache: Cached | null = null;

/** テスト用：持っている通行証を捨てる */
export function clearTokenCache(): void {
  cache = null;
}

const idOf = (key: ServiceKey) =>
  createHash("sha256")
    .update(key.email)
    .update("\0")
    .update(key.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer)
    .digest("hex");

/** 通行証（持っていて切れる5分より前なら使い回す） */
export async function accessToken(p: { key: ServiceKey; settings: AdsLiveSettings; fetch: FetchLike; now: () => number }): Promise<string> {
  const id = idOf(p.key);
  const margin = p.settings.tokenReuseMarginSeconds * 1000;
  if (cache && cache.id === id && p.now() < cache.until - margin) return cache.token;
  let res: Response;
  try {
    const assertion = signedJwt(p.key, p.settings, p.now());
    const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString();
    res = await p.fetch(p.settings.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(p.settings.timeoutSeconds * 1000),
    });
  } catch {
    throw new LiveError("token");
  }
  if (!res.ok) throw new LiveError("token");
  let j: Record<string, unknown>;
  try {
    j = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new LiveError("token");
  }
  const token = typeof j?.access_token === "string" ? j.access_token : "";
  const seconds = typeof j?.expires_in === "number" && j.expires_in > 0 ? j.expires_in : p.settings.tokenSeconds;
  if (!token) throw new LiveError("token");
  cache = { id, token, until: p.now() + Math.min(seconds, p.settings.tokenSeconds) * 1000 };
  return token;
}
