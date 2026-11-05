// freee の許可の戻り先（https://secretairy.vercel.app/api/freee/callback）。合図を確かめて消し、鍵の返事の事業所の番号を確かめてから、鍵を暗号化した cookie に入れる。
// 中身は src/lib/freee/server.ts（守り：本番のサイトだけ・GET だけ・cookie・この事業所か）。AI は呼ばない。

import { freeeDeps } from "@/lib/freee/deps";
import { handleCallback } from "@/lib/freee/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleCallback(request, freeeDeps());
}

/** GET 以外は守り（guard）が 405 で断る（プレビューでは 404） */
export async function POST(request: Request): Promise<Response> {
  return handleCallback(request, freeeDeps());
}
