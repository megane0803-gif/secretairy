// 判定と報告の「一言のまとめ」（docs/SPEC.md §1.7.3）。Claude（Haiku。config/ai.json の adsNote）が1文だけ書く。
// 送るのは、プログラムが決めた事実を言葉にした物だけ（数は送らない・書かせない）。答えは言葉の門（words.ts）に通し、
// 当たったら出さない（作り直しはしない）。AI につながらない時も出さない（決まった返事は無い）。
// 一言は飾り：判定・報告・承認の箱は、一言が無くてもそのまま動く。

import Anthropic from "@anthropic-ai/sdk";
import { NoAiError } from "../ai/model";
import { LOCKED_RULES } from "../rules/locked";
import { instructionsFor } from "../rules/prompt";
import { actionPast, actionVerb, type AdAction } from "./report";
import { VERDICT_LABEL, type AdVerdict } from "./results";
import { gateAdSentence } from "./words";

/** 一言を頼むときに送る事実（数字は持たない） */
export type AdsNoteFacts =
  | { kind: "judgement"; verdict: AdVerdict; action: AdAction; word: string; costDown: boolean; bookingsDown: boolean; fewNumbers: boolean }
  | { kind: "report"; outcome: "approved" | "pending" | "skipped" | "none"; action?: AdAction; word?: string; keptTown: boolean; keptFeatured: boolean };

export type AdsNoteResponse = { ok: true; note: string } | { ok: false; code: "gate" | "no-ai" | "bad-request"; message: string };

export type AdsNoteWriteResult = { text: string; stop: "end" | "max_tokens" | "refusal" };

