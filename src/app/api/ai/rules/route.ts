// ルールを言葉で書いて足す窓口（サーバーの側。AI を呼ぶ所）。文を画面から受け取り、
// Claude（Haiku。config/ai.json の ruleWords）で足す欄に当てはめ、プログラム（src/lib/rules/words.ts）が欄の中身に直して返すだけ。
// AI が返した種類・数（今の上限と下限の中か）・メニュー（本当にあるか）は、ここ（サーバー）で確かめる。聞き返しの答えもここを通す。
// 保存はしない（足すのは画面の人の「足す」ボタン）。受け取った物はどこにも残さない（docs/SPEC.md §5.1）。
// 🔒 を緩める文は AI に送らずに断る。

import { NoAiError } from "@/lib/ai/model";
import { NO_AI_MESSAGE } from "@/lib/ai/wire";
import { claudeRuleReader } from "@/lib/rules/wordsClaude";
import { parseRuleWordsRequest, RuleWordsRefusedError, runRuleWords, scriptRuleReader, type RuleReader, type RuleWordsResponse } from "@/lib/rules/words";
import { getMenus, getRuleWordsAiSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function reply(body: RuleWordsResponse, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const ai = getRuleWordsAiSettings();
  const raw = await request.text();
  if (raw.length > ai.maxRequestChars) return reply({ ok: false, code: "bad-request", message: "送る物が大きすぎます" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply({ ok: false, code: "bad-request", message: "形がおかしいです" }, 400);
  }
  const parsed = parseRuleWordsRequest(body, ai.maxTextChars);
  if (!parsed.ok) return reply({ ok: false, code: "bad-request", message: parsed.reason }, 400);
  const menus = getMenus().map((m) => ({ id: m.id, name: m.name }));
  try {
    // Claude は文を読むときに作る（🔒 の文は AI に送らずに断るので、鍵が無くても断れる）
    const reader: RuleReader = parsed.value.mode === "script" ? scriptRuleReader(menus) : { read: (req) => claudeRuleReader(ai.model).read(req) };
    // 聞き返しの答え（reading と answers）のときは AI を呼ばず、読みと答えをここでもう一度確かめる（画面だけに頼らない）
    const { text, reading, answers } = parsed.value;
    const out = await runRuleWords({ text, reader, menus, maxTokens: ai.maxReplyTokens, ...(reading !== undefined ? { reading, answers } : {}) });
    return reply({ ok: true, ...out });
  } catch (e) {
    if (e instanceof RuleWordsRefusedError)
      return reply({ ok: false, code: "refused", message: "AI がこの文を読めませんでした。下の欄で足してください" });
    if (e instanceof NoAiError) console.warn("rules: AI unavailable:", e.message);
    else console.error("rules:", e);
    return reply({ ok: false, code: "no-ai", message: NO_AI_MESSAGE });
  }
}
