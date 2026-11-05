// 発信の下書きの「AI のチーム」の会議の窓口（サーバーの側）。/api/ai/ の下なので Vercel の Firewall で1分10回まで。
// 分身と野党（Claude）を別々に呼び、プログラムが直しを1つずつ確かめ、補佐（Claude）は確かめ済みの候補（番号つき）だけを読む。
// Claude を呼ぶのは1回の会議で config/ai.json の postsTeam.maxCalls（3）まで。作り直しはしない。
// 下書き・お店のメモ・ルールは画面から毎回受け取り、答えを返すだけ。受け取った物はどこにも残さない（docs/SPEC.md §5.1）。
// 🔒 ここでは下書きを書きかえない・保存しない・送信しない・公開しない。道具も渡さない。入れるかはオーナーが選ぶ。

import { claudeTeamWriter } from "@/lib/ads/team/claude";
import { runLimitsOf } from "@/lib/posts/team/client";
import { meetPost } from "@/lib/posts/team/meet";
import { parsePostTeamRequest, type PostTeamResponse } from "@/lib/posts/team/wire";
import { TOO_LONG } from "@/lib/posts/team/types";
import { getMenus, getPostsSettings, getPostsTeamAiSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function reply(r: PostTeamResponse, status = 200): Response {
  return Response.json(r, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const ai = getPostsTeamAiSettings();
  const settings = getPostsSettings();
  const menus = getMenus();
  const raw = await request.text();
  if (raw.length > ai.maxRequestChars) return reply({ ok: false, code: "bad-request", message: "送る物が大きすぎます" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  }
  const parsed = parsePostTeamRequest(body, settings.kinds, ai.maxDraftChars, menus.map((m) => m.id));
  if (!parsed.ok) return reply({ ok: false, code: parsed.code, message: parsed.reason }, parsed.code === "long" ? 413 : 400);
  const req = parsed.value;
  try {
    const result = await meetPost(
      {
        kind: req.kindDef,
        text: req.text,
        pieces: req.pieces,
        memos: req.memos,
        rules: req.rules,
        gateWords: settings.gateWords,
        menuName: (id) => menus.find((m) => m.id === id)?.name ?? id,
      },
      req.mode,
      () => claudeTeamWriter(ai.model),
      runLimitsOf(ai),
    );
    if (!result) return reply({ ok: false, code: "long", message: TOO_LONG }, 413);
    return reply({ ok: true, result });
  } catch (e) {
    console.error("posts team:", e);
    return reply({ ok: false, code: "bad-request", message: "うまくいきませんでした" }, 500);
  }
}
