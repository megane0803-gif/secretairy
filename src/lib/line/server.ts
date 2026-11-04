// 窓口（src/app/api/line/）で使う、本番の道具立て。Redis（Upstash）と LINE の鍵は環境変数から読む。
// 鍵はここで読むだけで、画面・ログには出さない。

import { randomBytes } from "node:crypto";
import { getLineSettings, getShop } from "../settings";
import { lineClient, NoLineError, type LineClient } from "./api";
import type { BridgeDeps } from "./bridge";
import { upstashStore } from "./store";

/** Redis の環境変数が無ければ NoStoreError を投げる */
export function bridgeDeps(): BridgeDeps {
  let line: LineClient | null = null;
  try {
    line = lineClient();
  } catch (e) {
    if (!(e instanceof NoLineError)) throw e;
  }
  return {
    store: upstashStore(),
    line,
    settings: getLineSettings(),
    timezone: getShop().timezone,
    now: () => new Date(),
    random: (n) => randomBytes(n),
    ownerPasscode: process.env.LINE_OWNER_PASSCODE || null,
  };
}

/** 「LINE とつなぐ」でオーナー用の合言葉を求めるか（環境変数 LINE_OWNER_PASSCODE があるか。中身は画面に渡さない） */
export function needsOwnerPasscode(): boolean {
  return !!process.env.LINE_OWNER_PASSCODE?.trim();
}

/** 試した回数を数える相手（送り元の IP。置き場所にはハッシュだけ置く） */
export function clientOf(request: Request): string {
  return (request.headers.get("x-forwarded-for")?.split(",")[0] ?? request.headers.get("x-real-ip") ?? "").trim().slice(0, 80);
}

export function noStore(): Response {
  return Response.json(
    { ok: false, code: "no-store", message: "LINE の預かり場所（Redis）につながりません" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

/** 画面からの窓口の、送る物を読む（大きすぎる・形がおかしい物は null） */
export async function readJson(request: Request, max = getLineSettings().maxScreenRequestChars): Promise<unknown | null> {
  const raw = await request.text();
  if (raw.length > max) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
