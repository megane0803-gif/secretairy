// 会議を開く入口（窓口と、つながらない時の画面が使う）。
// 「決まった返事（AI なし）」を選んだ時と、AI につながらない時（鍵が無い・止まっている など）は、決まった返事の声で最後まで開く。
// どちらも4つの声を出す（画面には「AI なし」と出す）。

import { NoAiError } from "../../ai/model";
import type { AdsMode } from "../wire";
import { runTeam, type TeamInput, type TeamRunLimits, type TeamWriter } from "./run";
import { scriptTeamWriter } from "./script";
import type { TeamResult } from "./types";

export async function meet(input: TeamInput, mode: AdsMode, makeClaude: () => TeamWriter, limits: TeamRunLimits): Promise<TeamResult | null> {
  if (mode === "script") return runTeam(input, scriptTeamWriter(), limits, "script");
  try {
    return await runTeam(input, makeClaude(), limits, "ai");
  } catch (e) {
    if (!(e instanceof NoAiError)) throw e;
    // 途中でつながらなくなった時も、Claude の答えはまぜずに、決まった返事で開きなおす
    return runTeam(input, scriptTeamWriter(), limits, "script", true);
  }
}
