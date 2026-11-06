// 予約チャットの1回の相談（お客様の1つの文への返事）の流れ。
// 返事を作る物（Claude か決まった返事）に道具を渡し、道具を呼ぶたびにプログラムで答える。
// 上限：1回の返事の長さ（maxReplyTokens）と、1回の相談で道具を呼ぶ回数（maxToolCalls）。
// プログラムが先に見ること：週と日付・日付と曜日が食い違う言い方は、決めずに聞き返す（dates.ts）。
// プログラムが後で決めること：候補のボタン（その返事の文に出た候補だけ。仮押さえの後はなし）と、
// 「お店に確かめてご連絡します」と言ったときの ToDo（replies.ts）・料金の答え（店の設定の値段。prices.ts）・
// 「?」を全角の「？」にそろえる。
// お客様に伝えない理由（rules/tellable.ts）で断るときは、AI に文を作らせず、プログラムが
// 「その時間はお受けできません」＋道具が確かめた代わりの候補で返す（AI に理由の中身も返事の番も渡さない）。
// AI の文は、送る前に返事の門（innerGate.ts）を通す。伝えない種類のルールの言葉があれば、決まった文に差し替える。
// サーバーはここで受け取った物を残さない。答えは emit で流して返すだけ。

import type Anthropic from "@anthropic-ai/sdk";
import { guestTitleHead } from "../guestName";
import type { AiSettings } from "../settings";
import { dateConflict } from "./dates";
import type { ReplyModel } from "./model";
import { INTERNAL_REFUSAL } from "../rules/tellable";
import { innerWordsHit } from "./innerGate";
import { alsoBooking, priceAnswer } from "./prices";
import { ASK_SHOP_REPLY, errandLine, promisesShop, shownCandidates } from "./replies";
import { reserveSystem, type ConvHold } from "./reservePrompt";
import { candidateLabel, MAX_CANDIDATES, sameSlot, type SlotContext } from "./slots";
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
/** 候補を出したあとの、選び方の一言 */
export const PICK_LINE = "よろしければ「1つ目で」のようにお返事ください。";

function listLine(ctx: Pick<SlotContext, "shop" | "menus">, list: Candidate[]): string {
  return list.map((c, i) => `${i + 1}つ目：${candidateLabel(ctx, c)}`).join("、");
}

/**
 * プログラムが決める返事（AI に作らせない）。
 * - 仮押さえができた → 仮押さえの一言
 * - 断った（reason はプログラムの決まった1文）→ その1文＋代わりの候補（無ければ別の日時をたずねる。組み合わせは日を変えても同じなので理由だけ）
 * - 断っていない → 候補を出す（無ければ「お店に確かめてご連絡します」）
 */
export function fixedReply(
  ctx: Pick<SlotContext, "shop" | "menus">,
  x: { held?: Candidate; reason?: string; combo?: boolean; candidates: Candidate[] },
): string {
  if (x.held) return `${candidateLabel(ctx, x.held)} を仮でお取りしました。お店から確定のご連絡をします。`;
  const list = x.candidates.slice(0, MAX_CANDIDATES);
  if (x.reason) {
    if (list.length) return `${x.reason}代わりに、${listLine(ctx, list)} はいかがでしょう。${PICK_LINE}`;
    return x.combo ? x.reason : `${x.reason}別の日時をお知らせください。`;
  }
  if (list.length) return `${listLine(ctx, list)} でお取りできます。${PICK_LINE}`;
  return ASK_SHOP_REPLY;
}

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

/** 日本語の返事の「?」は全角の「？」にそろえる（英数字にはさまれた物はそのまま） */
/** 道具の答え（JSON）の reason（お客様への1文） */
function reasonOf(content: string): string | null {
  try {
    const d = JSON.parse(content) as { ok?: boolean; reason?: unknown };
    return typeof d.reason === "string" ? d.reason : null;
  } catch {
    return null;
  }
}

export function fullWidthQuestion(text: string): string {
  return text.replace(/\?/g, (q, i: number, all: string) => (/[A-Za-z0-9]/.test(all[i - 1] ?? "") && /[A-Za-z0-9]/.test(all[i + 1] ?? "") ? q : "？"));
}

