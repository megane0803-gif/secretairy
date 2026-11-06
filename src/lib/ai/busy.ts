// AI の窓口（/api/ai/ の下）が混んでいる時（HTTP 429。Vercel の Firewall で1分10回まで）と、
// 返事に理由の文が無い・読めない時の、画面に出す文。AI の窓口を呼ぶ画面はみなここを通す（決まった返事（AI なし）も同じ窓口なので同じ扱い）。
// 入力と作りかけの案は消さない（ここは文を決めるだけ）。

/** 混んでいる時の1文（「今は AI につながりません」とは分ける：待てば戻る） */
export const AI_BUSY_MESSAGE = "いま AI の窓口が混んでいます。1分ほど待ってから、もう一度押してください。";

/** 理由の文が無い・読めない時の1文（「undefined」などを出さない） */
export const AI_FAILED_MESSAGE = "うまくいきませんでした。もう一度押してください。";

/** 混んでいる（429）か */
export function isBusyStatus(status: number): boolean {
  return status === 429;
}

/** 返事の理由の文（message）。文字で、中身がある時だけ（終わりの「。」は外す）。無い・読めない時は null */
export function reasonOf(x: unknown): string | null {
  if (!x || typeof x !== "object") return null;
  const m = (x as { message?: unknown }).message;
  if (typeof m !== "string") return null;
  const t = m.replace(/\s+/g, " ").trim().replace(/[。.]+$/, "");
  if (!t || t === "undefined" || t === "null") return null;
  return t.slice(0, 200);
}

/** 「うまくいきませんでした。理由。続き」。理由が無ければ決まった1文（続きは付けない） */
export function failText(reason: string | null | undefined, tail = "", fallback: string = AI_FAILED_MESSAGE): string {
  const r = typeof reason === "string" ? reasonOf({ message: reason }) : null;
  return r ? `うまくいきませんでした。${r}。${tail}` : fallback;
}

/** 画面から AI の窓口を呼んだ結果。busy = 混んでいる（429）/ down = つながらない（通信が失敗）/ answer = 返事（JSON。読めなければ null） */
export type AiCall = { kind: "busy" } | { kind: "down" } | { kind: "answer"; status: number; data: unknown };

/** 画面から AI の窓口に POST する（JSON の返事の物）。例外は投げない */
export async function postAi(path: string, body: unknown, init: { signal?: AbortSignal } = {}): Promise<AiCall> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...(init.signal ? { signal: init.signal } : {}) });
  } catch {
    return { kind: "down" };
  }
  if (isBusyStatus(res.status)) return { kind: "busy" };
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { kind: "answer", status: res.status, data };
}
