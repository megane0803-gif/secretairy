// 足す案の流れ（サーバーの側で動く。受け取った物は残さない。docs/SPEC.md §1.7.5）。
//   止める・外すの見直し（review.ts）の後に、別に1回だけ：プログラムが候補を作る（add.ts）→ AI が候補の番号から選ぶ
//   → 候補に無い番号・同じ番号・上限をこえた物・理由が門を通らない物はプログラムが外し、日誌に「断った」と1行。作り直しは頼まない。
//   止める・外すの結果（門を通ったか）には関係なく動く。候補が無ければ AI は呼ばない。
// 決まった返事（AI なし）の時は、AI を使わず、プログラムが同じ候補から予約の多い順に上限まで出す。
// ここでは何も変えない。足すのは、オーナーが承認の箱で「承認」を押したときだけ。

import type { ToolCall } from "../ai/model";
import type { Rule } from "../rules/types";
import type { AdSettings } from "../settings";
import { addCandidates, type AddPick, type GatedAdd } from "./add";
import type { AdsModel } from "./model";
import { adsAddSystem, adsAddUserText } from "./prompt";
import type { ReviewStep } from "./review";
import { AD_ADD_TOOL, AD_ADD_TOOL_DEF } from "./tools";
import { gateAdSentence } from "./words";

/** 決まった返事（AI なし）の理由の1文（数字なし・言葉の門を通る） */
export const SCRIPT_ADD_REASON = "売りのメニューの言葉で調べた方が、予約につながっています。";

export type AddPickInput = {
  table: Parameters<typeof addCandidates>[0];
  /** 売りの言葉（featured.ts の featuredWords） */
  words: readonly string[];
  rules: Rule[];
  settings: Pick<AdSettings, "channel" | "gateWords">;
  menuName?: (id: string) => string;
  /** null = 決まった返事（AI なし） */
  model: AdsModel | null;
  maxTokens: number;
  /** 1回の見直しで出す足す案の数の上限（config/ai.json の ads.maxAdds） */
  maxAdds: number;
  /** 足す案で AI を呼ぶ回数の上限（config/ai.json の ads.maxAddCalls。0 なら AI は呼ばない） */
  maxCalls: number;
  /** 同じ見直しで外す案にした調べ言葉（候補にしない） */
  skipNo?: number;
};

export async function runAddPick(input: AddPickInput): Promise<AddPick> {
  const { table, words, maxAdds } = input;
  const candidates = addCandidates(table, words, { skipNo: input.skipNo });
  const steps: ReviewStep[] = [];
  if (candidates.length === 0 || maxAdds <= 0) {
    steps.push({ who: "プログラム", text: "足す候補（売りの言葉が入って予約につながった調べ言葉）は無かったので、足す案は出さなかった" });
    return { picks: [], steps };
  }
  steps.push({ who: "プログラム", text: `足す候補を選んだ：${candidates.map((c) => `${c.no}番「${c.text}」`).join("・")}` });

  // 決まった返事（AI なし）：同じ候補から予約の多い順に上限まで
  if (!input.model || input.maxCalls <= 0) {
    const picks: GatedAdd[] = candidates.slice(0, maxAdds).map((c) => ({ no: c.no, text: c.text, reason: SCRIPT_ADD_REASON }));
    steps.push({ who: "プログラム", text: `足す案を出した（決まった返事・予約の多い順）：${picks.map((p) => `${p.no}番`).join("・")}` });
    return { picks, steps };
  }

  const turn = await input.model.turn({
    system: adsAddSystem(input.rules, input.settings, input.menuName ?? ((id) => id), words, maxAdds),
    messages: [{ role: "user", content: adsAddUserText(candidates, maxAdds) }],
    tools: [AD_ADD_TOOL_DEF],
    maxTokens: input.maxTokens,
    parallel: true,
  });
  if (turn.stop === "refusal") {
    steps.push({ who: "プログラム", text: "AI が答えなかったので、足す案は出さなかった" });
    return { picks: [], steps };
  }
  const picks: GatedAdd[] = [];
  for (const call of turn.toolCalls) {
    const why = refuseWhy(call, candidates, picks, maxAdds, input.settings.gateWords);
    if (typeof why === "string") {
      steps.push({ who: "プログラム", text: `断った：${why}（足す案には入れなかった）` });
      continue;
    }
    picks.push(why);
  }
  steps.push({
    who: "AI",
    text: picks.length ? `足す案を選んだ：${picks.map((p) => `${p.no}番「${p.text}」`).join("・")}` : "足す案は選ばなかった",
  });
  return { picks, steps };
}

/** 1つの呼び出しを確かめる。通れば足す案、だめなら断る理由 */
function refuseWhy(call: ToolCall, candidates: ReturnType<typeof addCandidates>, picks: GatedAdd[], maxAdds: number, gateWords: string[]): GatedAdd | string {
  const input = call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : {};
  const no = typeof input.no === "number" ? input.no : typeof input.no === "string" && /^\d+$/.test(input.no) ? Number(input.no) : NaN;
  const label = Number.isInteger(no) ? `${no}番` : `番号の無い案`;
  if (call.name !== AD_ADD_TOOL) return `${label}：「足す」のほかの道具（${call.name}）は使えません`;
  const extra = Object.keys(input).filter((k) => k !== "no" && k !== "reason");
  if (extra.length) return `${label}：番号と理由のほかに（${extra.join("・")}）を付けています`;
  const c = candidates.find((x) => x.no === no);
  if (!c) return `AI が出した ${label}は足す候補にありません`;
  if (picks.some((p) => p.no === no)) return `${label}は2回出ました`;
  if (picks.length >= maxAdds) return `${label}：足す案は1回に${maxAdds}件までです`;
  const said = gateAdSentence(typeof input.reason === "string" ? input.reason : "", gateWords);
  if (!said.ok) return `${label}：理由の文が言葉の門を通りません（${said.problems.join("。")}）`;
  return { no: c.no, text: c.text, reason: said.text };
}
