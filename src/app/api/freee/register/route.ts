// 「freee（テスト事業所）に登録」の1件：書く直前に freee の明細を読んで照らし合わせ、未処理の時だけ取引を登録する。
// 中身は src/lib/freee/server.ts（守り：本番のサイトだけ・POST だけ・cookie・この事業所か）。AI は呼ばない。

import { freeeDeps } from "@/lib/freee/deps";
import { handleRegister } from "@/lib/freee/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return handleRegister(request, freeeDeps());
}

/** POST 以外は守り（guard）が 405 で断る（プレビューでは 404） */
export async function GET(request: Request): Promise<Response> {
  return handleRegister(request, freeeDeps());
}
