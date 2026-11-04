// LINE の一言を振り分ける窓口（サーバーの側。AI を呼ぶ所）。画面から一言・台帳・ルールを受け取り、答えを返すだけ。
// 受け取った物はどこにも残さない（docs/SPEC.md §5.1）。LINE には送らない（送るのは画面 → /api/line/send）。
// お客様の名前は受け取らない形で AI に渡す（画面で〔お客様〕に置きかえ済み）。
// 🔒 ここには確定の処理は無い。出せるのは仮押さえ（HoldOffer）まで。

import { NoAiError } from "@/lib/ai/model";
import { NO_AI_MESSAGE } from "@/lib/ai/wire";
import { parseLineAskRequest, runLineAsk, type LineAskResponse } from "@/lib/line/ask";
import { scriptSortModel, type SortModel } from "@/lib/line/sort";
import { claudeSortModel } from "@/lib/line/sortClaude";
import { demoClock } from "@/lib/calendar";
import { getAiSettings, getLineAiSettings, getLineSettings, getMenus, getShop } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function reply(r: LineAskResponse, status = 200): Response {
  return Response.json(r, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const shop = getShop();
  const menus = getMenus();
  const ai = getLineAiSettings();
  const raw = await request.text();
  if (raw.length > ai.maxRequestChars) return reply({ ok: false, code: "bad-request", message: "送る物が大きすぎます" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  }
  const parsed = parseLineAskRequest(body, menus, getAiSettings(), getLineSettings().maxTextChars);
  if (!parsed.ok) return reply({ ok: false, code: "bad-request", message: parsed.reason }, 400);
  const req = parsed.value;
  try {
    const today = demoClock(shop, new Date(), req.dayOffset).today;
    const model: SortModel = req.mode === "script" ? scriptSortModel({ menus, today }) : claudeSortModel(ai.model);
    return reply(await runLineAsk({ req, shop, menus, model, maxTokens: ai.maxReplyTokens }));
  } catch (e) {
    if (e instanceof NoAiError) console.warn("line ask: AI unavailable");
    else console.error("line ask: うまくいきませんでした");
    return reply({ ok: false, code: "no-ai", message: NO_AI_MESSAGE });
  }
}
