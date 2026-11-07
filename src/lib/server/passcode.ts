// 合言葉の比べ方（サーバーの側）。試験10問（src/lib/eval/passcode.ts）と、広告のテスト用アカウントのオーナー用の合言葉
// （src/lib/ads/live/server.ts）が、どちらもここを通す（2つ作らない）。
//   - 比べるのはハッシュどうし（timingSafeEqual。長さで漏れないように）
//   - 打った合言葉の長さに上限（maxChars。こえたら "wrong"）
//   - 設定が無い・空（と、minChars があればそれより短い）なら、何を打っても通らない（"no-passcode"）
// 合言葉の中身は、返事・ログ・日誌に出さない。

import { createHash, timingSafeEqual } from "node:crypto";

export type PasscodeCheck = "ok" | "wrong" | "no-passcode";

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** 設定の合言葉が使える長さか（空・短すぎるなら false） */
export function passcodeUsable(configured: string | undefined | null, minChars = 1): boolean {
  return !!configured && !!configured.trim() && [...configured].length >= Math.max(1, minChars);
}

export function checkPasscode(given: unknown, configured: string | undefined | null, p: { maxChars: number; minChars?: number }): PasscodeCheck {
  if (!passcodeUsable(configured, p.minChars)) return "no-passcode";
  if (typeof given !== "string" || !given || [...given].length > p.maxChars) return "wrong";
  return timingSafeEqual(digest(given), digest(configured as string)) ? "ok" : "wrong";
}
