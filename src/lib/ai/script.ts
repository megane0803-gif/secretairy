// 決まった返事（AI なし）。テストで Claude の代わりに使う。AI につながらないときの「お試し」にも使う。
// 言葉の読み取りは決まった形だけ（例文の「11/6（金）の15:00からカットを…」「前と同じで」「1つ目で」、
// 「カットとヘッドスパ」「11/6か11/13」「11月の金曜」「来週の金曜」「ずらしたい」「やめたい」「今日やってますか」など）。
// 道具は Claude と同じ物（tools.ts）を同じ流れ（agent.ts）で呼ぶので、仮押さえまでの道筋は本番と同じ。

import type Anthropic from "@anthropic-ai/sdk";
import { addDays } from "../calendar";
import { findDates, monthAndWeekday, normalizeText, weekAndWeekday } from "./dates";
import type { ModelRequest, ModelTurn, ReplyModel, ToolCall } from "./model";
import {
  ASK_SHOP_REPLY,
  asksOpenToday,
  CANCELED_REPLY,
  isCancel,
  isErrand,
  isShift,
  isThanks,
  openTodayLine,
  THANKS_REPLY,
} from "./replies";
import type { SlotContext } from "./slots";
import type { ToolName } from "./tools";

type Listed = { no: number; label: string; menu_id: string; date: string; start: string };

/** お客様の文から、メニュー（いくつか）・日付（いくつか）・幅のある言い方・時刻を読む（決まった形だけ） */
export function readRequest(ctx: Pick<SlotContext, "menus" | "today">, text: string) {
  const t = normalizeText(text);
  // メニューの名前を長い順に当て、当たった所は消して重ねて数えない（「カット＋カラー」と「カット」）
  let rest = t;
  const found: { id: string; at: number }[] = [];
  for (const m of [...ctx.menus].sort((a, b) => b.name.length - a.name.length)) {
    const at = rest.indexOf(m.name);
    if (at < 0) continue;
    found.push({ id: m.id, at });
    rest = rest.slice(0, at) + "□".repeat(m.name.length) + rest.slice(at + m.name.length);
  }
  const menuIds = found.sort((a, b) => a.at - b.at).map((f) => f.id);

  const dates = [...new Set(findDates(ctx.today.date, t).map((d) => d.date))];
  let date: string | null = dates[0] ?? null;
  if (!date) date = weekAndWeekday(ctx.today.date, t);
  if (!date && t.includes("今日")) date = ctx.today.date;
  if (!date && t.includes("明日")) date = addDays(ctx.today.date, 1);
  const span = dates.length ? null : monthAndWeekday(ctx.today.date, t);

  let start: string | null = null;
  const hm = t.match(/(\d{1,2}):(\d{2})/) ?? t.match(/(\d{1,2})時(半)?/);
  if (hm) {
    const h = Number(hm[1]);
    const m = hm[2] === "半" ? 30 : hm[2] && /^\d+$/.test(hm[2]) ? Number(hm[2]) : 0;
    if (h >= 0 && h < 24 && m < 60) start = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  return { menuId: menuIds[0] ?? null, menuIds, date, dates, span, start };
}

/** 「1つ目で」→ 0、「2つ目」→ 1。候補を選んでいなければ null */
export function readChoice(text: string, count: number): number | null {
  if (count === 0) return null;
  const t = normalizeText(text);
  const words = ["1|一|ひと", "2|二|ふた", "3|三|みっ", "4|四|よっ"];
  for (let i = 0; i < Math.min(count, words.length); i++) if (new RegExp(`(${words[i]})つ目|${i + 1}番`).test(t)) return i;
  if (/^(はい|それで|お願いします|おねがいします)/.test(t.trim())) return 0;
  return null;
}

function listText(list: Listed[]): string {
  return list.map((c) => `${c.no}つ目：${c.label}`).join("、");
}

function lastUserText(messages: Anthropic.Beta.BetaMessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

/** いちばん最後の道具の答え（名前と中身）。最後がお客様の文なら null */
function lastToolResult(messages: Anthropic.Beta.BetaMessageParam[]): { name: ToolName; data: Record<string, unknown> } | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || typeof last.content === "string") return null;
  const res = last.content.find((b): b is Anthropic.Beta.BetaToolResultBlockParam => b.type === "tool_result");
  if (!res) return null;
  const prev = messages[messages.length - 2];
  let use: Anthropic.Beta.BetaToolUseBlockParam | undefined;
  if (prev && Array.isArray(prev.content))
    for (const b of prev.content) if (b.type === "tool_use" && b.id === res.tool_use_id) use = b;
  let data: Record<string, unknown> = {};
  try {
    data = typeof res.content === "string" ? JSON.parse(res.content) : {};
  } catch {
    data = {};
  }
  return use ? { name: use.name as ToolName, data } : null;
}

