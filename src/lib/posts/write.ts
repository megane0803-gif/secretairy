// 発信の下書きの流れ（サーバーの側で動く。受け取った物は残さない）。種類が違っても流れは1本。
//   AI（か決まった返事）が下書きを1つ → 言葉の門（gate.ts）
//   → 当たったら理由を渡して1回だけ作り直す → 2回とも当たったら下書きは返さない（画面と日誌に「作れませんでした」）。
// 日時・数字はここでは入れない（画面が台帳と設定から入れる。facts.ts）。保存はオーナーのボタンだけ。

import type { PostMemo } from "../data/types";
import type { JournalWho } from "../journal";
import type { Rule } from "../rules/types";
import type { PostKind } from "../settings";
import { gatePost, type PostGateCheck } from "./gate";
import type { PostsMessage, PostsModel } from "./model";
import { postsSystem, postsUserText } from "./prompt";

/** 日誌に書く1行（書くのは画面の側） */
export type PostStep = { who: JournalWho; text: string };

export type WriteInput = {
  kind: PostKind;
  materials: Record<string, string>;
  memos: PostMemo[];
  rules: Rule[];
  shopName: string;
  gateWords: string[];
  model: PostsModel;
  maxTokens: number;
  /** 下書きを作らせる回数の上限（config/ai.json の posts.maxTries。1回目＋作り直し） */
  maxTries: number;
  menuName?: (id: string) => string;
};

export type WriteResult =
  | { ok: true; text: string; checks: PostGateCheck[]; tries: number; cut: boolean; steps: PostStep[] }
  | { ok: false; checks: PostGateCheck[]; problems: string[]; tries: number; steps: PostStep[] };

/** 画面と日誌に出す、作れなかったときの言葉 */
export const COULD_NOT_WRITE = "作れませんでした";

export async function runWrite(input: WriteInput): Promise<WriteResult> {
  const { kind, model } = input;
  const system = postsSystem(input.rules, kind, input.shopName, input.gateWords, input.menuName);
  const messages: PostsMessage[] = [{ role: "user", content: postsUserText(kind, input.materials, input.memos) }];
  const tries = Math.max(1, input.maxTries);
  const steps: PostStep[] = [];
  let checks: PostGateCheck[] = [];
  let problems: string[] = [];
  let i = 0;

  for (i = 1; i <= tries; i++) {
    const turn = await model.turn({ system, messages, maxTokens: input.maxTokens });
    if (turn.stop === "refusal") {
      steps.push({ who: "プログラム", text: `${kind.label}の下書きを${COULD_NOT_WRITE}（AI が答えなかった。保存していない）` });
      return { ok: false, checks, problems: ["AI が答えませんでした"], tries: i, steps };
    }
    steps.push({ who: "AI", text: `${kind.label}の下書きを作った${i > 1 ? `（作り直し${i - 1}回目）` : ""}（${[...turn.text].length}字）` });
    const g = gatePost(turn.text, input.gateWords);
    checks = g.checks;
    problems = g.problems;
    if (g.ok) {
      steps.push({ who: "プログラム", text: `言葉の門を通した：${g.checks.map((c) => `✓ ${c.label}`).join("・")}` });
      return { ok: true, text: turn.text, checks: g.checks, tries: i, cut: turn.stop === "max_tokens", steps };
    }
    const more = i < tries;
    steps.push({ who: "プログラム", text: `言葉の門で弾いた：${g.problems.join("。")}${more ? "（理由を渡して作り直しを頼んだ）" : ""}` });
    if (!more) break;
    messages.push({ role: "assistant", content: turn.text || "（下書きなし）" });
    messages.push({
      role: "user",
      content: `お店の言葉の門で弾きました：${g.problems.join("。")}。この理由に従って、同じ材料で下書きを1つだけ書きなおしてください。`,
    });
  }

  steps.push({ who: "プログラム", text: `${kind.label}の下書きを${COULD_NOT_WRITE}（言葉の門に${Math.min(i, tries)}回当たった。保存していない）` });
  return { ok: false, checks, problems, tries: Math.min(i, tries), steps };
}
