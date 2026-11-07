// 試験10問（/eval）の合言葉（サーバーの側）。環境変数 EVAL_PASSCODE が無ければ試験は動かない。
// 合言葉の中身は、画面・答えの表・日誌・ログ・README に出さない。比べるのはハッシュどうし（長さで漏れないように）。

import { execFileSync } from "node:child_process";
import { checkPasscode, type PasscodeCheck } from "../server/passcode";
import { getAiSettings, getPostsAiSettings } from "../settings";

export type { PasscodeCheck };

/** 合言葉を比べる。設定（EVAL_PASSCODE）が無い・空なら、何を打っても動かない。比べ方は共通（src/lib/server/passcode.ts） */
export function checkEvalPasscode(given: unknown, configured: string | undefined, maxChars: number): PasscodeCheck {
  return checkPasscode(given, configured, { maxChars });
}

/** 表の上に出す：いまのコミットと、窓口が使うモデル（設定。環境変数で差しかえた分も） */
export type EvalMeta = { commit: string; models: { reserve: string; karte: string; posts: string } };

export function evalMeta(env: Record<string, string | undefined> = process.env): EvalMeta {
  let commit = env.VERCEL_GIT_COMMIT_SHA ?? "";
  if (!commit) {
    try {
      commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      commit = "";
    }
  }
  const ai = getAiSettings();
  return {
    commit: commit ? commit.slice(0, 12) : "わからない",
    models: { reserve: ai.model, karte: ai.karte.model, posts: getPostsAiSettings().model },
  };
}
