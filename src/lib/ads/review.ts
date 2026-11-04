// 広告の見直しの流れ（サーバーの側で動く。受け取った物は残さない）。
//   AI（か決まった返事）が案を1つ → プログラムの門（gate.ts）
//   → 弾いたら理由を渡して1回だけ作り直す → それでもだめなら案は出さない（画面が日誌に書く）。
// 「直す」のときは、オーナーの一言で1回だけ出しなおし、もう一度門を通す（作り直しはしない）。
// ここでは何も変えない。変えるのは、オーナーが承認の箱で「承認」を押したときだけ。

import type Anthropic from "@anthropic-ai/sdk";
import type { JournalWho } from "../journal";
import type { Rule } from "../rules/types";
import type { AdSettings } from "../settings";
import type { ToolCall } from "../ai/model";
import { draftFrom, gate, proposalLabel, type GateCheck, type GatedProposal } from "./gate";
import type { AdsModel } from "./model";
import { adsSystem, adsUserText } from "./prompt";
import { actionLabel, actionVerb, findRow, tableText, type AdAction, type AdTable } from "./report";
import { AD_TOOL_DEFS } from "./tools";

/** 日誌に書く1行（書くのは画面の側） */
export type ReviewStep = { who: JournalWho; text: string };

export type ReviewInput = {
  table: AdTable;
  rules: Rule[];
  settings: Pick<AdSettings, "channel" | "towns">;
  menuName?: (id: string) => string;
  /** 直す：オーナーの一言と、いまの案 */
  fix?: { text: string; current: { action: AdAction; no: number } };
  model: AdsModel;
  maxTokens: number;
  /** 案を作らせる回数の上限（config/ai.json の ads.maxTries。1回目＋作り直し） */
  maxTries: number;
};

export type ReviewResult =
  | { ok: true; proposal: GatedProposal; checks: GateCheck[]; tries: number; steps: ReviewStep[] }
  | { ok: false; checks: GateCheck[]; problems: string[]; tries: number; steps: ReviewStep[] };

/** 弾かれた案も、日誌では読める形で（道具が止める・外すで、番号が表にあれば言葉も） */
function saidLabel(table: AdTable, call: ToolCall): string {
  const d = draftFrom(call);
  const row = typeof d.no === "number" ? findRow(table, d.no) : null;
  if (d.action && row) return `${proposalLabel({ action: d.action, no: row.no, text: row.text })}${d.extraKeys.length ? `（ほかに ${d.extraKeys.join("・")} も付けた）` : ""}`;
  if (d.action) return `${String(d.no)}番を${actionVerb(d.action)}`;
  return `${call.name}（${JSON.stringify(call.input).slice(0, 60)}）`;
}

export async function runReview(input: ReviewInput): Promise<ReviewResult> {
  const { table, settings, fix, model } = input;
  const system = adsSystem(input.rules, settings, input.menuName ?? ((id) => id));
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: adsUserText(tableText(table, settings.towns), fix ? { text: fix.text, current: actionLabel(fix.current.action, fix.current.no) } : undefined),
    },
  ];
  const tries = fix ? 1 : Math.max(1, input.maxTries);
  const steps: ReviewStep[] = [];
  let last: ReviewResult | null = null;

  for (let i = 1; i <= tries; i++) {
    const turn = await model.turn({ system, messages, tools: AD_TOOL_DEFS, maxTokens: input.maxTokens });
    if (turn.stop === "refusal") {
      steps.push({ who: "プログラム", text: "AI が答えなかったので、広告の案は出さなかった" });
      return { ok: false, checks: last?.checks ?? [], problems: ["AI が答えませんでした"], tries: i, steps };
    }
    const r = gate(table, settings.towns, turn.toolCalls);
    const said = turn.toolCalls[0];
    const what =
      r.ok
        ? proposalLabel(r.proposal)
        : said
          ? saidLabel(table, said)
          : turn.stop === "max_tokens"
            ? "（長くなって途中で切れた）"
            : "（道具を呼ばなかった）";
    steps.push({ who: "AI", text: `広告の案を作った${i > 1 ? `（作り直し${i - 1}回目）` : fix ? "（直す）" : ""}：${what}` });

    if (r.ok) {
      steps.push({ who: "プログラム", text: `門を通した：${r.checks.map((c) => `✓ ${c.label}`).join("・")}` });
      return { ok: true, proposal: r.proposal, checks: r.checks, tries: i, steps };
    }
    last = { ok: false, checks: r.checks, problems: r.problems, tries: i, steps };
    const more = i < tries;
    steps.push({ who: "プログラム", text: `門で弾いた：${r.problems.join("。")}${more ? "（理由を渡して作り直しを頼んだ）" : ""}` });
    if (!more) break;

    // 理由を渡して作り直させる。道具を呼んでいれば、その答えとして返す
    const feedback = `プログラムの門で弾きました：${r.problems.join("。")}。この理由に従って、別の案を1つだけ道具で出しなおしてください。`;
    // 途中で切れた道具の呼び出しは積まない（答えの無い呼び出しは送れない）
    const kept = turn.toolCalls.length > 0 ? turn.assistant : turn.assistant.filter((b) => b.type !== "tool_use");
    messages.push({ role: "assistant", content: kept.length > 0 ? kept : [{ type: "text", text: "（案なし）" }] });
    if (turn.toolCalls.length > 0)
      messages.push({
        role: "user",
        content: turn.toolCalls.map((c, k) => ({
          type: "tool_result" as const,
          tool_use_id: c.id,
          is_error: true,
          content: k === 0 ? feedback : "案は1回に1つです。",
        })),
      });
    else messages.push({ role: "user", content: feedback });
  }

  const final = last!;
  steps.push({
    who: "プログラム",
    text: fix ? "直した案が門を通らなかったので、前の案のままにした" : `門を${final.tries}回通らなかったので、広告の案は出さなかった`,
  });
  return { ...final, steps };
}
