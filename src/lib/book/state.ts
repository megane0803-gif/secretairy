// 予約チャットから入った予約・承認の箱・足した ToDo を、見ている人のブラウザの中だけに残す形（docs/SPEC.md §5.1）。
// ここは形と変え方だけ（どこにも書かない）。書くのは useBook.ts。
//
// 起点（anchor）：そのブラウザで初めて開いた日。最初の状態の予約（何番目の営業日）はこの日から数える。
// 「最初に戻す」を押すと、今日を起点に作り直す。
//
// 🔒 確定は人：確定（approve）を呼ぶのは画面の「承認」ボタンだけ（ApprovalBox.tsx）。
// AI・サーバー・自動の処理からは呼ばない。サーバーが出せるのは仮押さえ（HoldOffer）まで。

import type { HoldOffer, TodoOffer } from "../ai/wire";
import { MAX_DAY_OFFSET } from "../calendar";
import type { SavedKarte } from "../karte/record";
import type { ChatReservation } from "../reservations";
import { getSavedMemoMaxChars } from "../settings";
import { rescheduleTodo } from "../todo/reschedule";
import { isGuestTitle, withoutOldMark } from "../guestName";
import { chatKey, SEED_TODO_KEYS, todoKey, TODO_SOURCES, type TodoSource } from "../todo/keys";
import { readMemoKind, type MemoKind } from "../todo/kinds";

/**
 * withdrawn = お客様が予約チャットで「ずらしたい」「やめたい」と言ったので、承認の前に外した
 * taken = 予約サイトから同じ枠に予約が入ったので、承認の前に外した（二重予約を防ぐ。book/site.ts）
 */
export type ApprovalState = "pending" | "approved" | "fixed" | "skipped" | "withdrawn" | "taken";

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

/** 承認の箱・カルテの保存から足した ToDo。next-talk = カルテの「次回話すこと」 */
export type AddedTodo = {
  id: string;
  title: string;
  createdAt: string;
  done: boolean;
  kind?: "next-talk";
  /** いつまで（YYYY-MM-DD）。無ければ決めていない（広告の「効いたか見る」など） */
  due?: string;
  /** 同じ物を2回足さないための鍵（メモ:番号・カルテ:番号・語句:番号・予約:お客様＠日時 など。src/lib/todo/keys.ts） */
  key?: string;
  /** どこから入ったか（無ければ id の頭から出す） */
  source?: TodoSource;
  /** 投げたメモの元の文（プログラムがそのまましまう。行の印を押すと開く） */
  memo?: string;
  /** 投げたメモで、送る時にオーナーが選んだ種類（お客様・仕入れと材料・お店のこと・お金と事務。src/lib/todo/kinds.ts）。無ければ その他 */
  category?: MemoKind;
  /** 済みにした時（「済み」のタブで新しい順に並べる） */
  doneAt?: string;
};

/** 最初の状態の ToDo（seed/todo.json）を済みにした・戻した印（id ごと） */
export type TodoMark = { done: boolean; at: string };

/**
 * 最初の状態のカルテ（seed/kartes.json）を人が直した分（カルテの id ごと）。最初の中身に重ねて読む（record.ts の withSeedKarteEdits）。
 * sections は直した見出しの行だけ・edited は直した見出し・editedAt は直した日時。「最初に戻す」で消え、最初の中身に戻る
 */
export type SeedKarteEdit = { sections: Record<string, string[]>; edited: string[]; editedAt: Record<string, string> };

export type BookState = {
  v: 1;
  /** 起点の日（YYYY-MM-DD） */
  anchor: string;
  chat: ChatReservation[];
  approvals: ReservationApproval[];
  todos: AddedTodo[];
  /** 人が「保存」を押したカルテ */
  kartes: SavedKarte[];
  /** デモの「翌日へ」で進めた営業日の数（「最初に戻す」で 0 に戻る） */
  dayOffset: number;
  /** 最初の状態の ToDo を済みにした・戻した印（「最初に戻す」で消える） */
  todoMarks?: Record<string, TodoMark>;
  /** 最初の状態のカルテを人が直した分（「最初に戻す」で消える） */
  seedKarteEdits?: Record<string, SeedKarteEdit>;
  /** 最初の状態の ToDo の文を書きかえた分（最初の状態のカルテの次回提案を直した時。id ごと。「最初に戻す」で消える） */
  todoTitles?: Record<string, string>;
  /**
   * 「最初に戻す」のたびに変わる印（reset.ts が作る）。戻す前に始まった予約チャットの返事が、戻した後の台帳に入らないように、
   * 返事を始めた時の印と今の印が同じ時だけ仮押さえを入れる（sameEpoch）。無い = まだ一度も戻していない
   */
  epoch?: string;
};

