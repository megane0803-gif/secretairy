// 広告の見直しの窓口（/api/ai/ads）の中身（サーバーの側。受け取った物は残さない）。
//   止める・外すの見直し（review.ts。今と同じ）→ そのあと別に1回だけ足す案（addPick.ts。直す時は作らない）。
// 窓口とテスト（ホームの「AI の仕事」のテストも）が同じこれを通す。model を外から渡す（Claude か決まった返事）。

import { NoAiError } from "../ai/model";
import type { AdsAiSettings, AdSettings, Menu } from "../settings";
import type { AddPick } from "./add";
import { runAddPick } from "./addPick";
import { featuredWords } from "./featured";
import type { AdsModel } from "./model";
import { runReview } from "./review";
import type { AdsRequest, AdsResponse } from "./wire";

export type ServeAdsDeps = {
  /** 止める・外すと足すの両方で使う（決まった返事の時の足す案は、model を使わずプログラムが選ぶ） */
  model: AdsModel;
  menus: readonly Pick<Menu, "id" | "name">[];
  settings: AdSettings;
  ai: Pick<AdsAiSettings, "maxReplyTokens" | "maxTries" | "maxAdds" | "maxAddCalls">;
  /** 足す案の途中でうまくいかなかった時の知らせ（窓口はログに出す） */
  onAddError?: (e: unknown) => void;
};

/** NoAiError（止める・外すの見直しで AI につながらない）は呼んだ側へ投げる。足す案だけがつながらない時は、足す案なしで返す */
export async function serveAds(req: AdsRequest, deps: ServeAdsDeps): Promise<Exclude<AdsResponse, { code: "no-ai" | "busy" | "bad-request" }>> {
  const { model, menus, settings, ai } = deps;
  const menuName = (id: string) => menus.find((m) => m.id === id)?.name ?? id;
  const r = await runReview({
    table: req.table,
    rules: req.rules,
    settings,
    menuName,
    fix: req.fix,
    model,
    maxTokens: ai.maxReplyTokens,
    maxTries: ai.maxTries,
  });
  // 足す案（止める・外すの結果に関係なく、別の1回。直す時は作らない）
  let adds: AddPick | undefined;
  if (!req.fix) {
    try {
      adds = await runAddPick({
        table: req.table,
        words: featuredWords(settings, menus),
        rules: req.rules,
        settings,
        menuName,
        model: req.mode === "script" ? null : model,
        maxTokens: ai.maxReplyTokens,
        maxAdds: ai.maxAdds,
        maxCalls: ai.maxAddCalls,
        ...(r.ok && r.proposal.action === "exclude" ? { skipNo: r.proposal.no } : {}),
      });
    } catch (e) {
      if (!(e instanceof NoAiError)) deps.onAddError?.(e);
      adds = { picks: [], steps: [{ who: "プログラム", text: "足す案は AI につながらなかったので出さなかった" }] };
    }
  }
  const extra = adds ? { adds } : {};
  return r.ok ? { ...r, ...extra } : { ...r, code: "gate" as const, ...extra };
}
