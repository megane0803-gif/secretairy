// カルテの案を、保存の前に人が見出しごとに直す（docs/SPEC.md §1.5）。AI は使わない。
// 直した見出しには印（edited）を付け、「元に戻す」で AI の案（aiSections）に戻せる。
// 🔒 人が書いた行は言葉の門を通さない（人の記録なので）。直していない見出しの AI の行は、保存の直前にもう一度門を通す。
// 保存したカルテも、後から見出しごとに人が直せる（withSavedKarteEdited）。直した日時と「人が直した」を残す。
// 次回提案を直した時は、同じ鍵（カルテ:番号）の ToDo を足さずに文だけ書きかえる（済みの ToDo は触らない）。

import type { AddedTodo, BookState } from "../book/state";
import type { KarteHeading, KarteEditSettings } from "../settings";
import { karteKey, todoKey } from "../todo/keys";
import { cleanSections, headingWithRole, type KarteSections } from "./format";
import { gateKarte, type GateRemoved } from "./gate";
import { nextTalkTitle } from "./record";

/** 直せる案の形（deskStore の DeskDraft と同じ物を持つ） */
export type EditableDraft = {
  sections: KarteSections;
  /** AI（または決まった返事）が作った元の案。直す前は無い（sections と同じ） */
  aiSections?: KarteSections;
  /** 人が直した見出しの id */
  edited?: string[];
};

const BULLET = /^[・\-*•●○◯■\s]+/;

/** 人が打った文を行にする（頭の「・」を外す・空の行は捨てる・行の数と字数の上限） */
export function humanLines(text: string, limits: KarteEditSettings): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => [...l.replace(BULLET, "").replace(/\s+/g, " ").trim()].slice(0, limits.maxLineChars).join(""))
    .filter((l) => l.length > 0)
    .slice(0, limits.maxLines);
}

/** 画面の入力欄に出す文（1行ずつ） */
export function linesText(lines: string[]): string {
  return lines.join("\n");
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** 見出し1つを人が直す。AI の案と同じに戻ったら印を外す */
export function withHumanEdit<D extends EditableDraft>(draft: D, headingId: string, text: string, limits: KarteEditSettings): D {
  const ai = draft.aiSections ?? draft.sections;
  const lines = humanLines(text, limits);
  const edited = new Set(draft.edited ?? []);
  if (same(lines, ai[headingId] ?? [])) edited.delete(headingId);
  else edited.add(headingId);
  return { ...draft, aiSections: ai, sections: { ...draft.sections, [headingId]: lines }, edited: [...edited] };
}

/** 「元に戻す」：その見出しを AI の案に戻す */
export function withReverted<D extends EditableDraft>(draft: D, headingId: string): D {
  if (!draft.aiSections) return draft;
  return {
    ...draft,
    sections: { ...draft.sections, [headingId]: [...(draft.aiSections[headingId] ?? [])] },
    edited: (draft.edited ?? []).filter((id) => id !== headingId),
  };
}

/** 人が直した見出しか */
export function isEdited(draft: EditableDraft, headingId: string): boolean {
  return (draft.edited ?? []).includes(headingId);
}

/** 人が直した見出しの名前（日誌・画面に出す） */
export function editedLabels(draft: EditableDraft, headings: KarteHeading[]): string[] {
  return headings.filter((h) => isEdited(draft, h.id)).map((h) => h.label);
}

/**
 * 保存する中身。直していない見出しは言葉の門にもう一度通し（AI の行）、人が直した見出しはそのまま（門を通さない）。
 * edited は、保存したカルテに残す「人が直した見出し」の id。
 */
export function sectionsToSave(
  draft: EditableDraft,
  memo: string,
  headings: KarteHeading[],
): { sections: KarteSections; removed: GateRemoved[]; edited: string[] } {
  const clean = cleanSections(draft.sections, headings);
  const edited = headings.filter((h) => isEdited(draft, h.id)).map((h) => h.id);
  const aiOnly: KarteSections = { ...clean };
  for (const id of edited) aiOnly[id] = [];
  const gated = gateKarte(aiOnly, memo, headings);
  const sections: KarteSections = { ...gated.sections };
  for (const id of edited) sections[id] = clean[id] ?? [];
  return { sections, removed: gated.removed, edited };
}

export type SavedEditOutcome =
  | {
      ok: true;
      state: BookState;
      /** 中身が変わった（同じ中身なら何もしない） */
      changed: boolean;
      /** 次回提案を直した時の ToDo：updated = 文を書きかえた / done = 済みなので触らない / none = 同じ鍵の ToDo が無い（足さない）/ empty = 次回提案が空になったので文は変えない */
      todo: "updated" | "done" | "none" | "empty" | null;
      title?: string;
    }
  | { ok: false; state: BookState; reason: string };

/**
 * 🔒 人のボタン（「決める」）から呼ぶ：保存したカルテの見出し1つを人が直す（門は通さない。人の記録）。
 * 直した見出しに印（edited）と日時（editedAt）を残す。次回提案なら、同じ鍵の ToDo の文だけ書きかえる（足さない・済みは触らない）。
 */
export function withSavedKarteEdited(
  s: BookState,
  karteId: string,
  headingId: string,
  text: string,
  o: { limits: KarteEditSettings; headings: KarteHeading[]; surname: string; nowIso: string },
): SavedEditOutcome {
  const k = s.kartes.find((x) => x.id === karteId);
  if (!k) return { ok: false, state: s, reason: "保存したカルテが見つかりません（最初の状態のカルテは直せません）" };
  if (!o.headings.some((h) => h.id === headingId)) return { ok: false, state: s, reason: "知らない見出しです" };
  const lines = humanLines(text, o.limits);
  if (same(lines, k.sections[headingId] ?? [])) return { ok: true, state: s, changed: false, todo: null };
  const edited = [...new Set([...(k.edited ?? []), headingId])];
  const next = { ...k, sections: { ...k.sections, [headingId]: lines }, edited, editedAt: { ...(k.editedAt ?? {}), [headingId]: o.nowIso } };
  let state: BookState = { ...s, kartes: s.kartes.map((x) => (x.id === karteId ? next : x)) };
  if (headingWithRole(o.headings, "next")?.id !== headingId) return { ok: true, state, changed: true, todo: null };
  const key = karteKey(k.id);
  const t = state.todos.find((x: AddedTodo) => todoKey(x) === key);
  if (!t) return { ok: true, state, changed: true, todo: "none" };
  if (t.done) return { ok: true, state, changed: true, todo: "done" };
  const title = nextTalkTitle(next, o.surname, o.headings);
  if (!title) return { ok: true, state, changed: true, todo: "empty" };
  state = { ...state, todos: state.todos.map((x) => (x.id === t.id ? { ...x, title } : x)) };
  return { ok: true, state, changed: true, todo: "updated", title };
}
