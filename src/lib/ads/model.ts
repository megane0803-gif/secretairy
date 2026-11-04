// 広告の見直しで案を作る物（Claude か、決まった返事か）の形。流れ（review.ts）はどちらでも同じに動く。
// テストでは Claude を呼ばず、決まった返事（script.ts）や、決まった案を返す物に置きかえる。

import type Anthropic from "@anthropic-ai/sdk";
import type { ToolCall } from "../ai/model";
import type { AdToolDef } from "./tools";

export type AdsModelRequest = {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: AdToolDef[];
  /** 1回の返事の長さの上限（トークン。config/ai.json の ads.maxReplyTokens） */
  maxTokens: number;
};

export type AdsTurn = {
  /** 会話に積む、その返事の中身 */
  assistant: Anthropic.Beta.BetaContentBlockParam[];
  toolCalls: ToolCall[];
  stop: "end" | "tool" | "max_tokens" | "refusal";
};

export interface AdsModel {
  turn(req: AdsModelRequest): Promise<AdsTurn>;
}
