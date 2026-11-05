// 下書きに入れる日時（プログラム）。空き枠の日時は台帳（確定・仮押さえ）と同じ時間に受ける人数から本当に空いている時間を、
// お休みの日付は、オーナーが材料に書いた日付（closed.ts が読む）を先に使い、書いていなければ店の設定から出す。
// 材料の日付を読み取れなかった時は推して入れない（「（日付を読み取れませんでした）」・空き枠も入れない・店の設定に戻さない）。
// 材料に時期（「年末」など）があれば、その時期の日から出す。続いているお休みの日は「〜」で1つにまとめる。
// オーナーが書いたお休みが店の設定・台帳とぶつかれば「確かめてください」の1行を出す（保存は止めない）。
// AI には日時を見せず、書かせない。AI が書いた印（【空き枠】【お休み】【ブログのリンク：…】）をここで置きかえ、
// その種類に要るのに印が無ければ、下書きの終わり（SNS はタグの前）に1行足す。

import { weekRange } from "../ai/dates";
import { addDays, calDay, toMinutes, type CalDay } from "../calendar";
import { freeRanges, type Reservation } from "../reservations";
import type { PostInsert, PostKind, PostsSettings, ShopSettings } from "../settings";
import { CLOSED_UNREADABLE, groupDays, groupLabel, OPENINGS_SKIPPED, type OwnerClosed } from "./closed";
import { BLOG_LINK_MARK, CLOSED_MARK, OPENINGS_MARK } from "./gate";

export type PostFacts = {
  /** 空き枠（日ごとに1行。例「11/5（木）10:00〜12:00・15:00〜20:00」） */
  openings: string[];
  /** お休みの日（まとまりごと。例「11月10日（火）」「12月31日（木）〜1月5日（火）」） */
  closed: string[];
  /** お休みの日付をどこから入れたか（材料に書いた日付か、店の設定か） */
  closedFrom: "materials" | "shop";
  /** 材料のお休みの日付を読み取れなかった（お休みも空き枠も入れない） */
  unreadable: boolean;
  /** 確かめてください（材料のお休みが台帳・店の設定とぶつかる所。1つ1行） */
  cautions: string[];
};

/**
 * 空いている時間（同じ時間に受ける人数（shop.seats）に、まだ届いていない所）を、つながりごとに1つにまとめる。
 * 数え方は朝の要点・予約サイト・予約チャットと同じ1つの数（1人で営業する店なら、予約の入った時間は空きと言わない）。
 */
