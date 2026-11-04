// 決まった返事（AI なし）。テストで Claude の代わりに使う。AI につながらないときの「お試し」にも使う。
// 表の数だけを見て、いちばん「お金がかかって予約につながっていない」言葉を選ぶ（町の名前のことは知らない）。
// なので1回目は町の名前入りの言葉を外す案を出すことがあり、そのときは門が弾いて、作り直しで別の案になる。
// 直すときは、オーナーの一言の「N番を止めて／外して」を読む。

import type Anthropic from "@anthropic-ai/sdk";
import type { ToolCall } from "../ai/model";
import type { AdsModel, AdsModelRequest, AdsTurn } from "./model";
import { allRows, totalOf, type AdTable, type AdTableRow } from "./report";
import type { AdToolName } from "./tools";

function normalize(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** これまでに出した案の番号（作り直しで同じ物を出さない） */
function triedNos(messages: Anthropic.Beta.BetaMessageParam[]): Set<number> {
  const out = new Set<number>();
  for (const m of messages)
    if (m.role === "assistant" && Array.isArray(m.content))
      for (const b of m.content)
        if (b.type === "tool_use" && b.input && typeof b.input === "object") {
          const no = (b.input as Record<string, unknown>).no;
          if (typeof no === "number") out.add(no);
        }
  return out;
}

/** オーナーの一言（「3番を止めて」など）を読む */
export function readFix(text: string): { no: number; tool: AdToolName | null } | null {
  const t = normalize(text);
  const m = t.match(/(\d{1,3})\s*番/);
  if (!m) return null;
  const tool: AdToolName | null = /止め|とめ/.test(t) ? "stop_keyword" : /外|はず/.test(t) ? "exclude_term" : null;
  return { no: Number(m[1]), tool };
}

/** お金がかかって予約につながっていない順（予約1件あたりのお金が多い順） */
function waste(r: AdTableRow): number {
  const s = totalOf(r);
  return s.cost / (s.bookings + 1);
}

export function scriptAdsModel(table: AdTable): AdsModel {
  let n = 0;
  const call = (name: AdToolName, no: number, reason: string): AdsTurn => {
    n += 1;
    const c: ToolCall = { id: `ads-script-${n}`, name, input: { no, reason } };
    return { assistant: [{ type: "tool_use", id: c.id, name, input: c.input }], toolCalls: [c], stop: "tool" };
  };
  const reasonFor = (r: AdTableRow) =>
    totalOf(r).bookings === 0
      ? r.kind === "term"
        ? "この言葉で調べた方からは予約が入っておらず、お金だけかかっています。"
        : "押されてお金はかかっていますが、予約につながっていません。"
      : "ほかの言葉より、予約あたりのお金が多くかかっています。";

  return {
    async turn(req: AdsModelRequest) {
      const first = req.messages[0];
      const text = first && typeof first.content === "string" ? first.content : "";
      const tried = triedNos(req.messages);

      // 直す：オーナーの一言を読む
      const fixLine = text.match(/オーナーの一言：「([^」]*)」/);
      if (fixLine && tried.size === 0) {
        const f = readFix(fixLine[1]);
        if (f) {
          const row = allRows(table).find((r) => r.no === f.no);
          const tool = f.tool ?? (row?.kind === "term" ? "exclude_term" : "stop_keyword");
          return call(tool, f.no, "オーナーの一言に合わせて出しなおしました。");
        }
      }

      // 調べた言葉で予約が0件の物を外す → 無ければ広告を出す言葉を止める（売りは止めない）
      const terms = table.searchTerms.filter((r) => !r.off && !tried.has(r.no) && totalOf(r).bookings === 0).sort((a, b) => waste(b) - waste(a));
      if (terms[0]) return call("exclude_term", terms[0].no, reasonFor(terms[0]));
      const kws = table.keywords.filter((r) => !r.off && !r.featured && !tried.has(r.no)).sort((a, b) => waste(b) - waste(a));
      if (kws[0]) return call("stop_keyword", kws[0].no, reasonFor(kws[0]));
      const text0 = "いまは止める・外す言葉が見つかりませんでした。";
      return { assistant: [{ type: "text", text: text0 }], toolCalls: [], stop: "end" };
    },
  };
}
