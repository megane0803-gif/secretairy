// 予約チャットの、画面とサーバー（/api/ai/reserve）のあいだの形。
// サーバーは受け取った物を残さない。答え（文・手順・候補・仮押さえ）を1行ずつの JSON で流して返すだけ。

import type { Rule } from "../rules/types";

/** 画面から送る、台帳の1件（確定・仮押さえ・過去の来店） */
export type BookedRow = {
  id: string;
  customerId: string;
  menuId: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM */
  start: string;
  status: "confirmed" | "hold";
  /** 初めての方 */
  newCustomer: boolean;
};

/** 予約の候補。お客様に「1つ目」「2つ目」と番号で出す */
export type Candidate = {
  menuId: string;
  date: string;
  start: string;
};

export type ChatTurn = { role: "user" | "assistant"; text: string };

/** ai = Claude に聞く / script = 決まった返事（AI なし。テストと、AI につながらないときのお試し用） */
export type ChatMode = "ai" | "script";

export type ReserveRequest = {
  mode: ChatMode;
  /** これまでの会話（文だけ）。最後はお客様の文 */
  messages: ChatTurn[];
  /** 直前にお客様へ出した候補（「1つ目で」のときに使う） */
  candidates: Candidate[];
  customer: { id: string; surname: string; firstVisit: boolean };
  /** そのブラウザの台帳（最初の状態＋仮押さえ＋確定） */
  booked: BookedRow[];
  /** そのブラウザのルール（鍵つきはサーバーで先頭に足しなおす） */
  rules: Rule[];
};

/** 仮押さえ。サーバーがプログラムでもう一度判定してから出す。残すのは画面（ブラウザ）の側 */
export type HoldOffer = {
  id: string;
  customerId: string;
  menuId: string;
  date: string;
  start: string;
  heldAt: string;
  expiresAt: string;
  /** 承認の箱に出す理由（1文） */
  reason: string;
};

/** 手順の1行。tool = 道具で調べた / reject = ルール・店の設定で外した / hold = 仮押さえした / limit = 上限で止めた */
export type Step = { kind: "tool" | "reject" | "hold" | "limit"; text: string };

export type ReserveEvent =
  | { t: "text"; d: string }
  | { t: "step"; step: Step }
  | { t: "candidates"; list: Candidate[] }
  | { t: "hold"; hold: HoldOffer }
  | { t: "error"; code: "no-ai" | "bad-request"; message: string }
  | { t: "done" };

export const NO_AI_MESSAGE = "今は AI につながりません";

/** サーバーから来た仮押さえを、形を確かめてから受け取る */
export function parseHoldOffer(x: unknown): HoldOffer | null {
  if (!x || typeof x !== "object") return null;
  const h = x as Record<string, unknown>;
  const str = (k: string) => (typeof h[k] === "string" ? (h[k] as string) : null);
  const id = str("id");
  const customerId = str("customerId");
  const menuId = str("menuId");
  const date = str("date");
  const start = str("start");
  const heldAt = str("heldAt");
  const expiresAt = str("expiresAt");
  const reason = str("reason");
  if (!id || !customerId || !menuId || !date || !start || !heldAt || !expiresAt || reason === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start)) return null;
  return { id, customerId, menuId, date, start, heldAt, expiresAt, reason: reason.slice(0, 200) };
}
