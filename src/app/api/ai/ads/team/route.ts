// 広告の案の「AI のチーム」の会議の窓口（サーバーの側）。/api/ai/ の下なので Vercel の Firewall で1分10回まで。
// リサーチャー（プログラム）が材料を作り、分身と野党（Claude）を別々に呼び、補佐（Claude）が門を通った2つだけをまとめる。
// Claude を呼ぶのは1回の会議で config/ai.json の adsTeam.maxCalls（3）まで。作り直しはしない。
// 表・案・ルールは画面から毎回受け取り、答えを返すだけ。受け取った物はどこにも残さない（docs/SPEC.md §5.1）。
// 🔒 ここでは広告も承認の箱も変えない。会議には確定・承認の道具を渡さない。決めるのはオーナーのボタンだけ。

import { claudeTeamWriter } from "@/lib/ads/team/claude";
import { meet } from "@/lib/ads/team/meet";
import { parseTeamRequest, type TeamResponse } from "@/lib/ads/team/wire";
import { getAdSettings, getAdsTeamAiSettings, getMenus, getShop } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function reply(r: TeamResponse, status = 200): Response {
  return Response.json(r, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const ai = getAdsTeamAiSettings();
  const settings = getAdSettings();
  const menus = getMenus();
  const raw = await request.text();
  if (raw.length > ai.maxRequestChars) return reply({ ok: false, code: "bad-request", message: "送る物が大きすぎます" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  }
  const parsed = parseTeamRequest(body, menus.map((m) => m.id), ai.maxHistory);
  if (!parsed.ok) return reply({ ok: false, code: "bad-request", message: parsed.reason }, 400);
  const req = parsed.value;
  try {
    const result = await meet(
      {
        table: req.table,
        snapshot: req.snapshot,
        rules: req.rules,
        past: req.past,
        judgements: req.judgements,
        towns: settings.towns,
        shop: getShop(),
        menuName: (id) => menus.find((m) => m.id === id)?.name ?? id,
      },
      req.mode,
      () => claudeTeamWriter(ai.model),
      { maxTokens: ai.maxReplyTokens, maxCalls: ai.maxCalls, maxTwinChars: ai.maxTwinChars, maxLineChars: ai.maxLineChars, gateWords: settings.gateWords },
    );
    if (!result) return reply({ ok: false, code: "bad-request", message: "案の言葉が表にありません" }, 400);
    return reply({ ok: true, result });
  } catch (e) {
    console.error("ads team:", e);
    return reply({ ok: false, code: "bad-request", message: "うまくいきませんでした" }, 500);
  }
}
