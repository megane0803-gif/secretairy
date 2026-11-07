// だれでも試す（直しU）：承認した1件を、テスト用アカウントを「元の形」に戻してから送り、読み直した一覧を返す。合言葉は要らない。
// 受け取るのは種類と番号の2つだけ（言葉はサーバーが最初の表から引く）。中身は src/lib/ads/live/server.ts の handleLiveTry
// （守り：本番のサイトだけ・POST だけ・Origin・3つの環境変数・同時に1回の印・1日／1分／同じ送り元の上限）。AI は呼ばない。

import { liveDeps } from "@/lib/ads/live/deps";
import { handleLiveTry } from "@/lib/ads/live/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return handleLiveTry(request, liveDeps());
}

/** POST のほかは守りが 405 で断る（プレビュー・つないでいない時は「つないでいません」） */
export async function GET(request: Request): Promise<Response> {
  return handleLiveTry(request, liveDeps());
}
