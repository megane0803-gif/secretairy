// 決まった返事（AI なし）。テストで Claude の代わりに使う。AI につながらないときの「お試し」にも使う。
// 言葉の読み取りは決まった形だけ（例文の「11/6（金）の15:00からカットを…」「前と同じで」「1つ目で」など）。
// 道具は Claude と同じ物（tools.ts）を同じ流れ（agent.ts）で呼ぶので、仮押さえまでの道筋は本番と同じ。

import type Anthropic from "@anthropic-ai/sdk";
import { dateFromMonthDay, addDays } from "../calendar";
import type { ModelRequest, ModelTurn, ReplyModel, ToolCall } from "./model";
import type { SlotContext } from "./slots";
import type { ToolName } from "./tools";

type Listed = { no: number; label: string; menu_id: string; date: string; start: string };

/** 全角の数字・記号を半角に */
function normalize(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ":")
    .replace(/[／]/g, "/")
    .replace(/\+/g, "＋");
}

/** お客様の文から、メニュー・日付・時刻を読む（決まった形だけ） */
export function readRequest(ctx: Pick<SlotContext, "menus" | "today">, text: string) {
  const t = normalize(text);
  const menu = [...ctx.menus].sort((a, b) => b.name.length - a.name.length).find((m) => t.includes(m.name));
  let date: string | null = null;
  const md = t.match(/(\d{1,2})\s*[/月]\s*(\d{1,2})/);
  if (md) date = dateFromMonthDay(ctx.today.date, Number(md[1]), Number(md[2]));
  else if (t.includes("今日")) date = ctx.today.date;
  else if (t.includes("明日")) date = addDays(ctx.today.date, 1);
  let start: string | null = null;
  const hm = t.match(/(\d{1,2}):(\d{2})/) ?? t.match(/(\d{1,2})時(半)?/);
  if (hm) {
    const h = Number(hm[1]);
    const m = hm[2] === "半" ? 30 : hm[2] && /^\d+$/.test(hm[2]) ? Number(hm[2]) : 0;
    if (h >= 0 && h < 24 && m < 60) start = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  return { menuId: menu?.id ?? null, date, start };
}

/** 「1つ目で」→ 0、「2つ目」→ 1。候補を選んでいなければ null */
export function readChoice(text: string, count: number): number | null {
  if (count === 0) return null;
  const t = normalize(text);
  if (/(1|一|ひと)つ目|1番/.test(t)) return 0;
  if (/(2|二|ふた)つ目|2番/.test(t)) return count >= 2 ? 1 : null;
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

export function scriptModel(ctx: Pick<SlotContext, "menus" | "today">): ReplyModel {
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

  return {
    async turn(req: ModelRequest, onText) {
      const tool = lastToolResult(req.messages);
      if (!tool) {
        const text = lastUserText(req.messages);
        const choice = readChoice(text, req.candidates.length);
        if (choice !== null) {
          const c = req.candidates[choice];
          return call("place_hold", { menu_id: c.menuId, date: c.date, start: c.start });
        }
        if (/前と同じ|前回と同じ|いつもの/.test(text)) return call("previous_visit", {});
        const r = readRequest(ctx, text);
        if (!r.menuId) return say("ご希望のメニューを教えてください。", onText);
        if (r.date && r.start) return call("check_rules", { menu_id: r.menuId, date: r.date, start: r.start });
        return call("find_openings", { menu_id: r.menuId, ...(r.date ? { date: r.date } : {}) });
      }

      const d = tool.data;
      const list = (Array.isArray(d.candidates) ? d.candidates : []) as Listed[];
      const pick = "よろしければ「1つ目で」のようにお返事ください。";
      switch (tool.name) {
        case "previous_visit":
          if (d.found && typeof d.menu_id === "string") return call("find_openings", { menu_id: d.menu_id });
          return say("前回の記録が見つかりませんでした。ご希望のメニューを教えてください。", onText);
        case "find_openings":
          if (list.length === 0) return say("あいにく空きが見つかりませんでした。別の日をお知らせください。", onText);
          return say(`${d.menu}は、${listText(list)} が空いています。${pick}`, onText);
        case "check_rules":
          if (d.ok) return say(`${listText(list)} でお取りできます。${pick}`, onText);
          return say(
            `${d.reason}${list.length ? `代わりに、${listText(list)} はいかがでしょう。${pick}` : "別の日をお知らせください。"}`,
            onText,
          );
        case "place_hold":
          if (d.ok) return say(`${d.held} を仮でお取りしました。お店から確定のご連絡をします。`, onText);
          if (d.reason)
            return say(`${d.reason}${list.length ? `代わりに、${listText(list)} はいかがでしょう。${pick}` : ""}`, onText);
          return say("お店に確かめてから、ご連絡します。", onText);
      }
    },
  };
}
