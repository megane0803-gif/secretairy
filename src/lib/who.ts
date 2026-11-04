// だれがしたか（台帳・AI の手順・日誌の札）。色は globals.css の --who-ai（青緑）・--who-human（琥珀）・--who-outside（藍）で、
// 色だけに頼らず、札にはいつも「AI」「人」「外」（とプログラム）の文字を出す（parts.tsx の WhoMark）。

import type { Reservation } from "./reservations";

export type WhoKind = "ai" | "human" | "outside" | "program";

/** 台帳の1行：仮押さえ = AI（予約チャットの AI が押さえた）・承認で確定 = 人・最初の状態の予約 = 外（お客様からの予約） */
export function reservationWho(r: Pick<Reservation, "status" | "source">): { who: WhoKind; title: string } {
  if (r.status === "hold") return { who: "ai", title: "AI が仮押さえ（承認待ち）" };
  if (r.source === "chat") return { who: "human", title: "人が承認で確定" };
  return { who: "outside", title: "お客様（外の相手）からの予約" };
}

/** AI の手順の1行：道具を呼んだ・仮押さえ・仮押さえを外した = AI、ルールで弾いた・上限・聞き返し・ToDo = プログラム */
export function stepWho(kind: string): WhoKind {
  return kind === "tool" || kind === "hold" || kind === "release" ? "ai" : "program";
}
