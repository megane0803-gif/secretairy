// カルテ自動作成の、画面とサーバー（/api/ai/karte）のあいだの形。
// サーバーは受け取った物を残さない。下書き（言葉の門を通した物）を返すだけ。

import type { Rule } from "../rules/types";
import type { KarteSections } from "./format";
import type { GateRemoved } from "./gate";

/** ai = Claude（Haiku）に聞く / script = 決まった返事（AI なし） */
export type KarteMode = "ai" | "script";

export type KarteRequest = {
  mode: KarteMode;
  /** 施術のメモ（1,500字まで。お客様の名前は送らない） */
  memo: string;
  /** そのブラウザのルール（鍵つきはサーバーで先頭に足しなおす） */
  rules: Rule[];
};

export type KarteDraft = {
  mode: KarteMode;
  /** 言葉の門を通った行（見出しの id ごと） */
  sections: KarteSections;
  /** 言葉の門で外した行 */
  removed: GateRemoved[];
  /** 長さの上限で途中まで */
  cut: boolean;
};

export type KarteResponse =
  | ({ ok: true } & KarteDraft)
  | { ok: false; code: "no-ai" | "bad-request" | "refused"; message: string };
