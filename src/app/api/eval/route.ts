// 試験10問（/eval）を始める前の合言葉の窓口。AI は呼ばない（AI を呼ぶのは今の /api/ai/ の窓口）。
// 環境変数 EVAL_PASSCODE が無ければ、いつも断る（試験は動かない）。合っていれば、表の上に出すコミットとモデルを返す。
// 合言葉の中身は返さない・残さない・ログに出さない。

import { checkEvalPasscode, evalMeta } from "@/lib/eval/passcode";
import { getEvalSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type EvalStartResponse =
  | { ok: true; commit: string; models: { reserve: string; karte: string; posts: string } }
  | { ok: false; code: "no-passcode" | "wrong" | "bad-request"; message: string };

function reply(body: EvalStartResponse, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const { maxPasscodeChars } = getEvalSettings();
  const raw = await request.text();
  // 合言葉を上限の長さまで（どの字も \uXXXX の形で）送った時の大きさまで受ける
  if (raw.length > JSON.stringify({ passcode: "" }).length + maxPasscodeChars * "\\u0000".length) return reply({ ok: false, code: "bad-request", message: "送る物が大きすぎます" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  }
  const given = body && typeof body === "object" ? (body as { passcode?: unknown }).passcode : undefined;
  const r = checkEvalPasscode(given, process.env.EVAL_PASSCODE, maxPasscodeChars);
  if (r === "no-passcode") return reply({ ok: false, code: "no-passcode", message: "試験の合言葉（EVAL_PASSCODE）が設定されていないので、試験は動きません" }, 503);
  if (r === "wrong") return reply({ ok: false, code: "wrong", message: "合言葉がちがいます" }, 401);
  return reply({ ok: true, ...evalMeta() });
}
