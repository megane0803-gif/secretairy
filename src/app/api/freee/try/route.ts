// 来た人が合言葉なしで試せる freee（テスト事業所）の窓口：未処理の明細を読む・1件を店用か私用で登録する・読み直す。
// 中身は src/lib/freee/try.ts（守り：本番のサイトだけ・POST だけ・Origin・大きさ・回数の上限・同時に1回・見本の明細だけ・数分後に元に戻す）。AI は呼ばない。

import { freeeDeps } from "@/lib/freee/deps";
import { handleTry } from "@/lib/freee/try";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return handleTry(request, freeeDeps());
}

/** POST 以外は 405（プレビューでは 404） */
export async function GET(request: Request): Promise<Response> {
  return handleTry(request, freeeDeps());
}
