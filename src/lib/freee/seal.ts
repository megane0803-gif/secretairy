// freee（テスト事業所）の cookie の中身を、書きかえを見破れる形で暗号化する（AES-256-GCM）。
// 暗号の鍵は環境変数 FREEE_COOKIE_KEY（32バイトを base64 にした文字）。鍵はここで使うだけで、画面・ログには出さない。
// 使い道（state の cookie か、鍵の cookie か、サーバーの置き場（KV）に置く鍵か）を「付け足しの印」（AAD）に入れるので、
// 片方をもう片方に使い回せない（cookie の中身を KV に、KV の中身を cookie に入れ替えても読めない）。

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type SealPurpose = "state" | "token" | "kv-token";

const VERSION = "1";

/** FREEE_COOKIE_KEY を読む。32バイトでなければ null（つながない） */
export function cookieKeyFrom(raw: string | undefined | null): Buffer | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!/^[A-Za-z0-9+/_-]+=*$/.test(s)) return null;
  const key = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return key.length === 32 ? key : null;
}

export function seal(key: Buffer, purpose: SealPurpose, payload: unknown, random: (n: number) => Buffer = randomBytes): string {
  const iv = random(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`secretairy-freee:${VERSION}:${purpose}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${Buffer.concat([iv, tag, body]).toString("base64url")}`;
}

/** 書きかえられていた・鍵が違う・使い道が違う時は null */
export function unseal(key: Buffer, purpose: SealPurpose, sealed: string | null | undefined): unknown | null {
  if (!sealed || sealed.length > 8000) return null;
  const [v, rest] = sealed.split(".");
  if (v !== VERSION || !rest) return null;
  const raw = Buffer.from(rest, "base64url");
  if (raw.length < 12 + 16 + 1) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(`secretairy-freee:${VERSION}:${purpose}`));
    decipher.setAuthTag(raw.subarray(12, 28));
    const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}
