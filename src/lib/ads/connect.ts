// 本物の検索広告へ渡す形（docs/SPEC.md §1.7.6）。今はつないでいない。
// 今のデータは見ている人のブラウザの中だけにあるので、サーバーから本物の広告へ自動では渡せない。
// ここでは「渡す中身」（syncPayload）と「受け取る結果」（readSyncResult）の形だけを決め、画面から書き出し・読み込みする。
//   - 渡す中身：承認済みでまだ反映していない案（止める・外す・足す）。承認していない・見送った・反映済み・戻した案は入れない。
//     戻す案（また出す・外すのをやめる）の承認は、今は入れない（README の「次に作る物」）。
//     足す案は、書き出す時にも売りの言葉が入っているかをもう一度確かめる（featured.ts の featuredWordIn）。
//   - 受け取る結果：案の番号ごとに「反映した／できなかった（理由）」。反映した案に「本物に反映済み」の印（realAt）。
//     貼られた文字は大きさに上限・形を確かめてから読む。番号・種類・言葉が合わない物には印を付けず、1行の知らせ。2回読んでも印は1回。
// 鍵・合言葉・本物の広告の番号は入れない（キャンペーンと広告グループは設定の作り物の名前だけ）。
// 本物の側で動かす見本は connect/google-ads/secretairy-sync.js（同じ形を読む・作る）。ここは形と変え方だけ（どこにも書かない）。

import type { AdSettings } from "../settings";
import { featuredWordIn } from "./featured";
import type { AdsState } from "./state";

export const SYNC_FORMAT = "secretairy-ads-sync";
export const RESULT_FORMAT = "secretairy-ads-result";
export const SYNC_VERSION = 1;

export type SyncKind = "stop" | "exclude" | "add";
/** 合い方：足す＝フレーズ一致・外す＝完全一致（止めるは今ある言葉を文字で探すので持たない） */
export type SyncMatch = "phrase" | "exact";

export type SyncItem = { id: string; kind: SyncKind; text: string; match?: SyncMatch; approvedAt: string };

export type SyncPayload = {
  format: typeof SYNC_FORMAT;
  version: typeof SYNC_VERSION;
  createdAt: string;
  campaign: string;
  adGroup: string;
  items: SyncItem[];
};

export type SyncStatus = "done" | "failed";
export type SyncResultItem = { id: string; kind: SyncKind; text: string; status: SyncStatus; reason?: string };

export type ConnectSettings = AdSettings["connect"];

const KINDS: readonly SyncKind[] = ["stop", "exclude", "add"];
const MATCH: Record<SyncKind, SyncMatch | undefined> = { stop: undefined, exclude: "exact", add: "phrase" };

/** 今の広告の状態で、本物に渡す案（承認済み・まだ効いている・まだ反映していない）。足す案は売りの言葉をもう一度確かめる */
export function syncItems(s: AdsState, words: readonly string[]): { items: SyncItem[]; notes: string[] } {
  const items: SyncItem[] = [];
  const notes: string[] = [];
  for (const p of s.proposals) {
    // 戻した案（applied から外れた物）は入れない
    if (p.state !== "approved" || p.realAt || !s.applied.some((a) => a.proposalId === p.id)) continue;
    items.push({ id: p.id, kind: p.action, text: p.text, ...(MATCH[p.action] ? { match: MATCH[p.action] } : {}), approvedAt: p.decidedAt ?? p.createdAt });
  }
  for (const p of s.adds ?? []) {
    if (p.state !== "approved" || p.realAt || !(s.added ?? []).some((a) => a.proposalId === p.id)) continue;
    if (!featuredWordIn(p.text, words)) {
      notes.push(`「${p.text}」には売りの言葉が入っていないので、渡す中身に入れませんでした`);
      continue;
    }
    items.push({ id: p.id, kind: "add", text: p.text, match: "phrase", approvedAt: p.decidedAt ?? p.createdAt });
  }
  items.sort((a, b) => a.approvedAt.localeCompare(b.approvedAt) || a.id.localeCompare(b.id));
  return { items, notes };
}

/** 渡す中身（JSON にする前の形） */
export function syncPayload(s: AdsState, words: readonly string[], settings: ConnectSettings, nowIso: string): { payload: SyncPayload; notes: string[] } {
  const { items, notes } = syncItems(s, words);
  const kept = items.slice(0, settings.maxItems);
  if (items.length > kept.length) notes.push(`渡す案は1回に${settings.maxItems}件までなので、残り${items.length - kept.length}件は次に入れます`);
  return {
    payload: { format: SYNC_FORMAT, version: SYNC_VERSION, createdAt: nowIso, campaign: settings.campaign, adGroup: settings.adGroup, items: kept },
    notes,
  };
}

export type SyncRead = { ok: false; note: string } | { ok: true; marks: { id: string; kind: SyncKind }[]; notes: string[] };

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === "string";