export function openRanges(shop: ShopSettings, day: CalDay, all: Reservation[], from?: string): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  for (const r of freeRanges(shop, day, all, from).ranges) {
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
 * owner = 材料に書いたお休みの日付（closed.ts の readOwnerClosed）。読めたら、その日だけをお休みにして空き枠から外す。
 * 読み取れなかったら、お休みも空き枠も入れない。
 * お休みの数の上限（maxClosedDays）は、続いている日をまとめた数で数える（空き枠から外す日・ぶつかりの確かめは全部の日で）。
 * now = 店の時間帯のいま（今日がその日なら、それより前の枠は入れない）。
 */
export function postFacts(
  shop: ShopSettings,
  settings: Pick<PostsSettings, "openingDays" | "maxOpeningDays" | "closedDays" | "maxClosedDays">,
  today: CalDay,
  now: { date: string; time: string },
  all: Reservation[],
  period: PostPeriod | null = null,
  owner: OwnerClosed = { kind: "none" },
): PostFacts {
  if (owner.kind === "unreadable") return { openings: [], closed: [], closedFrom: "materials", unreadable: true, cautions: [] };
  const start = period && period.from > today.date ? period.from : today.date;
  const inWindow = (i: number, days: number) => (period ? i < MAX_PERIOD_DAYS && addDays(start, i) <= period.to : i < days);
  const ownerDays = owner.kind === "dates" ? new Set(owner.dates) : null;
  const openings: string[] = [];
  for (let i = 0; inWindow(i, settings.openingDays) && openings.length < settings.maxOpeningDays; i++) {
    const day = calDay(shop, addDays(start, i));
    if (!day.open || !day.hours || ownerDays?.has(day.date)) continue;
    const from = now.date === day.date ? now.time : undefined;
    // 閉店の前の、どのメニューも入らないほど短い空きは出さない（枠の長さより短い物）
    const free = openRanges(shop, day, all, from).filter((f) => toMinutes(f.end) - toMinutes(f.start) >= shop.slotMinutes);
    if (free.length === 0) continue;
    openings.push(`${day.label}${free.map((f) => `${f.start}〜${f.end}`).join("・")}`);
  }
  let closedDays: string[];
  if (owner.kind === "dates") closedDays = owner.dates;
  else {
    closedDays = [];
    for (let i = 0; inWindow(i, settings.closedDays); i++) {
      const day = calDay(shop, addDays(start, i));
      if (!day.open) closedDays.push(day.date);
    }
  }
  const closed = groupDays(closedDays).slice(0, settings.maxClosedDays).map(groupLabel);
  return {
    openings,
    closed,
    closedFrom: owner.kind === "dates" ? "materials" : "shop",
    unreadable: false,
    cautions: owner.kind === "dates" ? closedCautions(shop, owner.dates, all) : [],
  };
}

/**
 * 材料に書いたお休みの日が、台帳（確定・仮押さえ）・店の設定とぶつかる所（1つ1行。お客様の名前は出さない）。
 * 予約がある日は日ごとに、店の設定で営業日の日は続いた日をまとめて。
 */
export function closedCautions(shop: ShopSettings, dates: string[], all: Reservation[]): string[] {
  const out: string[] = [];
  for (const d of [...new Set(dates)].sort()) {
    const n = all.filter((r) => r.date === d && (r.status === "confirmed" || r.status === "hold")).length;
    if (n > 0) out.push(`${groupLabel({ from: d, to: d })}に予約が${n}件あります`);
  }
  for (const g of groupDays(dates.filter((d) => calDay(shop, d).open))) {
    out.push(`${groupLabel(g)}は、店の設定では営業日です（予約サイト・予約チャットでは受けてしまいます）`);
  }
  return out;
}

/** 【空き枠】の所に入れる言葉 */
const openingsText = (f: PostFacts) => (f.unreadable ? OPENINGS_SKIPPED : f.openings.length ? f.openings.join("、") : "（いまはご案内できる空きがありません）");
/** 【お休み】の所に入れる言葉 */
const closedText = (f: PostFacts) => (f.unreadable ? CLOSED_UNREADABLE : f.closed.length ? f.closed.join("、") : "（しばらくお休みはありません）");
const OPENINGS_LINE = (f: PostFacts) =>
  f.unreadable ? `空きのある日時：${OPENINGS_SKIPPED}` : f.openings.length ? `空きのある日時：${f.openings.join("、")}` : "空きのある日時：いまはご案内できる空きがありません";
const CLOSED_LINE = (f: PostFacts) => (f.unreadable ? `お休み：${CLOSED_UNREADABLE}` : f.closed.length ? `お休み：${f.closed.join("、")}` : "");

/** カードの ✓ と日誌に出す、お休みの日付の入れ元 */
export const CLOSED_FROM_LABEL: Record<PostFacts["closedFrom"], string> = {
  materials: "お休みの日付（材料から）",
  shop: "お休みの日付（店の設定から）",
};

/** カードの「確かめてください」の1行の頭 */
export const CAUTION_HEAD = "確かめてください：";

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
  text = text.split(OPENINGS_MARK).join(openingsText(facts));
  if (raw.includes(OPENINGS_MARK)) inserted.add("openings");
  text = text.split(CLOSED_MARK).join(closedText(facts));
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
