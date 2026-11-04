// LINE の Webhook の窓口（https://<公開URL>/api/line）。画面の処理とは混ぜない。
// 1) 届いた中身そのままを LINE_CHANNEL_SECRET で確かめ、署名の違う物は捨てる（何もしない）。
// 2) 合言葉でつないだ人で、画面が開いていれば、短い間だけ預ける（画面が受け取りに来る）。
// ここでは予約・ToDo・カルテを変えない（変えるのは画面＝ブラウザの側）。🔒 確定の処理も無い。
// LINE の人の番号・鍵はログに出さない。

import { handleWebhook } from "@/lib/line/bridge";
import { bridgeDeps, noStore } from "@/lib/line/server";
import { verifyLineSignature } from "@/lib/line/signature";
import { NoStoreError } from "@/lib/line/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 100_000;

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return new Response(null, { status: 413 });
  // 署名の違う物・印の無い物は捨てる
  if (!verifyLineSignature(raw, request.headers.get("x-line-signature"), process.env.LINE_CHANNEL_SECRET))
    return new Response(null, { status: 401 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 400 });
  }
  try {
    await handleWebhook(bridgeDeps(), body);
  } catch (e) {
    if (e instanceof NoStoreError) {
      console.warn("line webhook: Redis につながりません");
      return noStore();
    }
    console.error("line webhook: うまくいきませんでした", e instanceof Error ? e.name : "");
  }
  return new Response(null, { status: 200 });
}