/**
 * 貼られた結果を読む。大きさ → JSON → 形（全部の行）の順に確かめ、どこかが違えば何も変えずに1行の知らせ。
 * 形が合えば、行ごとに照らす：反映した＋番号・種類・言葉が渡す中身と同じ → 印。ほかは印を付けずに知らせ。
 */
export function readSyncResult(raw: string, s: AdsState, words: readonly string[], settings: ConnectSettings): SyncRead {
  const text = String(raw ?? "");
  if (!text.trim()) return { ok: false, note: "結果が貼られていません" };
  if (text.length > settings.maxPasteChars) return { ok: false, note: `貼られた文字が大きすぎます（${settings.maxPasteChars.toLocaleString("ja-JP")}字まで）。何も変えていません` };
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    return { ok: false, note: "結果の形が違います（JSON として読めません）。何も変えていません" };
  }
  const bad = { ok: false as const, note: "結果の形が違います。何も変えていません" };
  if (!isObj(d) || d.format !== RESULT_FORMAT || d.version !== SYNC_VERSION || !Array.isArray(d.results)) return bad;
  if (d.results.length > settings.maxItems) return { ok: false, note: `結果の行が多すぎます（${settings.maxItems}件まで）。何も変えていません` };
  const rows: SyncResultItem[] = [];
  for (const r of d.results) {
    if (!isObj(r) || !isStr(r.id) || !KINDS.includes(r.kind as SyncKind) || !isStr(r.text) || (r.status !== "done" && r.status !== "failed")) return bad;
    if (r.reason !== undefined && !isStr(r.reason)) return bad;
    rows.push({
      id: r.id.slice(0, 80),
      kind: r.kind as SyncKind,
      text: r.text.slice(0, 80),
      status: r.status,
      ...(isStr(r.reason) ? { reason: r.reason.replace(/\s+/g, " ").slice(0, 80) } : {}),
    });
  }
  if (isStr(d.campaign) && d.campaign !== settings.campaign) return { ok: false, note: "結果のキャンペーンの名前が設定と違います。何も変えていません" };

  const expected = new Map(syncItems(s, words).items.map((i) => [i.id, i]));
  const known = new Map<string, { kind: SyncKind; text: string; realAt?: string }>([
    ...s.proposals.map((p) => [p.id, { kind: p.action as SyncKind, text: p.text, realAt: p.realAt }] as const),
    ...(s.adds ?? []).map((p) => [p.id, { kind: "add" as SyncKind, text: p.text, realAt: p.realAt }] as const),
  ]);
  const marks: { id: string; kind: SyncKind }[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const k = known.get(r.id);
    if (!k) {
      notes.push(`知らない番号（${r.id}）なので、印を付けませんでした`);
      continue;
    }
    if (k.kind !== r.kind || k.text !== r.text) {
      notes.push(`「${k.text}」の行は、種類や言葉が渡した中身と違うので、印を付けませんでした`);
      continue;
    }
    if (k.realAt || seen.has(r.id)) {
      notes.push(`「${k.text}」はもう反映済みの印があります`);
      continue;
    }
    if (!expected.has(r.id)) {
      notes.push(`「${k.text}」は番号が合いません（承認済みで反映を待つ案ではありません）。印を付けませんでした`);
      continue;
    }
    seen.add(r.id);
    if (r.status === "failed") {
      notes.push(`「${k.text}」は本物の広告で反映できませんでした${r.reason ? `（${r.reason}）` : ""}`);
      continue;
    }
    marks.push({ id: r.id, kind: r.kind });
  }
  return { ok: true, marks, notes };
}

/** 反映済みの印を付ける（もう印がある物は変えない＝2回読んでも1回） */
export function withSynced(s: AdsState, marks: readonly { id: string; kind: SyncKind }[], nowIso: string): AdsState {
  const ids = new Set(marks.map((m) => m.id));
  if (ids.size === 0) return s;
  return {
    ...s,
    proposals: s.proposals.map((p) => (ids.has(p.id) && !p.realAt && p.state === "approved" ? { ...p, realAt: nowIso } : p)),
    ...(s.adds ? { adds: s.adds.map((p) => (ids.has(p.id) && !p.realAt && p.state === "approved" ? { ...p, realAt: nowIso } : p)) } : {}),
  };
}

/** 「本物に反映済み」の印がある言葉（止めた・外した・足した。番号ごと） */
export function realMarkedNos(s: AdsState): Set<number> {
  const out = new Set<number>();
  for (const a of s.applied) if (s.proposals.find((p) => p.id === a.proposalId)?.realAt) out.add(a.no);
  for (const a of s.added ?? []) if (s.adds?.find((p) => p.id === a.proposalId)?.realAt) out.add(a.no);
  return out;
}
