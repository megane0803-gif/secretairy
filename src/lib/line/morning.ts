// 「朝の要点を LINE に送る」の文。ホームの朝の要点と同じ物（今日の予約・前回の次回提案・今日の空き枠）を、
// プログラムが決まった形の文にする（AI は使わない。数はプログラムが出した物だけ）。

import type { FreeRange } from "../reservations";
import { MAX_OUT_TEXT } from "./wire";

export type MorningItem = {
  start: string;
  end: string;
  surname: string;
  menu: string;
  hold: boolean;
  /** 前回の次回提案（無ければ null = 前回の記録なし。[] = 次回提案は空） */
  next: string[] | null;
};

export function morningText(o: {
  shopName: string;
  todayLabel: string;
  items: MorningItem[];
  open: boolean;
  free: { ranges: FreeRange[]; seatSlots: number };
  slotMinutes: number;
}): string {
  const lines: string[] = [`${o.shopName} 朝の要点（${o.todayLabel}）`, "", `■ 今日の予約 ${o.items.length}件`];
  if (o.items.length === 0) lines.push("・今日の予約はありません");
  for (const r of o.items) {
    lines.push(`・${r.start}–${r.end} ${r.surname}（架空）様 ${r.menu}${r.hold ? "（仮押さえ）" : ""}`);
    if (r.next === null) lines.push("　前回の記録なし");
    else if (r.next.length === 0) lines.push("　前回の次回提案：（空でした）");
    else lines.push(`　前回の次回提案：${r.next.join("／")}`);
  }
  lines.push("");
  if (!o.open) lines.push("■ 今日の空き枠：今日はお休みです");
  else {
    lines.push(`■ 今日の空き枠（これから）${o.free.seatSlots}枠（${o.slotMinutes}分 × 席）`);
    if (o.free.ranges.length === 0) lines.push("・これからの空きはありません");
    for (const f of o.free.ranges) lines.push(`・${f.start}–${f.end} 空き${f.free}席`);
  }
  lines.push("", "✓ 台帳と席の数からプログラムが数えました");
  const text = lines.join("\n");
  const tail = "\n…（続きは画面で）";
  return text.length <= MAX_OUT_TEXT ? text : text.slice(0, MAX_OUT_TEXT - tail.length) + tail;
}
