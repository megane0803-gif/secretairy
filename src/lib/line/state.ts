// LINE のつなぎの、このブラウザの中に残す物（docs/SPEC.md §5.1。サーバーには送らない物も含む）。
// 持つのは「その画面だけが持つ印（token）」「合言葉と期限」「つながっている期限」「届けた・受け取った物の id」だけ。
// LINE の人の番号・鍵は持たない（サーバーも画面に渡さない）。印は画面・日誌に出さない。

export type LineMode = "ai" | "script";

export type LineState = {
  v: 1;
  token: string;
  /** 画面に出す合言葉（つながったら消す） */
  code?: string;
  codeExpiresAt?: string;
  linked: boolean;
  /** つながっている期限（ISO） */
  until?: string;
  /** LINE に届けた（届けないと決めた）承認待ちの行の id */
  notified: string[];
  /** 受け取って済ませた LINE の知らせの id（同じ物を2回使わない） */
  handled: string[];
  /** 振り分け：AI か決まった返事（AI なし） */
  mode: LineMode;
};

const KEEP = 200;
const isStr = (x: unknown): x is string => typeof x === "string";

export function parseLine(raw: string | null): LineState | null {
  if (!raw) return null;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!d || typeof d !== "object" || !isStr(d.token) || !d.token) return null;
  const list = (x: unknown) => (Array.isArray(x) ? x.filter(isStr).slice(-KEEP) : []);
  return {
    v: 1,
    token: d.token,
    ...(isStr(d.code) && /^\d{6}$/.test(d.code) ? { code: d.code } : {}),
    ...(isStr(d.codeExpiresAt) ? { codeExpiresAt: d.codeExpiresAt } : {}),
    linked: d.linked === true,
    ...(isStr(d.until) ? { until: d.until } : {}),
    notified: list(d.notified),
    handled: list(d.handled),
    mode: d.mode === "script" ? "script" : "ai",
  };
}

export function newLineState(token: string, code: string, codeExpiresAt: string, mode: LineMode = "ai"): LineState {
  return { v: 1, token, code, codeExpiresAt, linked: false, notified: [], handled: [], mode };
}

/** つながった（合言葉は消す）。いまある承認待ちは「届けた」ことにする（新しく入った行だけ届ける） */
export function withLinked(s: LineState, until: string | undefined, pendingIds: string[]): LineState {
  const { code: _c, codeExpiresAt: _e, ...rest } = s;
  return { ...rest, linked: true, ...(until ? { until } : {}), notified: [...new Set([...s.notified, ...pendingIds])].slice(-KEEP) };
}

export function withNotified(s: LineState, ids: string[]): LineState {
  return { ...s, notified: [...new Set([...s.notified, ...ids])].slice(-KEEP) };
}

export function withHandled(s: LineState, id: string): LineState {
  return s.handled.includes(id) ? s : { ...s, handled: [...s.handled, id].slice(-KEEP) };
}

/** 合言葉の期限が過ぎたか（まだつながっていないとき） */
export function codeExpired(s: LineState, nowIso: string): boolean {
  return !s.linked && (!s.codeExpiresAt || s.codeExpiresAt <= nowIso);
}

/** つながりの期限が過ぎたか */
export function linkExpired(s: LineState, nowIso: string): boolean {
  return s.linked && !!s.until && s.until <= nowIso;
}
