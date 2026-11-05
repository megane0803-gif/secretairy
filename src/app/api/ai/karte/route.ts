// カルテ自動作成の窓口（サーバーの側）。施術のメモとルールを画面から受け取り、
// Claude（Haiku。config/ai.json の karte）か決まった返事で下書きを作り、言葉の門を通して返すだけ。
// 受け取った物はどこにも残さない（docs/SPEC.md §5.1）。お客様の名前は受け取らない（画面でプログラムが入れる）。
// 🔒 ここには保存の処理は無い。保存は画面の「保存」ボタン（人）だけ。

import { evalGate } from "@/lib/eval/guard";
import { NoAiError } from "@/lib/ai/model";
import { NO_AI_MESSAGE } from "@/lib/ai/wire";
import { getKarteExamples } from "@/lib/data/seed";
import { parseKarteRequest } from "@/lib/karte/request";
import { KarteRefusedError, runKarte } from "@/lib/karte/run";
import type { KarteResponse } from "@/lib/karte/wire";
import { claudeKarteWriter, scriptKarteWriter } from "@/lib/karte/writer";
import { getAiSettings, getKarteHeadings, getMenus, getEvalSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function reply(body: KarteResponse, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  // 試験10問（/eval）の札が付いた頼みだけ、サーバーでも「同時に1回だけ」「1回の試験で呼べる回数」を見張る（src/lib/eval/guard.ts）
  const refused = await evalGate(request, getEvalSettings());
  if (refused) return refused;
  const ai = getAiSettings();
  const menus = getMenus();
  const headings = getKarteHeadings();

  const raw = await request.text();
  if (raw.length > ai.karte.maxRequestChars) return reply({ ok: false, code: "bad-request", message: "送る物が大きすぎます" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  }
  const parsed = parseKarteRequest(body, ai.karte.maxMemoChars, menus.map((m) => m.id), ai.karte.maxRecordingMemoChars);
  if (!parsed.ok) return reply({ ok: false, code: "bad-request", message: parsed.reason }, 400);
  const req = parsed.value;

  try {
    const writer =
      req.mode === "script" ? scriptKarteWriter(getKarteExamples(), headings) : claudeKarteWriter(ai.karte.model);
    const draft = await runKarte({
      memo: req.memo,
      mode: req.mode,
      writer,
      headings,
      rules: req.rules,
      maxTokens: ai.karte.maxReplyTokens,
      menuName: (id) => menus.find((m) => m.id === id)?.name ?? id,
    });
    return reply({ ok: true, ...draft });
  } catch (e) {
    if (e instanceof KarteRefusedError)
      return reply({ ok: false, code: "refused", message: "AI がこのメモをカルテにできませんでした。「決まった返事（AI なし）」で試してください" });
    if (e instanceof NoAiError) console.warn("karte: AI unavailable:", e.message);
    else console.error("karte:", e);
    return reply({ ok: false, code: "no-ai", message: NO_AI_MESSAGE });
  }
}
