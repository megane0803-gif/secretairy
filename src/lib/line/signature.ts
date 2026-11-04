// LINE からの知らせが本物かを確かめる（サーバーの側だけ）。
// 届いた中身そのまま（読みかえる前の文字）を LINE_CHANNEL_SECRET で HMAC-SHA256 にし、x-line-signature と比べる。
// 違う物・印の無い物は捨てる。

import { createHmac, timingSafeEqual } from "node:crypto";

export function lineSignature(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

export function verifyLineSignature(rawBody: string, header: string | null | undefined, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const want = Buffer.from(lineSignature(rawBody, secret), "utf8");
  const got = Buffer.from(header.trim(), "utf8");
  return want.length === got.length && timingSafeEqual(want, got);
}
