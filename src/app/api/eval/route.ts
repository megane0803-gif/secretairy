// 試験10問（/eval）を始める・終える窓口。AI は呼ばない（AI を呼ぶのは今の /api/ai/ の窓口）。
// 始める：合言葉（環境変数 EVAL_PASSCODE。無ければいつも断る）を確かめ、サーバーの「流している印」を取る（同時に1回だけ。KV）。
//   取れたら、試験の札（乱数。/api/ai/ の窓口に見出しで付けて送る）と、表の上に出すコミット・モデルを返す。
// 終える：札の印を消す（止めた・終わった時）。途中で落ちた時は、印の期限（config/ai.json の eval.lockSeconds）で消える。
// 合言葉の中身は返さない・残さない・ログに出さない。

import { finishRun, evalStore, GUARD_MESSAGE, startRun } from "@/lib/eval/guard";
import { checkEvalPasscode, evalMeta } from "@/lib/eval/passcode";
import { getEvalSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type EvalStartResponse =
  | { ok: true; token: string; commit: string; models: { reserve: string; karte: string; posts: string } }
  | { ok: false; code: "no-passcode" | "wrong" | "bad-request" | "busy" | "no-store"; message: string };

export type EvalFinishResponse = { ok: true; released: boolean } | { ok: false; code: "bad-request"; message: string };

function reply(body: EvalStartResponse | EvalFinishResponse, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

const TOKEN = /^[0-9a-f]{16,128}$/;

export async function POST(request: Request): Promise<Response> {
  const settings = getEvalSettings();
  const raw = await request.text();
  // 合言葉を上限の長さまで（どの字も \uXXXX の形で）送った時の大きさまで受ける
  if (raw.length > JSON.stringify({ action: "finish", passcode: "" }).length + settings.maxPasscodeChars * "\\u0000".length)
    return reply({ ok: false, code: "bad-request", message: "送る物が大きすぎます" }, 413);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return reply({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  }

  if (body.action === "finish") {
    const token = typeof body.token === "string" && TOKEN.test(body.token) ? body.token : "";
    if (!token) return reply({ ok: false, code: "bad-request", message: "試験の札がありません" }, 400);
    return reply({ ok: true, released: await finishRun(evalStore(), token) });
  }

  const r = checkEvalPasscode(body.passcode, process.env.EVAL_PASSCODE, settings.maxPasscodeChars);
  if (r === "no-passcode") return reply({ ok: false, code: "no-passcode", message: "試験の合言葉（EVAL_PASSCODE）が設定されていないので、試験は動きません" }, 503);
  if (r === "wrong") return reply({ ok: false, code: "wrong", message: "合言葉がちがいます" }, 401);

  const run = await startRun(evalStore(), settings.lockSeconds);
  if (!run.ok) return reply({ ok: false, code: run.code, message: GUARD_MESSAGE[run.code] }, run.code === "busy" ? 409 : 503);
  return reply({ ok: true, token: run.token, ...evalMeta() });
}
