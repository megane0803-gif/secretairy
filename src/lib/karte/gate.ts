// 言葉の門（プログラム）。AI の下書きを1行ずつ見て、
// 体・病院・薬・判断や助言の言葉（src/lib/rules/locked.ts の KARTE_GATE_WORDS）や数字が
// 施術メモに無ければ、その1行だけ載せない。メモにある言葉（例：「頭皮が赤かった」）は記録として残す。
// 🔒 鍵つきの2つ目（健康や医療の判断はしない）を守るための物。AI は使わない。

import { KARTE_GATE_WORDS } from "../rules/locked";
import type { KarteHeading } from "../settings";
import { emptySections, type KarteSections } from "./format";

export type GateRemoved = { headingId: string; heading: string; line: string; reason: string };

/** 比べやすくする（全角の数字・英字を半角に。時刻・桁区切りをそろえる） */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/(\d{1,2}):00(?!\d)/g, "$1時")
    .replace(/(\d{1,2}):(\d{2})(?!\d)/g, "$1時$2分");
}

/** 文の中の数字（「05」と「5」は同じ数） */
export function numbersIn(s: string): string[] {
  return [...new Set((normalizeText(s).match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n))))];
}

/** その1行を載せてよいか。載せないときは理由（1文）を返す */
export function gateLine(line: string, memo: string): string | null {
  const l = normalizeText(line);
  const m = normalizeText(memo);
  const words = KARTE_GATE_WORDS.filter((w) => l.includes(w) && !m.includes(w));
  const memoNums = new Set(numbersIn(memo));
  const nums = numbersIn(line).filter((n) => !memoNums.has(n));
  const parts: string[] = [];
  if (words.length) parts.push(`${words.map((w) => `「${w}」`).join("")}はメモに無い言葉です`);
  if (nums.length) parts.push(`${nums.map((n) => `「${n}」`).join("")}はメモに無い数字です`);
  return parts.length ? parts.join("。") : null;
}

/** 下書き全部を言葉の門に通す。外した行は removed に、残った行は sections に */
export function gateKarte(
  sections: KarteSections,
  memo: string,
  headings: KarteHeading[],
): { sections: KarteSections; removed: GateRemoved[] } {
  const out = emptySections(headings);
  const removed: GateRemoved[] = [];
  for (const h of headings)
    for (const line of sections[h.id] ?? []) {
      const reason = gateLine(line, memo);
      if (reason) removed.push({ headingId: h.id, heading: h.label, line, reason });
      else out[h.id].push(line);
    }
  return { sections: out, removed };
}

/** 画面と日誌に出す1文 */
export function removedSentence(r: GateRemoved): string {
  return `1行を載せていません（${r.reason}）`;
}
