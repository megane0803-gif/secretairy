// お客様ごとのカルテ（最初の状態の「前回までのカルテ」と、画面で人が保存した物）。
// 保存は人のボタン（「保存」）だけ。保存すると、そのお客様の記録に入り、
// 「次回提案」の1行目を ToDo の「次回話すこと」に1件だけ足す（同じ物があれば足さない）。
// 保存したメモは、その日はもう直さない。AI は使わない。

import type { BookState, AddedTodo } from "../book/state";
import type { SeedKarte } from "../data/types";
import type { Reservation } from "../reservations";
import type { KarteHeading } from "../settings";
import type { Visit } from "../ai/wire";
import { headingWithRole, type KarteSections } from "./format";
import { karteKey } from "../todo/keys";

/** 人が「保存」を押したカルテ。ブラウザの中だけに残す（secretairy:book の kartes） */
export type SavedKarte = {
  id: string;
  customerId: string;
  /** その日（YYYY-MM-DD） */
  date: string;
  menuId: string;
  reservationId?: string;
  memo: string;
  sections: KarteSections;
  /** 保存した時刻（ISO） */
  savedAt: string;
};

export type KarteRecord = Omit<SavedKarte, "memo" | "savedAt"> & {
  memo?: string;
  savedAt?: string;
  /** seed = 最初の状態（前回までのカルテ）/ saved = 人が保存した */
  source: "seed" | "saved";
};

/** 最初の状態のカルテに、予約（前回の来店）の日付・メニュー・お客様を入れる。予約の無い物は使わない */
export function resolveSeedKartes(seed: SeedKarte[], reservations: Reservation[]): KarteRecord[] {
  const out: KarteRecord[] = [];
  for (const k of seed) {
    const r = reservations.find((x) => x.id === k.reservationId);
    if (!r) continue;
    out.push({
      id: k.id,
      customerId: r.customer.id,
      date: r.date,
      menuId: r.menu.id,
      reservationId: r.id,
      sections: k.sections,
      source: "seed",
    });
  }
  return out;
}

/** 新しい順（日付 → 保存した時刻） */
export function sortKartes(list: KarteRecord[]): KarteRecord[] {
  return [...list].sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? 1 : -1) : (b.savedAt ?? "").localeCompare(a.savedAt ?? ""),
  );
}

/** 最初の状態のカルテと、保存したカルテを合わせる（新しい順） */
export function allKartes(seed: KarteRecord[], saved: SavedKarte[]): KarteRecord[] {
  return sortKartes([...seed, ...saved.map((k) => ({ ...k, source: "saved" as const }))]);
}

/** そのお客様のカルテ（新しい順） */
export function kartesOf(list: KarteRecord[], customerId: string): KarteRecord[] {
  return sortKartes(list.filter((k) => k.customerId === customerId));
}

/** その日にもう保存したカルテ（あれば、その日はもう直さない） */
export function savedOn(saved: SavedKarte[], customerId: string, date: string): SavedKarte | undefined {
  return saved.find((k) => k.customerId === customerId && k.date === date);
}

/** その日より前の、いちばん新しいカルテ（朝の要点の「前回メモ」） */
export function latestBefore(list: KarteRecord[], customerId: string, date: string): KarteRecord | undefined {
  return kartesOf(list, customerId).find((k) => k.date < date);
}

/** 予約チャットの「前回を見る」に送る形（日付とメニューだけ。中身は送らない） */
export function toVisits(list: KarteRecord[], customerId?: string): Visit[] {
  return list
    .filter((k) => !customerId || k.customerId === customerId)
    .map((k) => ({ customerId: k.customerId, date: k.date, menuId: k.menuId }));
}

/** 次回提案の行 */
export function nextLines(k: Pick<KarteRecord, "sections">, headings: KarteHeading[]): string[] {
  const h = headingWithRole(headings, "next");
  return h ? (k.sections[h.id] ?? []) : [];
}

/** ToDo「次回話すこと」の1件（次回提案の1行目。2行目からは「（ほかN行はカルテに）」）。次回提案が空なら null */
export function nextTalkTitle(k: Pick<KarteRecord, "sections">, surname: string, headings: KarteHeading[]): string | null {
  const lines = nextLines(k, headings);
  if (lines.length === 0) return null;
  const rest = lines.length - 1;
  return `${surname}（架空）様：${lines[0]}${rest > 0 ? `（ほか${rest}行はカルテに）` : ""}`;
}

export type SaveOutcome =
  | { ok: true; state: BookState; todo: AddedTodo | null; todoSkipped: "none" | "same" | null }
  | { ok: false; state: BookState; reason: string };

/**
 * 🔒 人の「保存」ボタンから呼ぶ。そのお客様の記録に入れ、ToDo「次回話すこと」に1件だけ足す。
 * 同じお客様・同じ日にもう保存していれば保存しない（その日はもう直さない）。
 * 同じ題の ToDo（まだ済んでいない物）があれば足さない。
 */
export function withKarteSaved(s: BookState, k: SavedKarte, surname: string, headings: KarteHeading[]): SaveOutcome {
  if (savedOn(s.kartes, k.customerId, k.date))
    return { ok: false, state: s, reason: "この日のカルテはもう保存しています（その日はもう直しません）" };
  const next: BookState = { ...s, kartes: [...s.kartes, k] };
  const title = nextTalkTitle(k, surname, headings);
  if (!title) return { ok: true, state: next, todo: null, todoSkipped: "none" };
  if (s.todos.some((t) => !t.done && t.title === title)) return { ok: true, state: next, todo: null, todoSkipped: "same" };
  const todo: AddedTodo = { id: `td-next-${k.id}`, title, createdAt: k.savedAt, done: false, kind: "next-talk", source: "karte", key: karteKey(k.id) };
  return { ok: true, state: { ...next, todos: [...next.todos, todo] }, todo, todoSkipped: null };
}
