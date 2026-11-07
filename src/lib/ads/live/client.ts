// 画面から広告のテスト用アカウントの窓口（/api/ads/live/）を呼ぶ形（ブラウザの側）。鍵・番号は持たない・送らない。
// 合言葉は押すたびに画面で入れた物をそのまま送るだけ（ブラウザに残さない）。
// 通信が切れて返事が届かなかった時は「分からない（読み直してください）」にする（「できなかった」と言わない）。

import type { AdsState } from "../state";
import type { SyncPayload } from "../connect";
import { LIVE_PATHS, type LiveFail, type LiveReadResponse, type LiveSendResponse, type LiveSetupResponse, type LiveStatusResponse } from "./wire";

export const LOST_MESSAGE = "返事が届きませんでした。送れたか分かりません（読み直してください）";

async function call<T extends { ok: boolean }>(path: string, init: RequestInit): Promise<T | LiveFail> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin" });
  } catch {
    return { ok: false, code: "lost", message: LOST_MESSAGE };
  }
  try {
    const j = (await res.json()) as T | LiveFail;
    if (j && typeof j === "object" && typeof j.ok === "boolean") {
      if (!j.ok && !(j as LiveFail).message) return { ok: false, code: "failed", message: "うまくいきませんでした" };
      return j;
    }
  } catch {
    // 下へ
  }
  return { ok: false, code: "lost", message: LOST_MESSAGE };
}

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const liveStatus = () => call<LiveStatusResponse>(LIVE_PATHS.status, { method: "GET" });
export const liveSetup = (passcode: string) => call<LiveSetupResponse>(LIVE_PATHS.setup, post({ passcode }));
export const liveSend = (passcode: string, payload: SyncPayload) => call<LiveSendResponse>(LIVE_PATHS.send, post({ passcode, payload }));
export const liveRead = () => call<LiveReadResponse>(LIVE_PATHS.read, post({}));

const OUTCOME_LABEL = { done: "反映した", already: "", failed: "できなかった", unknown: "分からない（読み直してください）" } as const;

/** 送った案ごとの1行（反映した／もう〜だった／できなかった（理由）／分からない） */
export function outcomeText(l: { outcome: keyof typeof OUTCOME_LABEL; reason?: string; text: string }): string {
  const head = l.outcome === "already" ? (l.reason ?? "もう反映されていた") : l.outcome === "failed" ? `できなかった（${l.reason ?? "理由は分かりません"}）` : OUTCOME_LABEL[l.outcome];
  return `「${l.text}」：${head}`;
}

const sameWords = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * 読み直しの一覧は、ブラウザの印よりも正しい物として扱う：「本物に反映済み」の印があるのに、一覧ではそうなっていない言葉を出す。
 */
export function driftOf(s: AdsState, read: Extract<LiveReadResponse, { ok: true }>, adGroup: string): string[] {
  const out: string[] = [];
  for (const p of s.proposals) {
    if (!p.realAt) continue;
    if (p.action === "stop" && !read.keywords.some((k) => sameWords(k.text, p.text) && k.status === "止めている"))
      out.push(`「${p.text}」は印がありますが、読み直すと止まっていません`);
    if (p.action === "exclude" && !read.negatives.some((n) => sameWords(n.text, p.text) && n.match === "完全一致"))
      out.push(`「${p.text}」は印がありますが、読み直すと外していません`);
  }
  for (const p of s.adds ?? []) {
    if (!p.realAt) continue;
    if (!read.keywords.some((k) => sameWords(k.text, p.text) && k.match === "フレーズ一致" && k.group === adGroup))
      out.push(`「${p.text}」は印がありますが、読み直すと足していません`);
  }
  return out;
}
