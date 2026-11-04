// 下書きに入れる日時（プログラム）。空き枠の日時は台帳（確定・仮押さえ）から本当に空いている時間（だれの予約も無い所）を、
// お休みの日付は店の設定から出す。材料に時期（「年末」など）があれば、その時期の日から出す。
// AI には日時を見せず、書かせない。AI が書いた印（【空き枠】【お休み】【ブログのリンク：…】）をここで置きかえ、
// その種類に要るのに印が無ければ、下書きの終わり（SNS はタグの前）に1行足す。

import { weekRange } from "../ai/dates";
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

/**
 * 本当に空いている時間（どの席にも予約（確定・仮押さえ）が入っていない所）を、つながりごとに1つにまとめる。
 * 1人で営業する店なので、だれかの予約が入っている時間は「空き」と案内しない。
 */
export function openRanges(shop: ShopSettings, day: CalDay, all: Reservation[], from?: string): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  for (const r of freeRanges(shop, day, all, from).ranges) {
    if (r.free < shop.seats) continue;
    const last = out[out.length - 1];
    if (last && last.end === r.start) last.end = r.end;
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/** 材料に書いた時期（「年末」「12月」「来週」など）。その時期の日の幅 */
export type PostPeriod = { label: string; from: string; to: string };

/** 時期の言葉の定め（config/posts.json の periods）。日付は月-日。to が from より前なら年をまたぐ */
export type PeriodWord = { words: string[]; from: string; to: string };

const pad = (n: number) => String(n).padStart(2, "0");
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** 月-日の幅を、今日から見て次に来る年の日付にする（もう過ぎた幅は来年） */
function nextWindow(today: string, from: string, to: string): { from: string; to: string } {
  const y = Number(today.slice(0, 4));
  for (const year of [y - 1, y, y + 1]) {
    const f = `${year}-${from}`;
    const t = `${to < from ? year + 1 : year}-${to}`;
    if (t >= today) return { from: f, to: t };
  }
  return { from: `${y + 1}-${from}`, to: `${to < from ? y + 2 : y + 1}-${to}` };
}

/** 材料の文から時期を読む。読めなければ null（今日から openingDays 日のまま） */
export function periodOf(text: string, today: string, words: PeriodWord[] = []): PostPeriod | null {
  const t = text.normalize("NFKC");
  // 決まった言葉（年末・クリスマス など）は長い言葉から
  const defs = words.flatMap((d) => d.words.map((w) => ({ w, d }))).sort((a, b) => b.w.length - a.w.length);
  for (const { w, d } of defs) if (t.includes(w)) return { label: w, ...nextWindow(today, d.from, d.to) };
  const y = Number(today.slice(0, 4));
  const m0 = Number(today.slice(5, 7));
  const month = (m: number, part?: string): PostPeriod => {
    const year = m < m0 ? y + 1 : y;
    const end = lastDayOf(year, m);
    const [a, b] =
      part === "上旬" || part === "初め" || part === "はじめ" ? [1, 10] : part === "中旬" ? [11, 20] : part === "下旬" || part === "末" ? [21, end] : [1, end];
    return { label: `${m}月${part ?? ""}`, from: `${year}-${pad(m)}-${pad(a)}`, to: `${year}-${pad(m)}-${pad(b)}` };
  };
  const mm = t.match(/(1[0-2]|[1-9])月(上旬|中旬|下旬|初め|はじめ|末)?/);
  if (mm) return month(Number(mm[1]), mm[2]);
  if (/来月/.test(t)) return { ...month(m0 === 12 ? 1 : m0 + 1), label: "来月" };
  if (/月末/.test(t)) return { label: "月末", from: `${y}-${pad(m0)}-21`, to: `${y}-${pad(m0)}-${pad(lastDayOf(y, m0))}` };
  if (/再来週/.test(t)) return { label: "再来週", ...weekRange(today, 2) };
  if (/来週/.test(t)) return { label: "来週", ...weekRange(today, 1) };
  if (/今週/.test(t)) return { label: "今週", ...weekRange(today, 0) };
  if (/週末|土日/.test(t)) {
    const { to } = weekRange(today, 0);
    return { label: "週末", from: addDays(to, -1), to };
  }
  return null;
}

/** 時期の幅は長くても、この日数まで見る（ループの守り） */
const MAX_PERIOD_DAYS = 62;

/**
 * 空き枠（営業日だけ。今日はいまの時刻より後）と、お休みの日。
 * 時期（period）が無ければ、今日から openingDays 日の空き枠と closedDays 日の中のお休み。
 * 時期があれば、その時期の日（今日より前は見ない）の中から、空き枠とお休みを出す（「年末」なら年末の日）。
 * now = 店の時間帯のいま（今日がその日なら、それより前の枠は入れない）。
 */
export function postFacts(
  shop: ShopSettings,
  settings: Pick<PostsSettings, "openingDays" | "maxOpeningDays" | "closedDays" | "maxClosedDays">,
  today: CalDay,
  now: { date: string; time: string },
  all: Reservation[],
  period: PostPeriod | null = null,
): PostFacts {
  const start = period && period.from > today.date ? period.from : today.date;
  const inWindow = (i: number, days: number) => (period ? i < MAX_PERIOD_DAYS && addDays(start, i) <= period.to : i < days);
  const openings: string[] = [];
  for (let i = 0; inWindow(i, settings.openingDays) && openings.length < settings.maxOpeningDays; i++) {
    const day = calDay(shop, addDays(start, i));
    if (!day.open || !day.hours) continue;
    const from = now.date === day.date ? now.time : undefined;
    // 閉店の前の、どのメニューも入らないほど短い空きは出さない（枠の長さより短い物）
    const free = openRanges(shop, day, all, from).filter((f) => toMinutes(f.end) - toMinutes(f.start) >= shop.slotMinutes);
    if (free.length === 0) continue;
    openings.push(`${day.label}${free.map((f) => `${f.start}〜${f.end}`).join("・")}`);
  }
  const closed: string[] = [];
  for (let i = 0; inWindow(i, settings.closedDays) && closed.length < settings.maxClosedDays; i++) {
    const day = calDay(shop, addDays(start, i));
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
