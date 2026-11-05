// freee（テスト事業所）の記録を、見ている人のブラウザの中だけに残す形（docs/SPEC.md §1.8.1）。
// 会計（架空）の記録（accounting/state.ts の secretairy:accounting）とは分けて持つ（secretairy:freee）。
// ここは形と変え方だけ（どこにも書かない）。
//
// 明細ごとの状態：まだ・送っている・登録した・もう処理済み・失敗・結果が分からない。
// 送り始めたら、明細と店用／私用の選び（uses）を固定する。送っている間は、登録のし直しと「最初に戻す」を止める。

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

export type FreeeRecord = {
  v: 1;
  /** 送り始めた時に固定した店用／私用（明細の番号 → 店用 / 私用）。まだ送っていなければ null */
  uses: Record<string, CardUse> | null;
  items: Record<string, FreeeItem>;
  /** 送っている間の印（1件ごとに付けなおす）。古ければ止まった物とみなす */
  sendingAt: string | null;
  /** 最後の登録の数 */
  lastRun: FreeeRun | null;
};

export const EMPTY_FREEE: FreeeRecord = { v: 1, uses: null, items: {}, sendingAt: null, lastRun: null };

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
    for (const [k, v] of Object.entries(d.uses as Record<string, unknown>)) if (/^\d+$/.test(k) && isUse(v)) uses[k] = v;
  }
  const items: Record<string, FreeeItem> = {};
  if (d.items && typeof d.items === "object")
    for (const [k, v] of Object.entries(d.items as Record<string, unknown>)) {
      const x = v as Record<string, unknown>;
      if (!/^\d+$/.test(k) || !x || !STATES.has(x.state as FreeeItemState) || !isStr(x.at)) continue;
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
  return { v: 1, uses, items, sendingAt: isStr(d.sendingAt) ? d.sendingAt : null, lastRun };
}

export function stateOf(r: FreeeRecord, no: number): FreeeItemState {
  return r.items[String(no)]?.state ?? "pending";
}

/** 送り始めたか（選びを固定する・会計（架空）に黙って切り替えない） */
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
export function toSend(r: FreeeRecord, nos: number[]): number[] {
  return nos.filter((no) => {
    const s = stateOf(r, no);
    return s === "pending" || s === "failed";
  });
}

/** 送り始める：選びを固定し（もう固定してあれば変えない）、送っている印を付ける */
export function withRunStart(r: FreeeRecord, uses: Record<string, CardUse>, nowIso: string): FreeeRecord {
  return { ...r, uses: r.uses ?? { ...uses }, sendingAt: nowIso };
}

export function withSending(r: FreeeRecord, no: number, nowIso: string): FreeeRecord {
  return { ...r, sendingAt: nowIso, items: { ...r.items, [String(no)]: { state: "sending", at: nowIso } } };
}

export function withItem(r: FreeeRecord, no: number, item: Omit<FreeeItem, "at">, nowIso: string): FreeeRecord {
  return { ...r, items: { ...r.items, [String(no)]: { ...item, at: nowIso } } };
}

export function withRunEnd(r: FreeeRecord, run: FreeeRun): FreeeRecord {
  return { ...r, sendingAt: null, lastRun: run };
}

/** 読み直した結果を入れる（書かない）。もう処理済み → もう処理済み・未処理 → まだ・確かめが要る → 失敗 */
export function withChecked(
  r: FreeeRecord,
  answers: { no: number; kind: "ready" | "done" | "check" | "missing"; reason?: string }[],
  nowIso: string,
): FreeeRecord {
  let out = r;
  for (const a of answers) {
    const cur = stateOf(out, a.no);
    if (cur === "registered" && a.kind === "done") continue; // 登録した記録はそのまま
    if (cur === "sending") continue;
    const item: Omit<FreeeItem, "at"> =
      a.kind === "done"
        ? { state: "already" }
        : a.kind === "ready"
          ? { state: "pending" }
          : a.kind === "missing"
            ? { state: "failed", reason: "freee にこの明細がありません。先に「freee に明細を入れる」を押してください" }
            : { state: "failed", reason: `確かめが要る：${a.reason ?? ""}` };
    out = withItem(out, a.no, item, nowIso);
  }
  return out;
}

export type FreeeCounts = Record<FreeeItemState, number>;

export function countsOf(r: FreeeRecord, nos: number[]): FreeeCounts {
  const c: FreeeCounts = { pending: 0, sending: 0, registered: 0, already: 0, failed: 0, unknown: 0 };
  for (const no of nos) c[stateOf(r, no)]++;
  return c;
}

/** 取引の番号（登録した物だけ。番号の順） */
export function dealIdsOf(r: FreeeRecord, nos: number[]): { no: number; dealIds: number[] }[] {
  return nos.map((no) => ({ no, dealIds: r.items[String(no)]?.dealIds ?? [] })).filter((x) => x.dealIds.length > 0 && stateOf(r, x.no) === "registered");
}
