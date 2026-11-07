// freee（テスト事業所）の記録を、見ている人のブラウザの中だけに残す形（docs/SPEC.md §1.8.1）。
// 画面の中の会計の記録（accounting/state.ts の secretairy:accounting）とは分けて持つ（secretairy:freee）。
// ここは形と変え方だけ（どこにも書かない）。
//
// 明細ごとの状態：まだ・送っている・登録した・もう処理済み・失敗・結果が分からない。
// 明細の鍵は freee の明細の番号（wallet_txn の id）で "t<id>"。架空の明細の番号（item.no）とは混ぜない（前の形の数だけの鍵は読まない）。
// 送り始めたら、その明細の店用／私用の選び（uses）を固定する。送っている間は、登録のし直しと「最初に戻す」を止める。

import { isTxnKey } from "../accounting/rows";
import type { CardUse } from "../data/types";

export type FreeeItemState = "pending" | "sending" | "registered" | "already" | "failed" | "unknown";

export const FREEE_STATE_LABEL: Record<FreeeItemState, string> = {
  pending: "まだ",
  sending: "送っている",
  registered: "登録した",
  already: "もう処理済み",
  failed: "失敗",
  unknown: "結果が分からない",
};

export type FreeeItem = { state: FreeeItemState; dealIds?: number[]; reason?: string; at: string };

export type FreeeRun = { at: string; registered: number; already: number; failed: number; unknown: number; dealIds: number[] };

/** 「freee に明細を入れる」の結果が分からない時の、待つ期限（読み込み直しても残す） */
export type ImportHold = { until: string; reason: string };

export type FreeeRecord = {
  v: 1;
  /** 送り始めた時に固定した店用／私用（"t<freee の明細の番号>" → 店用 / 私用）。まだ送っていなければ null */
  uses: Record<string, CardUse> | null;
  items: Record<string, FreeeItem>;
  /** 送っている間の印（1件ごとに付けなおす）。古ければ止まった物とみなす */
  sendingAt: string | null;
  /** 最後の登録の数 */
  lastRun: FreeeRun | null;
  /** 「freee に明細を入れる」の結果が分からない時：この時刻までは入れない（過ぎても、読み直して照らし合わせてから、まだ無い物だけ入れる） */
  importHold: ImportHold | null;
  /**
   * このブラウザが freee とつながった印（つながっている答えを受けた時に付け、「つなぎを外す」で外す）。
   * 鍵が切れた後も、明細の一覧を黙って架空の明細に切り替えないため。鍵は持たない。
   */
  linked: boolean;
};

export const EMPTY_FREEE: FreeeRecord = { v: 1, uses: null, items: {}, sendingAt: null, lastRun: null, importHold: null, linked: false };

const STATES = new Set<FreeeItemState>(["pending", "sending", "registered", "already", "failed", "unknown"]);
const isStr = (x: unknown): x is string => typeof x === "string";
const isUse = (x: unknown): x is CardUse => x === "shop" || x === "private";
const isCount = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;
const ids = (x: unknown): number[] => (Array.isArray(x) ? x.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0).slice(0, 50) : []);

