// 広告のテスト用アカウントにつながっているか。Google は呼ばない（3つの環境変数がある・プレビューではない、だけで決める）。
// 中身は src/lib/ads/live/server.ts（守り：本番のサイトだけ・受ける形・Origin・3つの環境変数）。AI は呼ばない。

import { liveDeps } from "@/lib/ads/live/deps";
import { handleLiveStatus } from "@/lib/ads/live/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  return handleLiveStatus(request, liveDeps());
}

/** GET のほかは守りが 405 で断る（プレビュー・つないでいない時は「つないでいません」） */
export async function POST(request: Request): Promise<Response> {
  return handleLiveStatus(request, liveDeps());
}
