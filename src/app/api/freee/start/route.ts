// 「freee とつなぐ」：許可の合図（state）を cookie に置いて、freee の許可の画面（事業所を選ぶ画面つき）へ送る。
// 中身は src/lib/freee/server.ts（守り：本番のサイトだけ・POST だけ・cookie・この事業所か）。AI は呼ばない。

import { freeeDeps } from "@/lib/freee/deps";
import { handleStart } from "@/lib/freee/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleStart(request, freeeDeps());
}

/** POST 以外は守り（guard）が 405 で断る（プレビューでは 404） */
export async function GET(request: Request): Promise<Response> {
  return handleStart(request, freeeDeps());
}
