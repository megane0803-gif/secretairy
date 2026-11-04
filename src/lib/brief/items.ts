// 「AI の一言」に送る材料を作る・返ってきた印を日時とお名前に置きかえる（画面のプログラム。AI は使わない）。
// 材料：今日の予約（メニュー・初めての方・仮押さえ・前回のカルテの次回提案と注意点）・承認待ち・今日の ToDo。
// お客様の名前は〔お客様〕に置きかえて送る（名前は AI に送らない）。日時・お名前・数は印の札（label）にだけ入れ、
// 画面で fillMarks が置きかえる（Claude には書かせない）。

import type { ApprovalQueue } from "../approvals";
import type { Customer } from "../data/types";
import { headingWithRole } from "../karte/format";
import { latestBefore, nextLines, type KarteRecord } from "../karte/record";
import { maskNames } from "../line/sort";
import type { Reservation } from "../reservations";
import type { KarteHeading } from "../settings";
import { topTodos, type TodoItem } from "../todo/items";
import { MARK_RE, markFor, type BriefItem } from "./wire";

export type BriefMaterial = {
  items: BriefItem[];
  /** 印 → 画面に出す札（日時・お名前・メニュー。プログラムが入れる） */
  labels: Record<string, string>;
};

export type BriefInput = {
  today: string;
  todays: Reservation[];
  kartes: KarteRecord[];
  headings: KarteHeading[];
  approvals: ApprovalQueue;
  todos: TodoItem[];
  customers: Customer[];
  menuName: (id: string) => string;
  dayLabel: (date: string) => string;
  maxItems: number;
  maxItemChars: number;
};

const cut = (s: string, n: number) => [...s].slice(0, n).join("");

export function briefMaterial(i: BriefInput): BriefMaterial {
  const items: BriefItem[] = [];
  const labels: Record<string, string> = {};
  const mask = (t: string) => maskNames(t, i.customers).masked;
  const add = (kind: BriefItem["kind"], n: number, text: string, label: string) => {
    if (items.length >= i.maxItems) return;
    const mark = markFor(kind, n);
    items.push({ mark, kind, text: cut(mask(text), i.maxItemChars) });
    labels[mark] = label;
  };
  const notesHeading = i.headings.find((h) => h.id === "notes") ?? null;
  const nextHeading = headingWithRole(i.headings, "next");

  [...i.todays]
    .sort((a, b) => a.startMin - b.startMin)
    .forEach((r, n) => {
      const prev = latestBefore(i.kartes, r.customer.id, i.today);
      const parts = [`メニュー：${r.menu.name}`];
      if (r.customer.firstVisit) parts.push("初めての方");
      if (r.status === "hold") parts.push("仮押さえ（承認待ち）");
      if (prev && nextHeading) {
        const next = nextLines(prev, i.headings);
        if (next.length) parts.push(`前回の次回提案：${next.join("／")}`);
      }
      if (prev && notesHeading) {
        const notes = prev.sections[notesHeading.id] ?? [];
        if (notes.length) parts.push(`前回の注意点：${notes.join("／")}`);
      }
      if (!prev) parts.push("前回の記録なし");
      add("reservation", n + 1, parts.join("。"), `${r.start} ${r.customer.surname}（架空）様 ${r.menu.name}`);
    });

  let a = 0;
  for (const row of i.approvals.reservations) {
    const c = i.customers.find((x) => x.id === row.reservation.customerId);
    const who = c ? `${c.surname}（架空）様` : "お客様（架空）";
    a += 1;
    add(
      "approval",
      a,
      `予約の仮押さえ。メニュー：${i.menuName(row.reservation.menuId)}`,
      `承認待ち（${who} ${i.dayLabel(row.reservation.date)} ${row.reservation.start} ${i.menuName(row.reservation.menuId)}）`,
    );
  }
  if (i.approvals.ad) {
    a += 1;
    const ad = i.approvals.ad;
    add("approval", a, `広告の案（言葉を${ad.action === "stop" ? "止める" : "外す"}）`, `承認待ち（広告の案：${ad.no}番を${ad.action === "stop" ? "止める" : "外す"}）`);
  }

  // 今日の ToDo（朝の要点の「今日の ToDo」と同じ物：まだ済んでいない・期限が無いか今日まで）を、ToDo のタブと同じ並べ方で
  const todayTodos = topTodos(i.todos, i.today, i.todos.length).filter((t) => !t.done && (!t.due || t.due <= i.today));
  todayTodos.forEach((t, n) => {
    const contact = (t.source === "reserve" || t.source === "chat") && !!t.due && t.due <= i.today;
    add("todo", n + 1, `${t.title}${contact ? "（お客様への連絡・今日中）" : t.due === i.today ? "（期限は今日）" : ""}`, `ToDo「${t.title}」`);
  });

  return { items, labels };
}

/** 一言の印を、プログラムの札（日時・お名前）に置きかえる。知らない印のある行は null（使わない） */
export function fillMarks(note: string, labels: Record<string, string>): string | null {
  let ok = true;
  const out = note.replace(MARK_RE, (m) => {
    if (!(m in labels)) ok = false;
    return labels[m] ?? m;
  });
  return ok ? out : null;
}

/** 同じ材料・同じルールなら同じ鍵（同じ物で何回も AI を呼ばないため。ルールを変えたら呼びなおす） */
export function briefKey(items: BriefItem[], rules: unknown[] = []): string {
  return JSON.stringify([items.map((i) => [i.mark, i.text]), rules]);
}
