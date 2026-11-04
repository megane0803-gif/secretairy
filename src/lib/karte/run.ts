// カルテ自動作成の流れ：メモ → 書く物（Claude か決まった返事）→ 見出しに分ける → 言葉の門 → 下書き。
// サーバーの窓口（/api/ai/karte）とテストが同じここを使う。受け取った物はどこにも残さない。

import type { Rule } from "../rules/types";
import type { KarteHeading } from "../settings";
import { parseDraft } from "./format";
import { gateKarte } from "./gate";
import { karteSystem } from "./prompt";
import type { KarteDraft, KarteMode } from "./wire";
import type { KarteWriter } from "./writer";

export type RunKarteOptions = {
  memo: string;
  mode: KarteMode;
  writer: KarteWriter;
  headings: KarteHeading[];
  rules: Rule[];
  maxTokens: number;
  menuName?: (id: string) => string;
};

export class KarteRefusedError extends Error {}

export async function runKarte(o: RunKarteOptions): Promise<KarteDraft> {
  const out = await o.writer.write({ system: karteSystem(o.headings, o.rules, o.menuName), memo: o.memo, maxTokens: o.maxTokens });
  if (out.stop === "refusal") throw new KarteRefusedError("断られました");
  let text = out.text;
  const cut = out.stop === "max_tokens";
  // 長さの上限で切れたときは、最後の1行（途中で切れているかもしれない）を使わない
  if (cut) text = text.split(/\r?\n/).slice(0, -1).join("\n");
  const { sections } = parseDraft(text, o.headings);
  const gated = gateKarte(sections, o.memo, o.headings);
  return { mode: o.mode, sections: gated.sections, removed: gated.removed, cut };
}
