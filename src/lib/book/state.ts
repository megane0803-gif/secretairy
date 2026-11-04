// 予約チャットから入った予約・承認の箱・足した ToDo を、見ている人のブラウザの中だけに残す形（docs/SPEC.md §5.1）。
// ここは形と変え方だけ（どこにも書かない）。書くのは useBook.ts。
//
// 起点（anchor）：そのブラウザで初めて開いた日。最初の状態の予約（何番目の営業日）はこの日から数える。
// 「最初に戻す」を押すと、今日を起点に作り直す。
//
// 🔒 確定は人：確定（approve）を呼ぶのは画面の「承認」ボタンだけ（ApprovalBox.tsx）。
// AI・サーバー・自動の処理からは呼ばない。サーバーが出せるのは仮押さえ（HoldOffer）まで。

import type { HoldOffer } from "../ai/wire";
import type { ChatReservation } from "../reservations";

export type ApprovalState = "pending" | "approved" | "fixed" | "skipped";

/** 承認の箱の1行（予約の仮押さえ） */
export type ReservationApproval = {
  id: string;
  reservationId: string;
  createdAt: string;
  /** 理由（1文） */
  reason: string;
  state: ApprovalState;
  decidedAt?: string;
};

/** 承認の箱から足した ToDo */
export type AddedTodo = {
  id: string;
  title: string;
  createdAt: string;
  done: boolean;
  /** いつまで（YYYY-MM-DD）。無ければ決めていない */
  due?: string;
};

export type BookState = {
  v: 1;
  /** 起点の日（YYYY-MM-DD） */
  anchor: string;
  chat: ChatReservation[];
  approvals: ReservationApproval[];
  todos: AddedTodo[];
};

export function emptyBook(anchor: string): BookState {
  return { v: 1, anchor, chat: [], approvals: [], todos: [] };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const isStr = (x: unknown): x is string => typeof x === "string";

/** ブラウザに残っていた文字を読む。形のおかしい物は落とす。無ければ null（まだ一度も開いていない） */
export function parseBook(raw: string | null): BookState | null {
  if (!raw) return null;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!d || typeof d !== "object" || !isStr(d.anchor) || !DATE.test(d.anchor)) return null;
  const arr = (x: unknown) => (Array.isArray(x) ? (x as Record<string, unknown>[]) : []);
  const chat: ChatReservation[] = arr(d.chat)
    .filter(
      (r) =>
        r &&
        isStr(r.id) &&
        isStr(r.customerId) &&
        isStr(r.menuId) &&
        isStr(r.date) &&
        DATE.test(r.date) &&
        isStr(r.start) &&
        TIME.test(r.start) &&
        (r.status === "hold" || r.status === "confirmed") &&
        isStr(r.heldAt) &&
        isStr(r.expiresAt),
    )
    .map((r) => ({
      id: r.id as string,
      customerId: r.customerId as string,
      menuId: r.menuId as string,
      date: r.date as string,
      start: r.start as string,
      status: r.status as ChatReservation["status"],
      heldAt: r.heldAt as string,
      expiresAt: r.expiresAt as string,
    }));
  const states: ApprovalState[] = ["pending", "approved", "fixed", "skipped"];
  const approvals: ReservationApproval[] = arr(d.approvals)
    .filter((a) => a && isStr(a.id) && isStr(a.reservationId) && isStr(a.createdAt) && isStr(a.reason) && states.includes(a.state as ApprovalState))
    .map((a) => ({
      id: a.id as string,
      reservationId: a.reservationId as string,
      createdAt: a.createdAt as string,
      reason: a.reason as string,
      state: a.state as ApprovalState,
      ...(isStr(a.decidedAt) ? { decidedAt: a.decidedAt } : {}),
    }));
  const todos: AddedTodo[] = arr(d.todos)
    .filter((t) => t && isStr(t.id) && isStr(t.title) && isStr(t.createdAt))
    .map((t) => ({
      id: t.id as string,
      title: t.title as string,
      createdAt: t.createdAt as string,
      done: t.done === true,
      ...(isStr(t.due) && DATE.test(t.due) ? { due: t.due } : {}),
    }));
  return { v: 1, anchor: d.anchor, chat, approvals, todos };
}

