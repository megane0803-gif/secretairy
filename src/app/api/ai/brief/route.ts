// 朝の要点の「AI の一言」の窓口（サーバーの側。AI を呼ぶ所）。材料（印つき・名前なし）とルールを画面から受け取り、
// Claude（Haiku。config/ai.json の brief）か決まった返事で気をつける点を書かせ、門を通して返すだけ。
// 受け取った物はどこにも残さない（docs/SPEC.md §5.1）。日時・数字・お名前は画面のプログラムが印から入れる。

import { NoAiError } from "@/lib/ai/model";
import { NO_AI_MESSAGE } from "@/lib/ai/wire";
import { BriefRefusedError, runBrief } from "@/lib/brief/run";
import { parseBriefRequest, type BriefResponse } from "@/lib/brief/wire";
import { claudeBriefWriter, scriptBriefWriter } from "@/lib/brief/writer";
import { getBriefAiSettings, getMenus } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function reply(body: BriefResponse, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const ai = getBriefAiSettings();
  const raw = await request.text();
  if (raw.length > ai.maxRequestChars) return reply({ ok: false, code: "bad-request", message: "送る物が大きすぎます" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  }
  const parsed = parseBriefRequest(body, ai, getMenus().map((m) => m.id));
  if (!parsed.ok) return reply({ ok: false, code: "bad-request", message: parsed.reason }, 400);
  const req = parsed.value;
  try {
    const writer = req.mode === "script" ? scriptBriefWriter() : claudeBriefWriter(ai.model);
    const out = await runBrief({ items: req.items, mode: req.mode, writer, rules: req.rules, maxTokens: ai.maxReplyTokens, maxNotes: ai.maxNotes, maxNoteChars: ai.maxNoteChars });
    return reply({ ok: true, ...out });
  } catch (e) {
    if (e instanceof BriefRefusedError) return reply({ ok: false, code: "refused", message: "AI が一言を書けませんでした" });
    if (e instanceof NoAiError) console.warn("brief: AI unavailable:", e.message);
    else console.error("brief:", e);
    return reply({ ok: false, code: "no-ai", message: NO_AI_MESSAGE });
  }
}
