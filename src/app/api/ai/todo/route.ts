// メモを投げる窓口（サーバーの側。AI を呼ぶ所）。メモとルールを画面から受け取り、
// Claude（Haiku。config/ai.json の todo）か決まった返事で短いタスクの文に直し、門を通して返すだけ。
// 受け取った物はどこにも残さない（docs/SPEC.md §5.1）。お客様の名字は受け取らない形（画面で〔お客様〕に置きかえ済み）。
// ToDo に足す・期限・並べ方は画面のプログラムが決める（Claude が決めるのは文だけ）。

import { NoAiError } from "@/lib/ai/model";
import { NO_AI_MESSAGE } from "@/lib/ai/wire";
import { getMenus, getTodoAiSettings } from "@/lib/settings";
import { runTodo, TodoRefusedError } from "@/lib/todo/run";
import { parseTodoRequest, type TodoResponse } from "@/lib/todo/wire";
import { claudeTodoWriter, scriptTodoWriter } from "@/lib/todo/writer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function reply(body: TodoResponse, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const ai = getTodoAiSettings();
  const raw = await request.text();
  if (raw.length > ai.maxRequestChars) return reply({ ok: false, code: "bad-request", message: "送る物が大きすぎます" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  }
  const parsed = parseTodoRequest(body, ai.maxMemoChars, getMenus().map((m) => m.id));
  if (!parsed.ok) return reply({ ok: false, code: "bad-request", message: parsed.reason }, 400);
  const req = parsed.value;
  try {
    const writer = req.mode === "script" ? scriptTodoWriter() : claudeTodoWriter(ai.model);
    const out = await runTodo({ memo: req.memo, mode: req.mode, writer, rules: req.rules, maxTokens: ai.maxReplyTokens, maxTitleChars: ai.maxTitleChars });
    return reply({ ok: true, ...out });
  } catch (e) {
    if (e instanceof TodoRefusedError)
      return reply({ ok: false, code: "refused", message: "AI がこのメモを ToDo にできませんでした。「決まった返事（AI なし）」で試してください" });
    if (e instanceof NoAiError) console.warn("todo: AI unavailable:", e.message);
    else console.error("todo:", e);
    return reply({ ok: false, code: "no-ai", message: NO_AI_MESSAGE });
  }
}
