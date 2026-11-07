// 承認した案（止める・外す・足す）をテスト用アカウントに送り、読み直して確かめる。オーナーだけ。
// 中身は src/lib/ads/live/server.ts（守り：本番のサイトだけ・受ける形・Origin・3つの環境変数・オーナー用の合言葉・動いている印・1日の上限）。AI は呼ばない。

import { liveDeps } from "@/lib/ads/live/deps";
import { handleLiveSend } from "@/lib/ads/live/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return handleLiveSend(request, liveDeps());
}

/** POST のほかは守りが 405 で断る（プレビュー・つないでいない時は「つないでいません」） */
export async function GET(request: Request): Promise<Response> {
  return handleLiveSend(request, liveDeps());
}
