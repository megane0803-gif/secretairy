// 予約チャットの1回の相談（お客様の1つの文への返事）の流れ。
// 返事を作る物（Claude か決まった返事）に道具を渡し、道具を呼ぶたびにプログラムで答える。
// 上限：1回の返事の長さ（maxReplyTokens）と、1回の相談で道具を呼ぶ回数（maxToolCalls）。
// サーバーはここで受け取った物を残さない。答えは emit で流して返すだけ。

import type Anthropic from "@anthropic-ai/sdk";
import type { AiSettings } from "../settings";
import type { ReplyModel } from "./model";
import { reserveSystem } from "./reservePrompt";
import { runTool, TOOL_DEFS, type ToolContext } from "./tools";
import type { Candidate, ChatTurn, ReserveEvent } from "./wire";

export type RunOptions = {
  ctx: ToolContext;
  history: ChatTurn[];
  model: ReplyModel;
  limits: Pick<AiSettings, "maxReplyTokens" | "maxToolCalls">;
  emit: (e: ReserveEvent) => void;
};

export const LIMIT_REPLY = "お店に確かめてから、ご連絡します。";

/** 文だけの会話を、Claude に送る形にする（最初はお客様の文から） */
export function toMessages(history: ChatTurn[]): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const t of history) {
    const text = t.text.trim();
    if (!text) continue;
    if (out.length === 0 && t.role !== "user") continue;
    out.push({ role: t.role, content: text });
  }
  return out;
}

export async function runReserve({ ctx, history, model, limits, emit }: RunOptions): Promise<void> {
  const messages = toMessages(history);
  const system = reserveSystem(ctx, ctx.shown);
  let calls = 0;
  let latest: Candidate[] | null = null;
  let held = false;

  // 道具を呼ぶ回数の上限＋最後に答える1回まで。それ以上は回さない
  for (let round = 0; round <= limits.maxToolCalls + 1; round++) {
    const overLimit = calls >= limits.maxToolCalls;
    const turn = await model.turn(
      {
        system,
        messages,
        tools: TOOL_DEFS,
        maxTokens: limits.maxReplyTokens,
        candidates: ctx.shown,
      },
      (d) => emit({ t: "text", d }),
    );
    if (turn.stop === "refusal") {
      emit({ t: "text", d: LIMIT_REPLY });
      break;
    }
    messages.push({ role: "assistant", content: turn.assistant });
    if (turn.stop === "max_tokens" && turn.toolCalls.length === 0) {
      emit({ t: "text", d: "（長くなったので、ここで止めました）" });
      break;
    }
    if (turn.toolCalls.length === 0) break;
    if (overLimit) {
      // 上限のあとでまだ道具を呼ぼうとした → 止めて、決まった一言で返す
      emit({ t: "step", step: { kind: "limit", text: `道具を呼ぶ回数の上限（${limits.maxToolCalls}回）に来たので止めた` } });
      emit({ t: "text", d: LIMIT_REPLY });
      break;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of turn.toolCalls) {
      if (calls >= limits.maxToolCalls) {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          is_error: true,
          content: "道具を呼ぶ回数の上限です。道具を使わずに、いまわかっていることだけで短く答えてください。",
        });
        continue;
      }
      calls += 1;
      const out = runTool({ ...ctx, held }, call.name, call.input);
      for (const s of out.steps) emit({ t: "step", step: s });
      if (out.candidates) latest = out.candidates;
      if (out.hold) {
        held = true;
        latest = [];
        emit({ t: "hold", hold: out.hold });
      }
      results.push({ type: "tool_result", tool_use_id: call.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }

  if (latest) emit({ t: "candidates", list: latest });
  emit({ t: "done" });
}

