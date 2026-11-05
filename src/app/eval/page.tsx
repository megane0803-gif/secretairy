import type { Metadata } from "next";
import { getBookData } from "@/lib/book/data";
import { getPostMemos } from "@/lib/data/seed";
import { getEvalSettings, getKarteHeadings, getPostsSettings } from "@/lib/settings";
import { EvalBoard } from "./EvalBoard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "試験10問 | SecretAIry",
  robots: { index: false, follow: false },
};

/**
 * 試験10問（docs/SPEC.md §1.13）。左のタブ（メニュー）には出さない。URL（/eval）を直接開く。
 * 合言葉（環境変数 EVAL_PASSCODE。無ければ試験は動かない）を打ってから、ボタン1つで、今の /api/ai/ の窓口に10問を1問ずつ流し、合否と答えを表で出す。判定はプログラム（AI は使わない）。
 * 結果はこの画面の表だけ（どこにも送らない・残さない）。
 */
export default function EvalPage() {
  const ev = getEvalSettings();
  return (
    <EvalBoard
      data={getBookData()}
      memos={getPostMemos()}
      postGateWords={getPostsSettings().gateWords}
      intervalSeconds={ev.minIntervalSeconds}
      maxCalls={ev.maxCallsPerRun}
      maxPasscodeChars={ev.maxPasscodeChars}
      karteLabels={Object.fromEntries(getKarteHeadings().map((h) => [h.id, h.label]))}
    />
  );
}
