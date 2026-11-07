// 「つなぎを外す」：このブラウザの鍵の cookie を消す。置き場の鍵も消す（その前に、まだ元に戻していない来た人の試しを、オーナーの鍵で元に戻す）。
// 中身は src/lib/freee/server.ts（守り：本番のサイトだけ・POST だけ・cookie・この事業所か）。AI は呼ばない。

import { freeeDeps } from "@/lib/freee/deps";
import { handleDisconnect } from "@/lib/freee/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return handleDisconnect(request, freeeDeps());
}

/** POST 以外は守り（guard）が 405 で断る（プレビューでは 404） */
export async function GET(request: Request): Promise<Response> {
  return handleDisconnect(request, freeeDeps());
}
