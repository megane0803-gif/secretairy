// 発信のチームの会議を開く入口（窓口と、つながらない時の画面が使う）。
// 「決まった返事（AI なし）」を選んだ時と、AI につながらない時（鍵が無い・止まっている・途中でつながらなくなった）は、
// Claude の答えはまぜずに、決まった返事の声で最後まで開く。どちらも4つの声を出す（画面には「AI なし」と出す）。

import { NoAiError } from "../../ai/model";
import type { PostsMode } from "../wire";
import { runPostTeam, type PostTeamInput, type PostTeamRunLimits, type PostTeamWriter } from "./run";
import { scriptPostTeamWriter } from "./script";
import type { PostTeamResult } from "./types";

export async function meetPost(
  input: PostTeamInput,
  mode: PostsMode,
  makeClaude: () => PostTeamWriter,
  limits: PostTeamRunLimits,
): Promise<PostTeamResult | null> {
  if (mode === "script") return runPostTeam(input, scriptPostTeamWriter(limits), limits, "script");
  try {
    return await runPostTeam(input, makeClaude(), limits, "ai");
  } catch (e) {
    if (!(e instanceof NoAiError)) throw e;
    return runPostTeam(input, scriptPostTeamWriter(limits), limits, "script", true);
  }
}
