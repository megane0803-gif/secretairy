// 広告の判定と報告の「一言のまとめ」の窓口（サーバーの側）。Claude（Haiku。config/ai.json の adsNote）に1文だけ書かせ、
// 言葉の門（数字なし・使わない言葉なし・英字なし）を通して返す。当たったら返さない（画面は一言を出さない）。
// 画面から受け取るのはプログラムが決めた事実（数字なし）だけ。受け取った物はどこにも残さない（docs/SPEC.md §5.1）。
// 🔒 ここでは広告を変えない。判定も戻す案も、画面のプログラムが決める。

import { NoAiError } from "@/lib/ai/model";
import { NO_AI_MESSAGE } from "@/lib/ai/wire";
import { claudeAdsNoteWriter, parseAdsNoteFacts, runAdsNote, type AdsNoteResponse } from "@/lib/ads/note";
import { getAdSettings, getAdsNoteAiSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function reply(r: AdsNoteResponse, status = 200): Response {
  return Response.json(r, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const ai = getAdsNoteAiSettings();
  const raw = await request.text();
  if (raw.length > ai.maxRequestChars) return reply({ ok: false, code: "bad-request", message: "送る物が大きすぎます" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  }
  const parsed = parseAdsNoteFacts(body);
  if (!parsed.ok) return reply({ ok: false, code: "bad-request", message: parsed.reason }, 400);
  try {
    const out = await runAdsNote(parsed.value, claudeAdsNoteWriter(ai.model), {
      maxTokens: ai.maxReplyTokens,
      maxNoteChars: ai.maxNoteChars,
      gateWords: getAdSettings().gateWords,
    });
    return reply(out.ok ? out : { ok: false, code: "gate", message: out.problems.join("。") });
  } catch (e) {
    if (e instanceof NoAiError) console.warn("ads note: AI unavailable:", e.message);
    else console.error("ads note:", e);
    return reply({ ok: false, code: "no-ai", message: NO_AI_MESSAGE });
  }
}
