// 下書きに入れる日時（プログラム）。空き枠の日時は台帳（確定・仮押さえ）と席の数から、お休みの日付は店の設定から出す。
// AI には日時を見せず、書かせない。AI が書いた印（【空き枠】【お休み】【ブログのリンク：…】）をここで置きかえ、
// その種類に要るのに印が無ければ、下書きの終わり（SNS はタグの前）に1行足す。

import { addDays, calDay, toMinutes, type CalDay } from "../calendar";
import { freeRanges, type Reservation } from "../reservations";
import type { PostInsert, PostKind, PostsSettings, ShopSettings } from "../settings";
import { BLOG_LINK_MARK, CLOSED_MARK, OPENINGS_MARK } from "./gate";

export type PostFacts = {
  /** 空き枠（日ごとに1行。例「11/5（木）10:00〜12:00・15:00〜20:00」） */
  openings: string[];
  /** お休みの日（例「11/10（火）」） */
  closed: string[];
};

/** つながっている空き（1席でも空いている所）を1つにまとめる */
function mergedFree(shop: ShopSettings, day: CalDay, all: Reservation[], from?: string): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  for (const r of freeRanges(shop, day, all, from).ranges) {
    const last = out[out.length - 1];
    if (last && last.end === r.start) last.end = r.end;
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/**
 * 今日から openingDays 日の空き枠（営業日だけ。今日はいまの時刻より後）と、closedDays 日の中のお休みの日。
 * now = 店の時間帯のいま（今日がその日なら、それより前の枠は入れない）。
 */
export function postFacts(
  shop: ShopSettings,
  settings: Pick<PostsSettings, "openingDays" | "maxOpeningDays" | "closedDays" | "maxClosedDays">,
  today: CalDay,
  now: { date: string; time: string },
  all: Reservation[],
): PostFacts {
  const openings: string[] = [];
  for (let i = 0; i < settings.openingDays && openings.length < settings.maxOpeningDays; i++) {
    const day = calDay(shop, addDays(today.date, i));
    if (!day.open || !day.hours) continue;
    const from = now.date === day.date ? now.time : undefined;
    // 閉店の前の、どのメニューも入らないほど短い空きは出さない（枠の長さより短い物）
    const free = mergedFree(shop, day, all, from).filter((f) => toMinutes(f.end) - toMinutes(f.start) >= shop.slotMinutes);
    if (free.length === 0) continue;
    openings.push(`${day.label}${free.map((f) => `${f.start}〜${f.end}`).join("・")}`);
  }
  const closed: string[] = [];
  for (let i = 0; i < settings.closedDays && closed.length < settings.maxClosedDays; i++) {
    const day = calDay(shop, addDays(today.date, i));
    if (!day.open) closed.push(day.label);
  }
  return { openings, closed };
}

const OPENINGS_LINE = (f: PostFacts) => (f.openings.length ? `空きのある日時：${f.openings.join("、")}` : "空きのある日時：いまはご案内できる空きがありません");
const CLOSED_LINE = (f: PostFacts) => (f.closed.length ? `お休み：${f.closed.join("、")}` : "");

export type FilledPost = {
  text: string;
  /** プログラムが入れた物（印を置きかえた・足した） */
  inserted: PostInsert[];
};

/** 印を置きかえ、その種類に要る物で印が無い物を足す */
export function fillPost(raw: string, kind: Pick<PostKind, "id" | "insert">, facts: PostFacts): FilledPost {
  const inserted = new Set<PostInsert>();
  let text = raw.replace(/\r\n?/g, "\n").trim();

  // ブログのリンクの印は、短い書き方（【ブログのリンク】）も決まった印にそろえる
  text = text.replace(/【ブログのリンク[^】]*】/g, () => {
    inserted.add("blogLink");
    return BLOG_LINK_MARK;
  });
  text = text.split(OPENINGS_MARK).join(facts.openings.length ? facts.openings.join("、") : "（いまはご案内できる空きがありません）");
  if (raw.includes(OPENINGS_MARK)) inserted.add("openings");
  text = text.split(CLOSED_MARK).join(facts.closed.length ? facts.closed.join("、") : "（しばらくお休みはありません）");
  if (raw.includes(CLOSED_MARK)) inserted.add("closed");

  const add: string[] = [];
  for (const need of kind.insert) {
    if (inserted.has(need)) continue;
    const line = need === "openings" ? OPENINGS_LINE(facts) : need === "closed" ? CLOSED_LINE(facts) : BLOG_LINK_MARK;
    if (!line) continue;
    add.push(line);
    inserted.add(need);
  }
  if (add.length) {
    const lines = text.split("\n");
    // SNS などのタグ（# で始まる行）が終わりにあれば、その前に入れる
    let at = lines.length;
    while (at > 0 && /^\s*#/.test(lines[at - 1])) at--;
    if (at === 0) at = lines.length;
    const head = lines.slice(0, at).join("\n").trimEnd();
    const tail = lines.slice(at).join("\n");
    text = [head, add.join("\n"), tail].filter((x) => x.trim()).join("\n\n");
  }
  return { text, inserted: [...inserted] };
}
