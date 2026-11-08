// 来た人の画面から /api/freee/try を呼ぶ形（ブラウザの側。画面とテストが同じ物を使う）。AI は使わない。
// 送るのは「明細の番号」と「店用か私用か」だけ。結果が分からない時は自動で呼び直さない。
// 登録できた時は、続けて1回だけ読み直し、試した明細が freee で「登録した」になったのを確かめてから知らせる。

import type { CardUse } from "../data/types";
import { readList, type FreeeList, type Post } from "./run";

export const TRY_PATH = "/api/freee/try";

export type TryItemState = "registered" | "open" | "other";
export type TryPhase = "free" | "holding" | "restoring" | "repair";

export type TryInfo = {
  phase: TryPhase;
  minutes: number;
  mine: boolean;
  items: { id: number; use: CardUse; state: TryItemState }[];
  holdMinutes: number;
  maxItems: number;
};

export type TryRead =
  | { kind: "ok"; list: FreeeList; info: TryInfo }
  /** つながっていない（オーナーがつなぎ直す）。1行だけ出して、アプリの中の明細のまま */
  | { kind: "not-connected"; message: string }
  /** 本番のサイトではない（何も出さない） */
  | { kind: "off" }
  /** 読めなかった（理由の1行。架空の明細には切り替えない） */
  | { kind: "error"; message: string };

const isInt = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const PHASES = new Set<TryPhase>(["free", "holding", "restoring", "repair"]);
const messageOf = (b: unknown, fallback: string) => {
  const m = (b as { message?: unknown } | null)?.message;
  return typeof m === "string" && m ? m.slice(0, 200) : fallback;
};

export function readTryInfo(x: unknown): TryInfo | null {
  const t = x as Record<string, unknown> | null;
  if (!t || !PHASES.has(t.phase as TryPhase) || !isInt(t.minutes) || !isInt(t.holdMinutes) || !isInt(t.maxItems) || !Array.isArray(t.items)) return null;
  const items: TryInfo["items"] = [];
  for (const i of t.items as Record<string, unknown>[])
    if (i && isInt(i.id) && (i.use === "shop" || i.use === "private") && (i.state === "registered" || i.state === "open" || i.state === "other")) items.push({ id: i.id, use: i.use, state: i.state });
  return { phase: t.phase as TryPhase, minutes: t.minutes, mine: t.mine === true, items, holdMinutes: t.holdMinutes, maxItems: t.maxItems };
}

/** 読む（読み直す）の答えを読む */
export function readTryAnswer(status: number, body: unknown, nowIso: string): TryRead {
  const b = body as { ok?: unknown; code?: unknown; trial?: unknown } | null;
  if (status === 200 && b?.ok === true) {
    const list = readList(b, nowIso);
    const info = readTryInfo(b.trial);
    if (list && info) return { kind: "ok", list, info };
    return { kind: "error", message: "答えの形が違います" };
  }
  if (b?.code === "not-connected") return { kind: "not-connected", message: messageOf(b, "いまは経理につながっていません（オーナーがつなぎ直します）") };
  if (status === 404 || b?.code === "off") return { kind: "off" };
  return { kind: "error", message: messageOf(b, "読めませんでした") };
}

export async function tryRead(post: Post, nowIso: () => string): Promise<TryRead> {
  try {
    const r = await post(TRY_PATH, { action: "read" });
    return readTryAnswer(r.status, r.body, nowIso());
  } catch {
    return { kind: "error", message: "サーバーにつながりませんでした" };
  }
}

export type TryRegisterOutcome = {
  /** registered：登録して、読み直して入ったのを確かめた / unconfirmed：登録したが、読み直しでまだ確かめられない */
  result: "registered" | "unconfirmed" | "refused" | "failed" | "unknown";
  message: string;
  /** 読み直した答え（読めた時） */
  read: TryRead | null;
};

export const TRY_REGISTERED_NOTE = "テスト用の事業所に登録しました。読み直して入ったのを確かめました";

/**
 * 1件を登録して、できたら1回だけ読み直す。結果が分からない時は呼び直さない（読み直しもしない）。
 * label：今どおりの言い方の頭（「登録した 1件（店用）」など）
 */
export async function tryRegister(post: Post, p: { id: number; use: CardUse; label: string }, nowIso: () => string): Promise<TryRegisterOutcome> {
  let r;
  try {
    // 送るのは番号と店用か私用かだけ
    r = await post(TRY_PATH, { action: "register", id: p.id, use: p.use });
  } catch {
    return { result: "unknown", message: "送った後に返事が途切れました。送り直しません。少し待ってから「読み直す」を押してください", read: null };
  }
  const b = r.body as { ok?: unknown; result?: unknown; reason?: unknown } | null;
  if (r.status >= 500 && r.status !== 503) return { result: "unknown", message: "送った後に返事が途切れました。送り直しません。少し待ってから「読み直す」を押してください", read: null };
  if (r.status !== 200 || b?.ok !== true) return { result: "failed", message: messageOf(b, "うまくいきませんでした"), read: null };
  const reason = messageOf(b, "");
  if (b.result === "unknown") return { result: "unknown", message: reason || "送った後に返事が途切れました。送り直しません", read: null };
  if (b.result === "refused") return { result: "refused", message: reason, read: null };
  if (b.result !== "registered") return { result: "failed", message: reason || "うまくいきませんでした", read: null };
  const again = await tryRead(post, nowIso);
  const confirmed = again.kind === "ok" && again.info.items.some((i) => i.id === p.id && i.state === "registered");
  if (confirmed) return { result: "registered", message: `${p.label}。${TRY_REGISTERED_NOTE}`, read: again };
  return { result: "unconfirmed", message: `${p.label}。テスト用の事業所に登録しました。読み直しでは、まだ入ったのを確かめられていません。少し待ってから「読み直す」を押してください`, read: again };
}

/**
 * 経理のタブを開いた時の読むを省くか（来た人の窓口の回数を、タブの行き来で使わないように）。
 * 省くのは、この画面で reuseSeconds 秒の中に読めたばかり（lastOkAt）の時だけ。「読み直す」と登録の後の読み直しは省かない。
 * 試しの様子が「元に戻しています」「要復旧」の時は省かない（元に戻すのは、次の呼び出しで動くため）。
 */
export function reuseOpenRead(lastOkAt: number | null, now: number, reuseSeconds: number, info: TryInfo | null): boolean {
  if (lastOkAt === null || !info || info.phase === "restoring" || info.phase === "repair") return false;
  return now >= lastOkAt && now - lastOkAt < reuseSeconds * 1000;
}

/** 試しの様子の1行（だれかが試している・元に戻している・試せない） */
export function phaseLine(info: TryInfo): string | null {
  if (info.phase === "repair") return "いまは試せません（オーナーが直します）";
  if (info.phase === "restoring") return "元に戻しています。少し待ってから「読み直す」を押してください";
  if (info.phase === "holding")
    return `${info.mine ? "いま試した物があります" : "ほかの人が試しています"}（あと ${info.minutes}分たった後に、次にだれかが経理のタブを開いた時に元に戻ります）`;
  return null;
}

/** 画面の1行（自動で戻ったとは書かない） */
export const restoreNote = (holdMinutes: number) => `試した物は、${holdMinutes}分たった後に、次にだれかが経理のタブを開いた時に元に戻ります`;