/** ブラウザに残っていた文字を読む。形のおかしい物は落とす */
export function parseFreee(raw: string | null): FreeeRecord {
  if (!raw) return EMPTY_FREEE;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(raw);
  } catch {
    return EMPTY_FREEE;
  }
  if (!d || typeof d !== "object") return EMPTY_FREEE;
  let uses: Record<string, CardUse> | null = null;
  if (d.uses && typeof d.uses === "object") {
    uses = {};
    for (const [k, v] of Object.entries(d.uses as Record<string, unknown>)) if (isTxnKey(k) && isUse(v)) uses[k] = v;
    if (Object.keys(uses).length === 0) uses = null;
  }
  const items: Record<string, FreeeItem> = {};
  if (d.items && typeof d.items === "object")
    for (const [k, v] of Object.entries(d.items as Record<string, unknown>)) {
      const x = v as Record<string, unknown>;
      if (!isTxnKey(k) || !x || !STATES.has(x.state as FreeeItemState) || !isStr(x.at)) continue;
      items[k] = {
        state: x.state as FreeeItemState,
        at: x.at,
        ...(ids(x.dealIds).length ? { dealIds: ids(x.dealIds) } : {}),
        ...(isStr(x.reason) ? { reason: x.reason.slice(0, 300) } : {}),
      };
    }
  const r = d.lastRun as Record<string, unknown> | null | undefined;
  const lastRun: FreeeRun | null =
    r && typeof r === "object" && isStr(r.at) && isCount(r.registered) && isCount(r.already) && isCount(r.failed) && isCount(r.unknown)
      ? { at: r.at, registered: r.registered, already: r.already, failed: r.failed, unknown: r.unknown, dealIds: ids(r.dealIds) }
      : null;
  const h = d.importHold as Record<string, unknown> | null | undefined;
  const importHold: ImportHold | null = h && typeof h === "object" && isStr(h.until) && Number.isFinite(Date.parse(h.until)) ? { until: h.until, reason: isStr(h.reason) ? h.reason.slice(0, 300) : "" } : null;
  return { v: 1, uses, items, sendingAt: isStr(d.sendingAt) ? d.sendingAt : null, lastRun, importHold, linked: d.linked === true };
}

/** 明細を入れるのを待っているか（期限の前） */
export function importHeld(r: FreeeRecord, nowMs: number): boolean {
  return !!r.importHold && Date.parse(r.importHold.until) > nowMs;
}

export function withImportHold(r: FreeeRecord, nowMs: number, waitSeconds: number, reason: string): FreeeRecord {
  return { ...r, importHold: { until: new Date(nowMs + waitSeconds * 1000).toISOString(), reason } };
}

/**
 * 「最初に戻す」の後にも残す物：明細を入れる待つ期限と、「結果が分からない」の明細。
 * 送ったかどうか分からない物は、戻した後も読み直して照らし合わせるまで送らない。
 */
export function keptOnReset(r: FreeeRecord, nowMs: number): FreeeRecord | null {
  const items: Record<string, FreeeItem> = {};
  for (const [k, v] of Object.entries(r.items)) if (v.state === "unknown" || v.state === "sending") items[k] = { ...v, state: "unknown" };
  const importHold = importHeld(r, nowMs) ? r.importHold : null;
  if (!importHold && Object.keys(items).length === 0) return null;
  return { ...EMPTY_FREEE, items, importHold };
}

export function stateOf(r: FreeeRecord, key: string): FreeeItemState {
  return r.items[key]?.state ?? "pending";
}

/** つながった印を付ける・外す */
export function withLinked(r: FreeeRecord, linked: boolean): FreeeRecord {
  return r.linked === linked ? r : { ...r, linked };
}

/** 送り始めたか（選びを固定する・画面の中の会計に黙って切り替えない） */
export function hasStarted(r: FreeeRecord): boolean {
  return r.uses !== null || Object.values(r.items).some((i) => i.state !== "pending");
}

/** いま送っているか（印が新しい） */
export function isSending(r: FreeeRecord, nowMs: number, staleSeconds: number): boolean {
  if (!r.sendingAt) return false;
  const t = Date.parse(r.sendingAt);
  return Number.isFinite(t) && nowMs - t < staleSeconds * 1000;
}

/**
 * 送っている印が古い（画面を閉じた・止まった）時：「送っている」の明細は「結果が分からない」にする。
 * 送ったかどうか分からないので、送り直さずに読み直してから決める。
 */
export function withStaleRecovered(r: FreeeRecord, nowMs: number, staleSeconds: number, nowIso: string): FreeeRecord {
  if (!r.sendingAt || isSending(r, nowMs, staleSeconds)) return r;
  const items = { ...r.items };
  for (const [k, v] of Object.entries(items))
    if (v.state === "sending") items[k] = { state: "unknown", at: nowIso, reason: "送っている途中で画面が止まりました。freee から読み直してください" };
  return { ...r, items, sendingAt: null };
}