export async function runReserve({ ctx, history, model, limits, emit: send }: RunOptions): Promise<void> {
  // お客様に流す文は、どれも「？」をそろえてから（AI の文も、プログラムの決まった文も）
  const emit = (e: ReserveEvent) => send(e.t === "text" ? { ...e, d: fullWidthQuestion(e.d) } : e);
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

  // 料金は AI に書かせない：店の設定のメニューの値段をプログラムが返す（設定に無い物だけ「お店に確かめます」）
  const price = priceAnswer(ctx.menus, lastUser);
  let said = "";
  // プログラムの文（料金）はすぐ流す。AI の文は、返事の門を通すまで流さずにためる
  const sayNow = (d: string) => {
    said += d;
    emit({ t: "text", d });
  };
  let aiText = "";
  const say = (d: string) => {
    aiText += d;
  };
  if (price) {
    emit({ t: "step", step: { kind: "price", text: price.step } });
    sayNow(price.text);
    if (!alsoBooking(lastUser)) {
      // 料金だけの相談は、ここで終わり（AI は呼ばない）
      emit({ t: "candidates", list: [] });
      if (price.askShop) addShopTodo();
      emit({ t: "done" });
      return;
    }
    sayNow("\n");
  }

  // この相談の中で変わる物（仮押さえを外した・押さえた）は、写しを持って次の道具に効かせる
  const local: ToolContext = { ...ctx, booked: [...ctx.booked], convHolds: [...ctx.convHolds], released: [...ctx.released] };
  const holds = convHoldsOf(local);
  const system = reserveSystem(local, ctx.shown, holds) + (price ? `\n- 料金はプログラムがもう答えた（${price.text}）。値段は書かない・くり返さない。` : "");
  let calls = 0;
  let latest: Candidate[] | null = null;
  const pool: Candidate[] = [];
  let held = false;
  let heldSlot: Candidate | undefined;
  /** プログラムが決めた返事（伝えない理由で断った）。あれば AI の文は使わない */
  let programReply: string | null = null;
  /** 道具が返した、お客様に伝えてよい断りの1文（返事の門で差し替えるときに使う） */
  let lastReason: { text: string; combo: boolean } | undefined;

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
    let hidden: { reason: string; combo: boolean } | null = null;
    const round: Candidate[] = [];
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
        for (const c of out.candidates) if (!round.some((r) => sameSlot(r, c))) round.push(c);
      }
      if (out.hidden && !hidden) hidden = { reason: out.hiddenReason ?? INTERNAL_REFUSAL, combo: !!out.combo };
      const r = reasonOf(out.content);
      if (r && !out.hidden) lastReason = { text: r, combo: !!out.combo };
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
        heldSlot = { menuId: out.hold.menuId, date: out.hold.date, start: out.hold.start };
        emit({ t: "hold", hold: out.hold });
      }
      results.push({ type: "tool_result", tool_use_id: call.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
    }
    if (hidden) {
      // 伝えない理由で断った：AI に返事を作らせない。プログラムが決まった1文と、道具が確かめた代わりの候補で返す
      programReply = fixedReply(ctx, { held: heldSlot, reason: hidden.reason, combo: hidden.combo, candidates: round });
      emit({ t: "step", step: { kind: "reject", text: `お客様に伝えないルールなので、返事はプログラムの決まった文にした（「${hidden.reason.replace(/。$/, "")}」と代わりの候補）` } });
      break;
    }
    messages.push({ role: "user", content: results });
  }

  // 返事の門：AI の文に、伝えない種類のルールの文や「○分あける」の形があれば、決まった文に差し替える
  let reply = programReply ?? aiText;
  if (programReply === null) {
    const hit = innerWordsHit(aiText, ctx.rules);
    if (hit) {
      reply = fixedReply(ctx, { held: heldSlot, reason: lastReason?.text, combo: lastReason?.combo, candidates: latest ?? [] });
      emit({ t: "step", step: { kind: "reject", text: `返事に店の中の決まりの言葉（${hit}）があったので、決まった文に差し替えた` } });
    }
  }
  if (reply) sayNow(reply);

  // 候補のボタン：この返事の文に出てきた候補だけ（数も同じ）。仮押さえの後・取りやめた後は出さない
  emit({ t: "candidates", list: shownCandidates(said, pool, latest, held, ctx.shown) });

  // 「お店に確かめてご連絡します」と言ったら、言うだけで終わらせず ToDo に足す（用件はお客様の言葉の1行）
  if (!held && promisesShop(said)) addShopTodo();
  emit({ t: "done" });

  function addShopTodo() {
    const title = `${guestTitleHead(ctx.customer.surname)}${errandLine(lastUser)}`;
    emit({ t: "step", step: { kind: "todo", text: `ToDo に足した：${title}` } });
    emit({ t: "todo", todo: { id: `td-chat-${ctx.newId()}`, title } });
  }
}
