// 返事を作る物（Claude か、決まった返事か）の形。相談の流れ（agent.ts）はどちらでも同じに動く。
// テストでは Claude を呼ばず、決まった返事（script.ts）に置きかえる。

import type Anthropic from "@anthropic-ai/sdk";
import type { ToolDef } from "./tools";
import type { Candidate } from "./wire";

export type ToolCall = { id: string; name: string; input: unknown };

export type ModelRequest = {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: ToolDef[];
  /** 1回の返事の長さの上限（トークン） */
  maxTokens: number;
  /** 直前にお客様へ出した候補（決まった返事が「1つ目で」を読むのに使う。Claude には system に書いてある） */
  candidates: Candidate[];
};

export type ModelTurn = {
  /** 会話に積む、その返事の中身（Claude の返事はそのまま積む） */
  assistant: Anthropic.Beta.BetaContentBlockParam[];
  toolCalls: ToolCall[];
  stop: "end" | "tool" | "max_tokens" | "refusal";
};

export interface ReplyModel {
  /** 1回分の返事。文は少しずつ onText に流す */
  turn(req: ModelRequest, onText: (delta: string) => void): Promise<ModelTurn>;
}

/** AI につながらない（鍵が無い・クレジットが無い・止まっている など）。画面には「今は AI につながりません」と出す */
export class NoAiError extends Error {}
