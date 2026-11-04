// プログラムの門。AI の案を承認の箱に出す前に、プログラムで3つ確かめる（画面では ✓ の印で出す）。
//   1. 番号が表にあるか（止める＝広告を出す言葉・外す＝調べた言葉。もう止めた物は選ばない）
//   2. 言葉を足していないか（道具は「止める」「外す」だけ。番号と理由のほかに何も足していない）
//   3. 外す言葉に町の名前が入っていないか（町の名前は外さない。config/ads.json の towns）
// ほかに形（案が1つ・理由が1文で数字なし）も確かめる。弾いたら理由を AI に渡して作り直させる（review.ts）。

import type { ToolCall } from "../ai/model";
import { actionFor, actionVerb, findRow, townIn, type AdAction, type AdTable } from "./report";
import { AD_TOOL_ACTION, isAdTool } from "./tools";

export type GateCheckId = "exists" | "noAdd" | "town";

/** ok: true = ✓ / false = ✗ / null = 前の確認で止まったので見ていない */
export type GateCheck = { id: GateCheckId; label: string; ok: boolean | null; reason?: string };

export const GATE_LABELS: Record<GateCheckId, string> = {
  exists: "番号が表にある",
  noAdd: "言葉を足していない",
  town: "町の名前の言葉を外していない",
};

/** AI の案を、門で見る形にしたもの */
export type AdDraft = {
  /** 道具の名前（止める・外す以外なら言葉を足す案として弾く） */
  tool: string;
  action: AdAction | null;
  no: unknown;
  reason: unknown;
  /** 番号と理由のほかに付いていた物 */
  extraKeys: string[];
};

/** 門を通った案（数は入れていない。数は画面が表から入れる） */
export type GatedProposal = { action: AdAction; no: number; text: string; reason: string };

export type GateResult =
  | { ok: true; proposal: GatedProposal; checks: GateCheck[] }
  | { ok: false; checks: GateCheck[]; problems: string[] };

const MAX_REASON = 80;

/** 理由を1文にする（最初の「。」まで） */
export function oneSentence(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  const i = t.search(/[。！？!?]/);
  const first = i >= 0 ? t.slice(0, i + 1) : t;
  return first.length > MAX_REASON ? `${first.slice(0, MAX_REASON - 1)}…` : first;
}

export function draftFrom(call: ToolCall): AdDraft {
  const input = call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : {};
  return {
    tool: call.name,
    action: isAdTool(call.name) ? AD_TOOL_ACTION[call.name] : null,
    no: input.no,
    reason: input.reason,
    extraKeys: Object.keys(input).filter((k) => k !== "no" && k !== "reason"),
  };
}

/** 1つの案を門で確かめる（画面でも、受け取った案をもう一度ここで確かめる） */
export function checkDraft(table: AdTable, towns: string[], d: AdDraft): GateResult {
  const problems: string[] = [];

  // 2. 言葉を足していないか
  const noAdd: GateCheck = { id: "noAdd", label: GATE_LABELS.noAdd, ok: true };
  if (!d.action) {
    noAdd.ok = false;
    noAdd.reason = `「止める」「外す」のほかの道具（${d.tool}）は使えません。言葉を足す・広げる案は出せません`;
  } else if (d.extraKeys.length > 0) {
    noAdd.ok = false;
    noAdd.reason = `番号と理由のほかに（${d.extraKeys.join("・")}）を足しています。表の言葉を番号で選ぶだけにしてください`;
  }

  // 1. 番号が表にあるか
  const exists: GateCheck = { id: "exists", label: GATE_LABELS.exists, ok: true };
  const no = typeof d.no === "number" ? d.no : typeof d.no === "string" && /^\d+$/.test(d.no) ? Number(d.no) : NaN;
  const row = Number.isInteger(no) ? findRow(table, no) : null;
  if (!row) {
    exists.ok = false;
    exists.reason = Number.isInteger(no) ? `${no}番は表にありません` : "番号がありません";
  } else if (d.action && actionFor(row.kind) !== d.action) {
    exists.ok = false;
    exists.reason =
      row.kind === "keyword"
        ? `${no}番は広告を出す言葉なので「外す」ではなく「止める」です`
        : `${no}番はお客さんが調べた言葉なので「止める」ではなく「外す」です`;
  } else if (row.off) {
    exists.ok = false;
    exists.reason = `${no}番「${row.text}」はもう${row.kind === "keyword" ? "止めて" : "外して"}います`;
  }

  // 3. 外す言葉に町の名前が入っていないか（番号が表に無ければ見られない）
  const town: GateCheck = { id: "town", label: GATE_LABELS.town, ok: row ? true : null };
  if (row && d.action === "exclude") {
    const name = townIn(row.text, towns);
    if (name) {
      town.ok = false;
      town.reason = `${row.no}番「${row.text}」には町の名前（${name}）が入っています。町の名前の言葉は外しません`;
    }
  }

  const checks = [exists, noAdd, town];
  for (const c of checks) if (c.ok === false && c.reason) problems.push(c.reason);

  // 形：理由が1文あって、数字を書いていない
  const reason = typeof d.reason === "string" ? oneSentence(d.reason) : "";
  if (!reason) problems.push("理由の1文がありません");
  else if (/[0-9０-９]/.test(reason)) problems.push("理由の文に数字を書いています。数はプログラムが表から入れるので、数字なしの1文にしてください");

  if (problems.length > 0 || !row || !d.action) return { ok: false, checks, problems };
  return { ok: true, proposal: { action: d.action, no: row.no, text: row.text, reason }, checks };
}

/** AI の1回の返事（道具の呼び出し）を門で確かめる。案は1回に1つ */
export function gate(table: AdTable, towns: string[], calls: ToolCall[]): GateResult {
  const empty: GateCheck[] = (["exists", "noAdd", "town"] as GateCheckId[]).map((id) => ({ id, label: GATE_LABELS[id], ok: null }));
  if (calls.length === 0) return { ok: false, checks: empty, problems: ["案がありません。「止める」か「外す」の道具で1つ出してください"] };
  if (calls.length > 1) {
    const r = checkDraft(table, towns, draftFrom(calls[0]));
    return { ok: false, checks: r.checks, problems: ["案は1回に1つです", ...(r.ok ? [] : r.problems)] };
  }
  return checkDraft(table, towns, draftFrom(calls[0]));
}

/** 日誌の言葉：「3番「美容院 安い」を止める」 */
export function proposalLabel(p: Pick<GatedProposal, "action" | "no" | "text">): string {
  return `${p.no}番「${p.text}」を${actionVerb(p.action)}`;
}
