// だれがしたかの色の意味（3つだけ）。使うのは予約の台帳・AI の手順・日誌の札だけ（ほかのタブの色は変えない）。
//   AI がした事 = 青緑（--who-ai）・人がした事 = 琥珀（--who-human）・外の相手 = 藍（--who-outside）
// 色だけに頼らず、札には必ず「AI」「人」「外」の文字を添える（ACTOR_LABEL）。

import type { JournalWho } from "./journal";
import type { Reservation } from "./reservations";

export type Actor = "ai" | "human" | "outside";

/** 札に必ず添える文字 */
export const ACTOR_LABEL: Record<Actor, string> = { ai: "AI", human: "人", outside: "外" };

/** 札の読み上げ・ホバーの文 */
export const ACTOR_MEANING: Record<Actor, string> = {
  ai: "AI がした事",
  human: "人がした事",
  outside: "外の相手",
};

/**
 * 台帳の予約は、だれが入れた物か。
 * 仮押さえ = AI（予約チャット・LINE の一言で AI が押さえた）／
 * 予約サイト（架空）から入った確定 = 外（お客様が予約サイトで自分で決めた予約）／
 * それ以外の確定（承認で確定・最初の状態の架空の予約＝店が受けて確定した予約）= 人。
 */
export function reservationActor(r: Pick<Reservation, "status" | "source">): Actor {
  if (r.status === "hold") return "ai";
  return r.source === "site" ? "outside" : "human";
}

/** 日誌の「だれ」。プログラムは3つのどれでもない（今までどおりの灰色の札） */
export function journalActor(who: JournalWho): Actor | null {
  if (who === "AI") return "ai";
  if (who === "オーナー") return "human";
  if (who === "LINE" || who === "予約サイト") return "outside";
  return null;
}
