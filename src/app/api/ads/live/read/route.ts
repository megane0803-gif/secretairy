// テスト用アカウントから読み直す（キャンペーンの言葉と状態・除外の言葉。数は出さない）。だれでも（1日の上限）。
// 中身は src/lib/ads/live/server.ts（守り：本番のサイトだけ・受ける形・Origin・3つの環境変数・1日の上限）。AI は呼ばない。

import { liveDeps } from "@/lib/ads/live/deps";
import { handleLiveRead } from "@/lib/ads/live/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return handleLiveRead(request, liveDeps());
}

/** POST のほかは守りが 405 で断る（プレビュー・つないでいない時は「つないでいません」） */
export async function GET(request: Request): Promise<Response> {
  return handleLiveRead(request, liveDeps());
}