export function emptyBook(anchor: string, epoch?: string): BookState {
  return { v: 1, anchor, chat: [], approvals: [], todos: [], kartes: [], dayOffset: 0, todoMarks: {}, ...(epoch ? { epoch } : {}) };
}

/** 「最初に戻す」の印を作る */
export function newEpoch(nowMs: number = Date.now()): string {
  return `r-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 台帳が、その印の時のままか（あいだに「最初に戻す」が無かったか） */
export function sameEpoch(s: Pick<BookState, "epoch">, epoch: string | undefined): boolean {
  return (s.epoch ?? "") === (epoch ?? "");
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
      // 予約サイトから入った予約（確定だけ。book/site.ts）
      ...(r.via === "site" && r.status === "confirmed" ? { via: "site" as const } : {}),
    }));
  const states: ApprovalState[] = ["pending", "approved", "fixed", "skipped", "withdrawn", "taken"];
  const approvals: ReservationApproval[] = arr(d.approvals)
    .filter((a) => a && isStr(a.id) && isStr(a.reservationId) && isStr(a.createdAt) && isStr(a.reason) && states.includes(a.state as ApprovalState))
    .map((a) => ({
      id: a.id as string,
      reservationId: a.reservationId as string,
      createdAt: a.createdAt as string,
      reason: withoutOldMark(a.reason as string),
      state: a.state as ApprovalState,
      ...(isStr(a.decidedAt) ? { decidedAt: a.decidedAt } : {}),
    }));
  const todos: AddedTodo[] = arr(d.todos)
    .filter((t) => t && isStr(t.id) && isStr(t.title) && isStr(t.createdAt))
    .map((t) => ({
      id: t.id as string,
      // 前の書き方（「○○（架空）様」）で残った題も、今の書き方で読む（src/lib/guestName.ts）
      title: withoutOldMark(t.title as string),
      createdAt: t.createdAt as string,
      done: t.done === true,
      ...(isStr(t.due) && DATE.test(t.due) ? { due: t.due } : {}),
      ...(t.kind === "next-talk" ? { kind: "next-talk" as const } : {}),
      ...(isStr(t.key) && t.key.length <= 120 ? { key: t.key } : {}),
      ...(TODO_SOURCES.includes(t.source as TodoSource) ? { source: t.source as TodoSource } : {}),
      ...(isStr(t.memo) ? { memo: t.memo.slice(0, 400) } : {}),
      ...(readMemoKind(t.category) ? { category: readMemoKind(t.category) } : {}),
      ...(isStr(t.doneAt) ? { doneAt: t.doneAt } : {}),
    }));
  const todoMarks: Record<string, TodoMark> = {};
  if (d.todoMarks && typeof d.todoMarks === "object" && !Array.isArray(d.todoMarks))
    for (const [id, m] of Object.entries(d.todoMarks as Record<string, unknown>)) {
      const mark = m as Record<string, unknown> | null;
      if (mark && typeof mark === "object" && typeof mark.done === "boolean" && isStr(mark.at)) todoMarks[id.slice(0, 60)] = { done: mark.done, at: mark.at };
    }
  const kartes: SavedKarte[] = arr(d.kartes)
    .filter(
      (k) =>
        k &&
        isStr(k.id) &&
        isStr(k.customerId) &&
        isStr(k.date) &&
        DATE.test(k.date) &&
        isStr(k.menuId) &&
        isStr(k.memo) &&
        isStr(k.savedAt) &&
        k.sections !== null &&
        typeof k.sections === "object",
    )
    .map((k) => ({
      id: k.id as string,
      customerId: k.customerId as string,
      date: k.date as string,
      menuId: k.menuId as string,
      ...(isStr(k.reservationId) ? { reservationId: k.reservationId } : {}),
      // 入力できる上限（録音の要点は config/ai.json の karte.maxRecordingMemoChars）にそろえる。字は1文字ずつ数える（入力欄と同じ）
      memo: [...(k.memo as string)].slice(0, getSavedMemoMaxChars()).join(""),
      sections: looseSections(k.sections),
      savedAt: k.savedAt as string,
      ...(Array.isArray(k.edited) ? { edited: k.edited.filter(isStr).slice(0, 20) } : {}),
      ...(k.editedAt && typeof k.editedAt === "object" && !Array.isArray(k.editedAt)
        ? { editedAt: Object.fromEntries(Object.entries(k.editedAt as Record<string, unknown>).filter((e): e is [string, string] => isStr(e[1])).slice(0, 20)) }
        : {}),
    }));
  const off = d.dayOffset;
  const dayOffset = typeof off === "number" && Number.isInteger(off) && off > 0 ? Math.min(off, MAX_DAY_OFFSET) : 0;
  const seedKarteEdits: Record<string, SeedKarteEdit> = {};
  if (d.seedKarteEdits && typeof d.seedKarteEdits === "object" && !Array.isArray(d.seedKarteEdits))
    for (const [id, x] of Object.entries(d.seedKarteEdits as Record<string, unknown>).slice(0, 200)) {
      const e = x as Record<string, unknown> | null;
      if (!e || typeof e !== "object" || !e.sections || typeof e.sections !== "object") continue;
      const edited = Array.isArray(e.edited) ? e.edited.filter(isStr).slice(0, 20) : [];
      const editedAt =
        e.editedAt && typeof e.editedAt === "object" && !Array.isArray(e.editedAt)
          ? Object.fromEntries(Object.entries(e.editedAt as Record<string, unknown>).filter((p): p is [string, string] => isStr(p[1])).slice(0, 20))
          : {};
      seedKarteEdits[id.slice(0, 60)] = { sections: looseSections(e.sections), edited, editedAt };
    }
  const todoTitles: Record<string, string> = {};
  if (d.todoTitles && typeof d.todoTitles === "object" && !Array.isArray(d.todoTitles))
    for (const [id, t] of Object.entries(d.todoTitles as Record<string, unknown>).slice(0, 200)) if (isStr(t) && t.trim()) todoTitles[id.slice(0, 60)] = withoutOldMark(t).slice(0, 200);
  return {
    v: 1,
    anchor: d.anchor,
    chat,
    approvals,
    todos,
    kartes,
    dayOffset,
    todoMarks,
    // 直した分があるときだけ持つ（無ければ今までと同じ形）
    ...(Object.keys(seedKarteEdits).length ? { seedKarteEdits } : {}),
    ...(isStr(d.epoch) && d.epoch.length <= 40 ? { epoch: d.epoch } : {}),
    ...(Object.keys(todoTitles).length ? { todoTitles } : {}),
  };
}

/** 見出しの id ごとの行（文字の並び）だけを残す。見出しが設定にあるかは画面で読むときに確かめる */
function looseSections(x: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(x as Record<string, unknown>))
    if (Array.isArray(v)) out[k] = v.filter(isStr).slice(0, 20);
  return out;
}

/** デモの「翌日へ」：今日を1営業日先へ（定休日は飛ばす）。「最初に戻す」で戻る */
export function withNextDay(s: BookState): BookState {
  return { ...s, dayOffset: Math.min(MAX_DAY_OFFSET, s.dayOffset + 1) };
}

/** 「翌日へ」の上限（MAX_DAY_OFFSET 営業日）に来た時の1文 */
export const LAST_DEMO_DAY = "デモで進められるのはここまでです";

/** まだ「翌日へ」で進められるか（上限に来たらボタンを押せなくする） */
export function canNextDay(s: Pick<BookState, "dayOffset">): boolean {
  return s.dayOffset < MAX_DAY_OFFSET;
}

/** 「翌日へ」を1回：進んだかもいっしょに返す（進まなかった時は、日誌・前日のお知らせを作らない） */
export function nextDayStep(s: BookState): { state: BookState; moved: boolean } {
  if (!canNextDay(s)) return { state: s, moved: false };
  return { state: withNextDay(s), moved: true };
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

/**
 * 同じお客様・同じメニュー・同じ日時の、まだ承認待ちの仮押さえ。期限の切れた物は数えない。
 * 予約チャットで返事が途中で切れて送り直した時に、2つにしないために使う（ai/reserveStream.ts の holdInto）
 */
export function sameHold(s: BookState, h: Pick<HoldOffer, "customerId" | "menuId" | "date" | "start" | "heldAt">): ChatReservation | undefined {
  return s.chat.find(
    (r) => r.status === "hold" && r.customerId === h.customerId && r.menuId === h.menuId && r.date === h.date && r.start === h.start && !isExpired(r, h.heldAt),
  );
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
 * 「○○様に別の日時を案内（11/8（日） 15:00 カットの代わり）」を ToDo に足す（AI は使わない。todo/reschedule.ts）。
 */
export function withReleased(
  s: BookState,
  approvalId: string,
  how: "fixed" | "skipped",
  surname: string,
  nowIso: string,
  /** 今日（YYYY-MM-DD。「翌日へ」も入れた日）。あれば ToDo を「今日中」にする */
  today?: string,
): BookState {
  const a = s.approvals.find((x) => x.id === approvalId && x.state === "pending");
  if (!a) return s;
  const r = s.chat.find((x) => x.id === a.reservationId);
  // 文・鍵・期限は todo/reschedule.ts の1か所で（元の頼みの日時とメニューを添える。LINE のボタンもここを通る）
  const todo = rescheduleTodo({ idPrefix: "td", reservationId: a.reservationId, surname, from: r, nowIso, due: today });
  return {
    ...withTodo(s, todo),
    chat: s.chat.filter((r) => r.id !== a.reservationId),
    approvals: s.approvals.map((x) => (x.id === approvalId ? { ...x, state: how, decidedAt: nowIso } : x)),
  };
}

/**
 * お客様の頼みで、予約チャットの仮押さえを外す（「ずらしたい」「やめたい」）。
 * 外せるのは、そのお客様の、まだ承認待ちの仮押さえだけ（承認された予約・ほかの方の物は変えない）。
 * お客様が自分で取り下げたので、ToDo は足さない（新しい日時はチャットで出しなおす）。
 */
export function withGuestReleased(s: BookState, reservationId: string, customerId: string, nowIso: string): BookState {
  const r = s.chat.find((x) => x.id === reservationId && x.customerId === customerId && x.status === "hold");
  const a = s.approvals.find((x) => x.reservationId === reservationId && x.state === "pending");
  if (!r || !a) return s;
  return {
    ...s,
    chat: s.chat.filter((x) => x.id !== reservationId),
    approvals: s.approvals.map((x) => (x.id === a.id ? { ...x, state: "withdrawn", decidedAt: nowIso } : x)),
  };
}

/**
 * 予約チャットで「お店に確かめてご連絡します」と返したときの ToDo（プログラムが足す）と、日誌の1行。
 * 題は「○○様：用件の1行」の形の物だけ受け取る。同じ id は2回入れない。
 */
export function withChatTodo(
  s: BookState,
  todo: TodoOffer,
  surname: string,
  nowIso: string,
  /** 今日（YYYY-MM-DD）。あれば「お客様への連絡（今日中）」にする */
  today?: string,
): { state: BookState; journal: string | null } {
  const title = typeof todo?.title === "string" ? withoutOldMark(todo.title).replace(/\s+/g, " ").trim().slice(0, 80) : "";
  const id = typeof todo?.id === "string" ? todo.id.slice(0, 60) : "";
  if (!id || !isGuestTitle(title, surname)) return { state: s, journal: null };
  if (s.todos.some((t) => t.id === id)) return { state: s, journal: null };
  const added: AddedTodo = {
    id,
    title,
    createdAt: nowIso,
    done: false,
    source: "chat",
    key: chatKey(id.replace(/^td-chat-/, "")),
    ...(today && DATE.test(today) ? { due: today } : {}),
  };
  if (hasTodoKey(s, todoKey(added))) return { state: s, journal: null };
  return {
    state: withTodo(s, added),
    journal: `ToDo に足した（予約チャットで「お店に確かめてご連絡します」と返したため）：${title}`,
  };
}

export function withTodoDone(s: BookState, todoId: string, done: boolean, nowIso?: string): BookState {
  return {
    ...s,
    todos: s.todos.map((t) => {
      if (t.id !== todoId) return t;
      const next: AddedTodo = { ...t, done };
      if (done && nowIso) next.doneAt = nowIso;
      else delete next.doneAt;
      return next;
    }),
  };
}

/** その鍵の ToDo がもうあるか（足した物と、最初の状態の物。済んだ物も数える） */
export function hasTodoKey(s: BookState, key: string): boolean {
  return SEED_TODO_KEYS.has(key) || s.todos.some((t) => todoKey(t) === key);
}

/** ToDo を1件足す（同じ id・同じ鍵の物は2回入れない）。広告の承認から「効いたか見る」を足すときなど */
export function withTodo(s: BookState, todo: AddedTodo): BookState {
  if (s.todos.some((t) => t.id === todo.id)) return s;
  if (hasTodoKey(s, todoKey(todo))) return s;
  return { ...s, todos: [...s.todos, todo] };
}
