// 予約チャットの1回の相談（お客様の1つの文への返事）の流れ。
// 返事を作る物（Claude か決まった返事）に道具を渡し、道具を呼ぶたびにプログラムで答える。
// 上限：1回の返事の長さ（maxReplyTokens）と、1回の相談で道具を呼ぶ回数（maxToolCalls）。
// プログラムが先に見ること：週と日付・日付と曜日が食い違う言い方は、決めずに聞き返す（dates.ts）。
// プログラムが後で決めること：候補のボタン（その返事の文に出た候補だけ。仮押さえの後はなし）と、
// 「お店に確かめてご連絡します」と言ったときの ToDo（replies.ts）。
// サーバーはここで受け取った物を残さない。答えは emit で流して返すだけ。

import type Anthropic from "@anthropic-ai/sdk";
import type { AiSettings } from "../settings";
import { dateConflict } from "./dates";
import type { ReplyModel } from "./model";
import { errandLine, promisesShop, shownCandidates } from "./replies";
import { reserveSystem, type ConvHold } from "./reservePrompt";
import { candidateLabel } from "./slots";
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

/** この会話の仮押さえ（承認待ち・承認済み）。指示と決まった返事に渡す */
export function convHoldsOf(ctx: ToolContext): ConvHold[] {
  return ctx.convHolds.flatMap((id) => {
    const b = ctx.booked.find((x) => x.id === id && x.customerId === ctx.customer.id);
    return b ? [{ id, menuId: b.menuId, date: b.date, start: b.start, label: candidateLabel(ctx, b), approved: b.status !== "hold" }] : [];
  });
}

export async function runReserve({ ctx, history, model, limits, emit }: RunOptions): Promise<void> {
  const messages = toMessages(history);
  const lastUser = [...history].reverse().find((t) => t.role === "user")?.text ?? "";

  // 週と日付が食い違う言い方は、勝手に決めずに聞き返す（AI にも決まった返事にも決めさせない）
  const ask = dateConflict(ctx.shop, ctx.today.date, lastUser);
  if (ask) {
    emit({ t: "step", step: { kind: "ask", text: ask.step } });
    emit({ t: "text", d: ask.question });
    emit({ t: "candidates", list: [] });
    emit({ t: "done" });
    return;
  }

  // この相談の中で変わる物（仮押さえを外した・押さえた）は、写しを持って次の道具に効かせる
  const local: ToolContext = { ...ctx, booked: [...ctx.booked], convHolds: [...ctx.convHolds], released: [...ctx.released] };
  const holds = convHoldsOf(local);
  const system = reserveSystem(local, ctx.shown, holds);
  let calls = 0;
  let latest: Candidate[] | null = null;
  const pool: Candidate[] = [];
  let held = false;
  let said = "";
  const say = (d: string) => {
    said += d;
    emit({ t: "text", d });
  };

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
        holds: convHoldsOf(local),
      },
      say,
    );
    if (turn.stop === "refusal") {
      say(LIMIT_REPLY);
      break;
    }
    messages.push({ role: "assistant", content: turn.assistant });
    if (turn.stop === "max_tokens" && turn.toolCalls.length === 0) {
      say("（長くなったので、ここで止めました）");
      break;
    }
    if (turn.toolCalls.length === 0) break;
    if (overLimit) {
      // 上限のあとでまだ道具を呼ぼうとした → 止めて、決まった一言で返す
      emit({ t: "step", step: { kind: "limit", text: `道具を呼ぶ回数の上限（${limits.maxToolCalls}回）に来たので止めた` } });
      say(LIMIT_REPLY);
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
      const out = runTool({ ...local, held }, call.name, call.input);
      for (const s of out.steps) emit({ t: "step", step: s });
      if (out.candidates) {
        latest = out.candidates;
        pool.push(...out.candidates);
      }
      if (out.release) {
        const row = local.booked.find((b) => b.id === out.release);
        if (row) local.released.push({ menuId: row.menuId, date: row.date, start: row.start });
        local.booked = local.booked.filter((b) => b.id !== out.release);
        local.convHolds = local.convHolds.filter((id) => id !== out.release);
        emit({ t: "release", holdId: out.release });
      }
      if (out.hold) {
        held = true;
        latest = [];
        local.booked.push({
          id: out.hold.id,
          customerId: out.hold.customerId,
          menuId: out.hold.menuId,
          date: out.hold.date,
          start: out.hold.start,
          status: "hold",
          newCustomer: ctx.customer.firstVisit,
        });
        local.convHolds.push(out.hold.id);
        emit({ t: "hold", hold: out.hold });
      }
      results.push({ type: "tool_result", tool_use_id: call.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }

  // 候補のボタン：この返事の文に出てきた候補だけ（数も同じ）。仮押さえの後・取りやめた後は出さない
  emit({ t: "candidates", list: shownCandidates(said, pool, latest, held, ctx.shown) });

  // 「お店に確かめてご連絡します」と言ったら、言うだけで終わらせず ToDo に足す（用件はお客様の言葉の1行）
  if (!held && promisesShop(said)) {
    const title = `${ctx.customer.surname}（架空）様：${errandLine(lastUser)}`;
    emit({ t: "step", step: { kind: "todo", text: `ToDo に足した：${title}` } });
    emit({ t: "todo", todo: { id: `td-chat-${ctx.newId()}`, title } });
  }
  emit({ t: "done" });
}