/** 次の「登録」で送る明細（まだ・失敗）。結果が分からない物は、読み直すまで送らない */
export function toSend(r: FreeeRecord, keys: string[]): string[] {
  return keys.filter((k) => {
    const s = stateOf(r, k);
    return s === "pending" || s === "failed";
  });
}

/** 送り始める：送る明細の選びを固定し（もう固定してある明細は変えない）、送っている印を付ける */
export function withRunStart(r: FreeeRecord, uses: Record<string, CardUse>, nowIso: string): FreeeRecord {
  return { ...r, uses: { ...uses, ...(r.uses ?? {}) }, sendingAt: nowIso };
}

/** この明細の選びを固定したか（送り始めた明細だけ。新しく読んだ明細は選べる） */
export function isFixed(r: FreeeRecord, key: string): boolean {
  return !!r.uses && key in r.uses;
}

export function withSending(r: FreeeRecord, key: string, nowIso: string): FreeeRecord {
  return { ...r, sendingAt: nowIso, items: { ...r.items, [key]: { state: "sending", at: nowIso } } };
}

export function withItem(r: FreeeRecord, key: string, item: Omit<FreeeItem, "at">, nowIso: string): FreeeRecord {
  return { ...r, items: { ...r.items, [key]: { ...item, at: nowIso } } };
}

export function withRunEnd(r: FreeeRecord, run: FreeeRun): FreeeRecord {
  return { ...r, sendingAt: null, lastRun: run };
}

/**
 * 読み直した結果を入れる（書かない）。もう処理済み → もう処理済み・未処理 → まだ・確かめが要る → 失敗。
 * startedAtMs：読み直しを始めた時刻。それより新しい記録（読み直しの間にほかの画面が登録した など）は上書きしない。
 */
export function withChecked(
  r: FreeeRecord,
  answers: { key: string; kind: "ready" | "done" | "check" | "missing"; reason?: string }[],
  nowIso: string,
  startedAtMs: number,
): FreeeRecord {
  let out = r;
  for (const a of answers) {
    const cur = stateOf(out, a.key);
    const prev = out.items[a.key];
    if (prev && Date.parse(prev.at) >= startedAtMs) continue; // 読み直しを始めた後の記録の方が新しい
    if (cur === "registered" && a.kind === "done") continue; // 登録した記録はそのまま
    if (cur === "sending") continue;
    const item: Omit<FreeeItem, "at"> =
      a.kind === "done"
        ? { state: "already" }
        : a.kind === "ready"
          ? { state: "pending" }
          : a.kind === "missing"
            ? { state: "failed", reason: "freee の読む期間の中に、この明細がありません" }
            : { state: "failed", reason: `確かめが要る：${a.reason ?? ""}` };
    out = withItem(out, a.key, item, nowIso);
  }
  return out;
}

export type FreeeCounts = Record<FreeeItemState, number>;

export function countsOf(r: FreeeRecord, keys: string[]): FreeeCounts {
  const c: FreeeCounts = { pending: 0, sending: 0, registered: 0, already: 0, failed: 0, unknown: 0 };
  for (const k of keys) c[stateOf(r, k)]++;
  return c;
}

/** 記録にある明細の鍵（記録の数を出す・読み直しで照らし合わせる） */
export function recordKeys(r: FreeeRecord): string[] {
  return Object.keys(r.items);
}

/** 取引の番号（登録した物だけ） */
export function dealIdsOf(r: FreeeRecord, keys: string[]): { key: string; dealIds: number[] }[] {
  return keys.map((key) => ({ key, dealIds: r.items[key]?.dealIds ?? [] })).filter((x) => x.dealIds.length > 0 && stateOf(r, x.key) === "registered");
}