export interface AdsNoteWriter {
  write(req: { system: string; user: string; maxTokens: number }): Promise<AdsNoteWriteResult>;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";
const isAction = (x: unknown): x is AdAction => x === "stop" || x === "exclude";
/** 言葉の名前（表の言葉。40字まで。数字は除く） */
const cleanWord = (x: unknown) => (typeof x === "string" ? x.replace(/[0-9０-９]/g, "").replace(/\s+/g, " ").trim().slice(0, 40) : "");

export function parseAdsNoteFacts(body: unknown): { ok: true; value: AdsNoteFacts } | { ok: false; reason: string } {
  if (!isObj(body) || !isObj(body.facts)) return { ok: false, reason: "形がおかしいです" };
  const f = body.facts;
  if (f.kind === "judgement") {
    if (f.verdict !== "worked" && f.verdict !== "revert" && f.verdict !== "unknown") return { ok: false, reason: "判定がわかりません" };
    if (!isAction(f.action)) return { ok: false, reason: "止めたか外したかがわかりません" };
    return {
      ok: true,
      value: { kind: "judgement", verdict: f.verdict, action: f.action, word: cleanWord(f.word), costDown: f.costDown === true, bookingsDown: f.bookingsDown === true, fewNumbers: f.fewNumbers === true },
    };
  }
  if (f.kind === "report") {
    const outcomes = ["approved", "pending", "skipped", "none"] as const;
    const outcome = outcomes.find((o) => o === f.outcome);
    if (!outcome) return { ok: false, reason: "見直しの結果がわかりません" };
    return {
      ok: true,
      value: {
        kind: "report",
        outcome,
        ...(isAction(f.action) ? { action: f.action } : {}),
        ...(cleanWord(f.word) ? { word: cleanWord(f.word) } : {}),
        keptTown: f.keptTown === true,
        keptFeatured: f.keptFeatured === true,
      },
    };
  }
  return { ok: false, reason: "形がおかしいです" };
}

export function adsNoteSystem(): string {
  return [
    instructionsFor(LOCKED_RULES, { tab: "ads", menuIds: [] }, (id) => id),
    "",
    "# この仕事",
    "- あなたは架空の美容室のオーナーに、広告（架空）の見直しの結果を一言で伝える係です。決めるのはオーナーです。",
    "- 1文だけ（40字くらいまで）。やさしい言葉で、オーナーが次に見るとよい所を1つだけ。",
    "- 数字（算用数字・漢数字）・日付・曜日・お金の額は書かない。数はプログラムが画面に入れています。",
    "- だれかを責める言い方をしない（「〜のせい」「失敗」など）。言い切らない（「必ず」「絶対」「確実」は使わない）。",
    "- 会社・広告のサービスの名前や英字は書かない。運用を外に頼む話はしない。",
    "- 判定はプログラムが決めた物。判定を変えたり、新しく止める言葉を足したりしない。",
  ].join("\n");
}

export function adsNoteUserText(f: AdsNoteFacts): string {
  if (f.kind === "judgement") {
    const lines = [
      "# 効いたかの判定（プログラムが数を比べた結果）",
      `- 言葉：「${f.word}」（${actionPast(f.action)}）`,
      `- 判定：${VERDICT_LABEL[f.verdict]}`,
      `- お金：${f.costDown ? "減った" : "減っていない"}`,
      `- 予約：${f.bookingsDown ? "減った" : "減っていない"}`,
    ];
    if (f.fewNumbers) lines.push("- 数が少なくて、違いが分かりにくい");
    if (f.verdict === "revert") lines.push(`- ${actionVerb(f.action)}前に戻す案を承認の箱に入れた（決めるのはオーナー）`);
    lines.push("", "オーナーへの一言を、ひとつの短い文で書いてください。");
    return lines.join("\n");
  }
  const what =
    f.outcome === "approved"
      ? `「${f.word ?? ""}」を${f.action ? actionPast(f.action) : "止めた"}`
      : f.outcome === "pending"
        ? `「${f.word ?? ""}」を${f.action ? actionVerb(f.action) : "止める"}案が承認待ち`
        : f.outcome === "skipped"
          ? "案は見送った（何も止めていない）"
          : "案は出なかった（何も止めていない）";
  const lines = ["# 今週の見直し（プログラムがまとめた結果）", `- ${what}`];
  if (f.keptTown) lines.push("- 町の名前の言葉は、近くのお客様の言葉なので外していない");
  if (f.keptFeatured) lines.push("- 売りのメニューの言葉は、止めずに残した");
  lines.push("", "オーナーへの一言を、ひとつの短い文で書いてください。");
  return lines.join("\n");
}

/** 一言を作って門に通す。通らなければ null（出さない） */
export async function runAdsNote(
  facts: AdsNoteFacts,
  writer: AdsNoteWriter,
  limits: { maxTokens: number; maxNoteChars: number; gateWords: string[] },
): Promise<{ ok: true; note: string } | { ok: false; problems: string[] }> {
  const out = await writer.write({ system: adsNoteSystem(), user: adsNoteUserText(facts), maxTokens: limits.maxTokens });
  if (out.stop === "refusal") return { ok: false, problems: ["AI が答えませんでした"] };
  if (out.stop === "max_tokens") return { ok: false, problems: ["長くなって途中で切れました"] };
  const g = gateAdSentence(out.text, limits.gateWords);
  if (!g.ok) return { ok: false, problems: g.problems };
  if ([...g.text].length > limits.maxNoteChars) return { ok: false, problems: ["長すぎます"] };
  return { ok: true, note: g.text };
}

/** Claude（Haiku）で書く。サーバーの側だけで使う（鍵は .env.local の ANTHROPIC_API_KEY） */
export function claudeAdsNoteWriter(model: string, apiKey: string | undefined = process.env.ANTHROPIC_API_KEY): AdsNoteWriter {
  if (!apiKey) throw new NoAiError("ANTHROPIC_API_KEY がありません");
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 20_000 });
  return {
    async write(req) {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          // 短い1文だけなので考える深さは浅く
          output_config: { effort: "low" },
        });
      } catch (e) {
        if (e instanceof Anthropic.APIError) throw new NoAiError(`${e.status ?? ""} ${e.message}`.trim());
        throw new NoAiError(e instanceof Error ? e.message : String(e));
      }
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      const stop = message.stop_reason === "refusal" ? "refusal" : message.stop_reason === "max_tokens" ? "max_tokens" : "end";
      return { text, stop };
    },
  };
}