export function scriptModel(ctx: Pick<SlotContext, "menus" | "today" | "shop" | "now">): ReplyModel {
  let n = 0;
  const say = async (text: string, onText: (d: string) => void): Promise<ModelTurn> => {
    // 少しずつ流す（本番と同じ見え方にする）
    for (const part of text.match(/[^、。]+[、。]?/g) ?? [text]) onText(part);
    return { assistant: [{ type: "text", text }], toolCalls: [], stop: "end" };
  };
  const call = (name: ToolName, input: Record<string, unknown>): ModelTurn => {
    n += 1;
    const c: ToolCall = { id: `script-${n}`, name, input };
    return { assistant: [{ type: "tool_use", id: c.id, name, input }], toolCalls: [c], stop: "tool" };
  };

  /** 読んだ頼みから、道具を1つ選ぶ（メニューが無ければ fallbackMenu） */
  const ask = (r: ReturnType<typeof readRequest>, fallbackMenu?: string, fallbackDate?: string): ModelTurn | null => {
    const menu_ids = r.menuIds.length ? r.menuIds : fallbackMenu ? [fallbackMenu] : [];
    if (!menu_ids.length) return null;
    if (r.dates.length > 1) return call("find_openings", { menu_ids, dates: r.dates, ...(r.start ? { after: r.start } : {}) });
    if (r.span) return call("find_openings", { menu_ids, month: r.span.month, weekday: r.span.weekday, ...(r.start ? { after: r.start } : {}) });
    // 日を言わずに時刻だけ（「18時にずらしたい」）なら、前の日（外した仮押さえの日）のその時刻で確かめる
    const date = r.date ?? fallbackDate;
    if (date && r.start) return call("check_rules", { menu_ids, date, start: r.start });
    return call("find_openings", { menu_ids, ...(date ? { date } : {}) });
  };

  return {
    async turn(req: ModelRequest, onText) {
      const tool = lastToolResult(req.messages);
      const text = lastUserText(req.messages);
      if (!tool) {
        const choice = readChoice(text, req.candidates.length);
        if (choice !== null) {
          const c = req.candidates[choice];
          return call("place_hold", { menu_ids: [c.menuId], date: c.date, start: c.start });
        }
        // 仮押さえの後の「ずらしたい」「やめたい」：前の仮押さえを外してから
        if (isCancel(text) || isShift(text)) {
          const open = [...req.holds].reverse().find((h) => !h.approved);
          if (open) return call("release_hold", { hold_id: open.id });
          if (req.holds.some((h) => h.approved)) return say(ASK_SHOP_REPLY, onText);
          if (isCancel(text)) return say(CANCELED_REPLY, onText);
        }
        if (asksOpenToday(text)) return say(openTodayLine(ctx.shop, ctx.now), onText);
        if (isErrand(text)) return say(ASK_SHOP_REPLY, onText);
        if (/前と同じ|前回と同じ|いつもの/.test(text)) return call("previous_visit", {});
        const r = readRequest(ctx, text);
        if (isThanks(text) && !r.date && !r.start && !r.span) return say(THANKS_REPLY, onText);
        return ask(r) ?? say("ご希望のメニューを教えてください。", onText);
      }

      const d = tool.data;
      const list = (Array.isArray(d.candidates) ? d.candidates : []) as Listed[];
      const pick = "よろしければ「1つ目で」のようにお返事ください。";
      switch (tool.name) {
        case "previous_visit":
          if (d.found && typeof d.menu_id === "string") return call("find_openings", { menu_ids: [d.menu_id] });
          return say("前回の記録なし（カルテが見つかりませんでした）。ご希望のメニューを教えてください。", onText);
        case "release_hold": {
          if (!d.ok) return say(ASK_SHOP_REPLY, onText);
          if (isCancel(text) && !isShift(text)) return say(`${d.released} の仮押さえを外しました。${CANCELED_REPLY}`, onText);
          // ずらす：言った日時か、同じメニューで外した日から探しなおす（外した枠は出さない）
          const next = ask(readRequest(ctx, text), String(d.menu_id), String(d.date));
          return next ?? say(`${d.released} の仮押さえを外しました。ご希望の日時を教えてください。`, onText);
        }
        case "find_openings":
          if (list.length === 0) {
            const reason = typeof d.reason === "string" ? d.reason : "あいにく空きが見つかりませんでした。";
            // 組み合わせそのものを受けられないときは、日を変えても同じなので理由だけ
            return say(/いっしょには/.test(reason) ? reason : `${reason}別の日をお知らせください。`, onText);
          }
          return say(`${d.menu}は、${listText(list)} が空いています。${pick}`, onText);
        case "check_rules":
          if (d.ok) return say(`${listText(list)} でお取りできます。${pick}`, onText);
          return say(
            `${d.reason}${list.length ? `代わりに、${listText(list)} はいかがでしょう。${pick}` : /いっしょには/.test(String(d.reason)) ? "" : "別の日をお知らせください。"}`,
            onText,
          );
        case "place_hold":
          if (d.ok) return say(`${d.held} を仮でお取りしました。お店から確定のご連絡をします。`, onText);
          if (d.reason)
            return say(`${d.reason}${list.length ? `代わりに、${listText(list)} はいかがでしょう。${pick}` : ""}`, onText);
          return say(ASK_SHOP_REPLY, onText);
      }
      return say(ASK_SHOP_REPLY, onText);
    },
  };
}
