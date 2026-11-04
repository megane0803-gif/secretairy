// 広告の見直しの窓口（サーバーの側）。Claude（か決まった返事）に案を1つ出させ、プログラムの門を通して返す。
// 表とルールは画面から毎回受け取り、答えを返すだけ。受け取った物はどこにも残さない（docs/SPEC.md §5.1）。
// 🔒 ここでは広告を変えない。止める・外すのは、オーナーが承認の箱で「承認」を押したときだけ（画面の側）。

import { claudeAdsModel } from "@/lib/ads/claude";
import type { AdsModel } from "@/lib/ads/model";
import { runReview } from "@/lib/ads/review";
import { scriptAdsModel } from "@/lib/ads/script";
import { parseAdsRequest, type AdsResponse } from "@/lib/ads/wire";
import { NoAiError } from "@/lib/ai/model";
import { NO_AI_MESSAGE } from "@/lib/ai/wire";
import { getAdSettings, getAdsAiSettings, getMenus } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function reply(r: AdsResponse, status = 200): Response {
  return Response.json(r, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const menus = getMenus();
  const settings = getAdSettings();
  const ai = getAdsAiSettings();

  const raw = await request.text();
  if (raw.length > ai.maxRequestChars) return reply({ ok: false, code: "bad-request", message: "送る物が大きすぎます" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  }
  const parsed = parseAdsRequest(body, menus.map((m) => m.id), ai.maxFixChars);
  if (!parsed.ok) return reply({ ok: false, code: "bad-request", message: parsed.reason }, 400);
  const req = parsed.value;

  try {
    const model: AdsModel = req.mode === "script" ? scriptAdsModel(req.table) : claudeAdsModel(ai.model);
    const r = await runReview({
      table: req.table,
      rules: req.rules,
      settings,
      menuName: (id) => menus.find((m) => m.id === id)?.name ?? id,
      fix: req.fix,
      model,
      maxTokens: ai.maxReplyTokens,
      maxTries: ai.maxTries,
    });
    return reply(r.ok ? r : { ...r, code: "gate" });
  } catch (e) {
    if (!(e instanceof NoAiError)) console.error("ads review:", e);
    else console.warn("ads review: AI unavailable:", e.message);
    return reply({ ok: false, code: "no-ai", message: NO_AI_MESSAGE });
  }
}
