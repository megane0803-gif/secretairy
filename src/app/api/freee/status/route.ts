// このブラウザが freee（テスト事業所）とつながっているか。cookie が無い呼び出しは受けない（401）。
// 中身は src/lib/freee/server.ts（守り：本番のサイトだけ・GET だけ・cookie・この事業所か）。AI は呼ばない。

import { freeeDeps } from "@/lib/freee/deps";
import { handleStatus } from "@/lib/freee/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleStatus(request, freeeDeps());
}

/** GET 以外は守り（guard）が 405 で断る（プレビューでは 404） */
export async function POST(request: Request): Promise<Response> {
  return handleStatus(request, freeeDeps());
}
