// 発信の下書きの窓口（サーバーの側）。Claude（か決まった返事）に下書きを1つ書かせ、言葉の門を通して返す。
// 材料・お店のメモ・ルールは画面から毎回受け取り、答えを返すだけ。受け取った物はどこにも残さない（docs/SPEC.md §5.1）。
// ここでは送信・公開をしない。保存も画面でオーナーがボタンを押したときだけ。

import { evalGate } from "@/lib/eval/guard";
import { NoAiError } from "@/lib/ai/model";
import { NO_AI_MESSAGE } from "@/lib/ai/wire";
import { claudePostsModel } from "@/lib/posts/claude";
import type { PostsModel } from "@/lib/posts/model";
import { scriptPostsModel } from "@/lib/posts/script";
import { parsePostsRequest, type PostsResponse } from "@/lib/posts/wire";
import { runWrite } from "@/lib/posts/write";
import { getMenus, getPostsAiSettings, getPostsSettings, getShop, getEvalSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function reply(r: PostsResponse, status = 200): Response {
  return Response.json(r, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  // 試験10問（/eval）の札が付いた頼みだけ、サーバーでも「同時に1回だけ」「1回の試験で呼べる回数」を見張る（src/lib/eval/guard.ts）
  const refused = await evalGate(request, getEvalSettings());
  if (refused) return refused;
  const menus = getMenus();
  const settings = getPostsSettings();
  const ai = getPostsAiSettings();

  const raw = await request.text();
  if (raw.length > ai.maxRequestChars) return reply({ ok: false, code: "bad-request", message: "送る物が大きすぎます" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  }
  const parsed = parsePostsRequest(body, settings.kinds, ai.maxMaterialChars, menus.map((m) => m.id));
  if (!parsed.ok) return reply({ ok: false, code: "bad-request", message: parsed.reason }, 400);
  const req = parsed.value;

  try {
    const model: PostsModel = req.mode === "script" ? scriptPostsModel(req.kindDef, req.materials, req.memos) : claudePostsModel(ai.model);
    const r = await runWrite({
      kind: req.kindDef,
      materials: req.materials,
      memos: req.memos,
      rules: req.rules,
      shopName: getShop().name,
      gateWords: settings.gateWords,
      model,
      maxTokens: ai.maxReplyTokens,
      maxTries: ai.maxTries,
      lengthSlack: settings.lengthSlack,
      menuName: (id) => menus.find((m) => m.id === id)?.name ?? id,
    });
    return reply(r.ok ? r : { ...r, code: "gate" });
  } catch (e) {
    if (!(e instanceof NoAiError)) console.error("posts write:", e);
    else console.warn("posts write: AI unavailable:", e.message);
    return reply({ ok: false, code: "no-ai", message: NO_AI_MESSAGE });
  }
}
