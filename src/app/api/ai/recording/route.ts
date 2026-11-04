// 録音の要点づくりの窓口（サーバーの側）。1つの区切りの文字とルールを画面から受け取り、
// Claude（Haiku。config/ai.json の recording）か決まった返事で要点を作り、言葉の門を通して返すだけ。
// 声は受け取らない（文字にするのはブラウザの中）。受け取った物はどこにも残さない（docs/SPEC.md §5.1）。
// 🔒 ここには保存の処理は無い。カルテの保存は画面の「保存」ボタン（人）だけ。

import { NoAiError } from "@/lib/ai/model";
import { NO_AI_MESSAGE } from "@/lib/ai/wire";
import { NotesRefusedError, runNotes } from "@/lib/recording/run";
import { parseNotesRequest, type NotesResponse } from "@/lib/recording/wire";
import { claudeNotesWriter, scriptNotesWriter } from "@/lib/recording/writer";
import { getKarteHeadings, getMenus, getRecordingAiSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function reply(body: NotesResponse, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const ai = getRecordingAiSettings();
  const menus = getMenus();
  const headings = getKarteHeadings();

  const raw = await request.text();
  if (raw.length > ai.maxRequestChars) return reply({ ok: false, code: "bad-request", message: "送る物が大きすぎます" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  }
  const parsed = parseNotesRequest(body, ai.maxTextChars, menus.map((m) => m.id));
  if (!parsed.ok) return reply({ ok: false, code: "bad-request", message: parsed.reason }, 400);
  const req = parsed.value;

  try {
    const writer = req.mode === "script" ? scriptNotesWriter(headings) : claudeNotesWriter(ai.model);
    const result = await runNotes({
      text: req.text,
      mode: req.mode,
      writer,
      headings,
      rules: req.rules,
      maxTokens: ai.maxReplyTokens,
      maxNotes: ai.maxNotes,
      maxNoteChars: ai.maxNoteChars,
      menuName: (id) => menus.find((m) => m.id === id)?.name ?? id,
    });
    return reply({ ok: true, ...result });
  } catch (e) {
    if (e instanceof NotesRefusedError)
      return reply({ ok: false, code: "refused", message: "AI がこの区切りを要点にできませんでした。「決まった返事（AI なし）」で試してください" });
    if (e instanceof NoAiError) console.warn("recording: AI unavailable:", e.message);
    else console.error("recording:", e);
    return reply({ ok: false, code: "no-ai", message: NO_AI_MESSAGE });
  }
}