/** 期限が過ぎた仮押さえか（承認を待っている間に holdExpiresHours を過ぎた） */
export function isExpired(r: ChatReservation, nowIso: string): boolean {
  return r.status === "hold" && r.expiresAt <= nowIso;
}

/** 台帳に出す、予約チャットからの予約（確定と、期限の切れていない仮押さえ） */
export function activeChat(s: BookState, nowIso: string): ChatReservation[] {
  return s.chat.filter((r) => !isExpired(r, nowIso));
}

export type PendingRow = { approval: ReservationApproval; reservation: ChatReservation };

/** 承認待ちの行（古い順）。期限の切れた仮押さえは出さない */
export function pendingApprovals(s: BookState, nowIso: string): PendingRow[] {
  const out: PendingRow[] = [];
  for (const a of s.approvals) {
    if (a.state !== "pending") continue;
    const r = s.chat.find((x) => x.id === a.reservationId);
    if (r && r.status === "hold" && !isExpired(r, nowIso)) out.push({ approval: a, reservation: r });
  }
  return out;
}

/** 仮押さえを足して、承認の箱に1行入れる（同じ仮押さえは2回入れない） */
export function withHold(s: BookState, h: HoldOffer): BookState {
  if (s.chat.some((r) => r.id === h.id)) return s;
  return {
    ...s,
    chat: [
      ...s.chat,
      {
        id: h.id,
        customerId: h.customerId,
        menuId: h.menuId,
        date: h.date,
        start: h.start,
        status: "hold",
        heldAt: h.heldAt,
        expiresAt: h.expiresAt,
      },
    ],
    approvals: [
      ...s.approvals,
      { id: `ap-${h.id}`, reservationId: h.id, createdAt: h.heldAt, reason: h.reason, state: "pending" },
    ],
  };
}

/**
 * 🔒 承認：仮押さえを確定にして台帳に入れる。
 * 呼んでよいのは、人が画面の「承認」ボタンを押したときだけ（ApprovalBox.tsx が押した事を確かめてから呼ぶ）。
 */
export function withApproved(s: BookState, approvalId: string, nowIso: string): BookState {
  const a = s.approvals.find((x) => x.id === approvalId && x.state === "pending");
  if (!a) return s;
  return {
    ...s,
    chat: s.chat.map((r) => (r.id === a.reservationId && r.status === "hold" ? { ...r, status: "confirmed" } : r)),
    approvals: s.approvals.map((x) => (x.id === approvalId ? { ...x, state: "approved", decidedAt: nowIso } : x)),
  };
}

/**
 * 直す・見送り：お客様の了解なしに時間は変えないので、仮押さえを外し、
 * 「○○（架空）様に別の日時を案内」を ToDo に足す（AI は使わない）。
 */
export function withReleased(
  s: BookState,
  approvalId: string,
  how: "fixed" | "skipped",
  surname: string,
  nowIso: string,
): BookState {
  const a = s.approvals.find((x) => x.id === approvalId && x.state === "pending");
  if (!a) return s;
  const todo: AddedTodo = {
    id: `td-${a.reservationId}`,
    title: `${surname}（架空）様に別の日時を案内`,
    createdAt: nowIso,
    done: false,
  };
  return {
    ...s,
    chat: s.chat.filter((r) => r.id !== a.reservationId),
    approvals: s.approvals.map((x) => (x.id === approvalId ? { ...x, state: how, decidedAt: nowIso } : x)),
    todos: s.todos.some((t) => t.id === todo.id) ? s.todos : [...s.todos, todo],
  };
}

export function withTodoDone(s: BookState, todoId: string, done: boolean): BookState {
  return { ...s, todos: s.todos.map((t) => (t.id === todoId ? { ...t, done } : t)) };
}

/** ToDo を1件足す（同じ id の物は2回入れない）。広告の承認から「効いたか見る」を足すときなど */
export function withTodo(s: BookState, todo: AddedTodo): BookState {
  if (s.todos.some((t) => t.id === todo.id)) return s;
  return { ...s, todos: [...s.todos, todo] };
}
