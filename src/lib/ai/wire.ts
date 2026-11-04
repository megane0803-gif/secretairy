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

/** 予約の候補。お客様に「1つ目」「2つ目」と番号で出す。1回の来店で複数のメニューなら menuId は「cut+headspa」の形（combo.ts） */
export type Candidate = {
  menuId: string;
  date: string;
  start: string;
};

/** 前回までの来店（カルテから）。「前回を見る」はこれのいちばん新しい物を返す */
export type Visit = {
  customerId: string;
  /** YYYY-MM-DD */
  date: string;
  menuId: string;
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
  /** そのお客様のカルテ（最初の状態＋保存した物）の日付とメニュー。「前回を見る」に使う */
  visits: Visit[];
  /** デモの「翌日へ」で進めた営業日の数（0 = 本当の今日） */
  dayOffset: number;
  /** この会話で作った仮押さえの id（「仮押さえを外す」はこの中の、まだ承認待ちの物だけ） */
  holds: string[];
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

/**
 * 手順の1行。tool = 道具で調べた / reject = ルール・店の設定で外した / hold = 仮押さえした / limit = 上限で止めた
 * ask = プログラムが聞き返した（日付の食い違い） / release = 仮押さえを外した / todo = ToDo に足した
 */
export type Step = { kind: "tool" | "reject" | "hold" | "limit" | "ask" | "release" | "todo"; text: string };

/** 別の用事で「お店に確かめてご連絡します」と言ったときに、プログラムが足す ToDo */
export type TodoOffer = { id: string; title: string };

export type ReserveEvent =
  | { t: "text"; d: string }
  | { t: "step"; step: Step }
  | { t: "candidates"; list: Candidate[] }
  | { t: "hold"; hold: HoldOffer }
  | { t: "release"; holdId: string }
  | { t: "todo"; todo: TodoOffer }
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
