// 予約チャットの窓口（サーバーの側）。Claude を道具つきで呼び、返事を少しずつ流して返す。
// 台帳とルールは画面から毎回受け取り、答えを返すだけ。受け取った物はどこにも残さない（docs/SPEC.md §5.1）。
// 🔒 ここには確定の処理は無い。出せるのは仮押さえ（HoldOffer）まで。確定は画面の「承認」ボタンだけ。

import { runReserve } from "@/lib/ai/agent";
import { claudeModel } from "@/lib/ai/claude";
import { NoAiError, type ReplyModel } from "@/lib/ai/model";
import { contextFor, parseReserveRequest } from "@/lib/ai/request";
import { scriptModel } from "@/lib/ai/script";
import { NO_AI_MESSAGE, type ReserveEvent } from "@/lib/ai/wire";
import { getAiSettings, getMenus, getShop } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function line(e: ReserveEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(e) + "\n");
}

export async function POST(request: Request): Promise<Response> {
  const shop = getShop();
  const menus = getMenus();
  const ai = getAiSettings();

  const raw = await request.text();
  if (raw.length > ai.maxRequestChars) return Response.json({ t: "error", code: "bad-request", message: "送る物が大きすぎます" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ t: "error", code: "bad-request", message: "形がおかしいです" }, { status: 400 });
  }
  const parsed = parseReserveRequest(body, menus, ai);
  if (!parsed.ok) return Response.json({ t: "error", code: "bad-request", message: parsed.reason }, { status: 400 });

  const req = parsed.value;
  const ctx = contextFor(req, shop, menus);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: ReserveEvent) => controller.enqueue(line(e));
      try {
        const model: ReplyModel = req.mode === "script" ? scriptModel(ctx) : claudeModel(ai.model);
        await runReserve({ ctx, history: req.messages, model, limits: ai, emit });
      } catch (e) {
        if (!(e instanceof NoAiError)) console.error("reserve chat:", e);
        else console.warn("reserve chat: AI unavailable:", e.message);
        emit({ t: "error", code: "no-ai", message: NO_AI_MESSAGE });
        emit({ t: "done" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
