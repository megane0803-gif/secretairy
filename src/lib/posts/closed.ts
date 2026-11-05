// 発信：オーナーが材料に書いたお休みの日付を読む（プログラム。AI には日付を書かせない。docs/SPEC.md §1.10）。
// 材料を「。」と改行で文に分け、「休」の字がある文だけを見る。打ち消し（休み明け・休まず・除く など）があれば読まない。
// 「、」で分けた節のうち「営業」を含む節（「1/6から営業します」）の日付は読まない。
// 残った日付が全部、次のどちらか1つの形で読み切れた時だけ「読めた」にする（一部だけ読めても成功にしない）。
//   (a) 期間1つ：「12月31日から1月5日まで」「12/31〜1/5」「1月1日から3日まで」（2つ目に月が無ければ1つ目と同じ月。日が前に戻るなら次の月）
//   (b) 1日ずつの並び：「12月30日と1月4日」「12月30日、1月4日」
// 年：書いてあればそれ。無ければ、期間の終わり（1日ずつはその日）が今日以降になるいちばん近い年。
// 形と曜日もここで出す（「12月31日（木）〜1月5日（火）」）。続いている日は「〜」でまとめる。

import { addDays, dayDiff } from "../calendar";

/** 材料のお休みの日付 */
export type OwnerClosed =
  /** 「休」の文に日付が無い（今までどおり、店の設定のお休み） */
  | { kind: "none" }
  /** 読めた（日付は全部・古い順） */
  | { kind: "dates"; dates: string[] }
  /** 読み取れなかった（推して入れない。店の設定のお休みにも戻さない） */
  | { kind: "unreadable" };

/** 読み取れなかった時に【お休み】の所に入れる言葉（カードの注意も同じ言葉） */
export const CLOSED_UNREADABLE = "（日付を読み取れませんでした）";
/** 読み取れなかった時に【空き枠】の所に入れる言葉 */
export const OPENINGS_SKIPPED = "（お休みの日付を読み取れなかったので、空き枠は入れていません）";

/** 期間の長さの上限（日）。これより長い期間は読み取れない扱い */
export const MAX_OWNER_CLOSED_DAYS = 62;

/** この言葉が「休」の文にあれば、全体を読み取れない扱い */
const NEGATIONS = ["休み明け", "休まず", "無休", "除く", "除き", "以外", "取り消し", "取りやめ"];

/** 日付の1つ（年 月日・月日・月/日・日だけ） */
const DATE_TOKEN = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日|(?:(\d{4})\s*\/\s*)?(\d{1,2})\s*\/\s*(\d{1,2})|(\d{1,2})\s*日/g;
/** 漢数字の日付（「十二月三十一日」など）。読まないが、残っていたら読み取れない扱い */
const KANJI_DATE = /[〇一二三四五六七八九十]+\s*[月日]/;
/** 期間の「から」 */
const RANGE_GAP = /^(から|より|〜|~|-|－|ー|―)$/;
/** 1日ずつの並びのつなぎ */
const LIST_GAP = /^(と|、|,|・)$/;
/** 日付のすぐ後ろにこれがあれば、1日ずつの並びとは読まない（「12/31から」だけ・「1/5まで」だけ など） */
const OPEN_END = /^\s*(から|より|まで|〜|~|-|－|以降|以前|頃|ごろ)/;

type Token = { year?: number; month?: number; day: number; at: number; end: number };

const JA = ["日", "月", "火", "水", "木", "金", "土"];
const pad = (n: number) => String(n).padStart(2, "0");

function realDate(y: number, m: number, d: number): string | null {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const s = `${y}-${pad(m)}-${pad(d)}`;
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === s ? s : null;
}

/** 「12月31日（木）」（月日と曜日） */
export function monthDayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${m}月${d}日（${JA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
}

/** 日付（古い順・重ねない）を、続いている日ごとのまとまりにする */
export function groupDays(dates: string[]): { from: string; to: string }[] {
  const sorted = [...new Set(dates)].sort();
  const out: { from: string; to: string }[] = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (last && addDays(last.to, 1) === d) last.to = d;
    else out.push({ from: d, to: d });
  }
  return out;
}

/** まとまり1つの形（1日なら「12月30日（水）」、続いていれば「12月31日（木）〜1月5日（火）」） */
export function groupLabel(g: { from: string; to: string }): string {
  return g.from === g.to ? monthDayLabel(g.from) : `${monthDayLabel(g.from)}〜${monthDayLabel(g.to)}`;
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length <= MAX_OWNER_CLOSED_DAYS; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 文を「、」で節に分け、「営業」を含む節を外して戻す */
function withoutOpenClauses(sentence: string): string {
  return sentence
    .split("、")
    .filter((c) => !c.includes("営業"))
    .join("、");
}

function tokensOf(s: string): Token[] {
  const out: Token[] = [];
  for (const m of s.matchAll(DATE_TOKEN)) {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    if (m[2] !== undefined) out.push({ year: m[1] ? Number(m[1]) : undefined, month: Number(m[2]), day: Number(m[3]), at, end });
    else if (m[5] !== undefined) out.push({ year: m[4] ? Number(m[4]) : undefined, month: Number(m[5]), day: Number(m[6]), at, end });
    else out.push({ day: Number(m[7]), at, end });
  }
  return out;
}

/** 期間1つ（a）を、年を決めて日付にする。決められなければ null */
function periodDates(a: Token, b: Token, today: string): string[] | null {
  if (a.month === undefined) return null;
  // 2つ目に月が無ければ1つ目と同じ月。日が前に戻るなら次の月
  let bm = b.month;
  let bRoll = 0;
  if (bm === undefined) {
    bm = b.day < a.day ? (a.month === 12 ? 1 : a.month + 1) : a.month;
    bRoll = b.day < a.day && a.month === 12 ? 1 : 0;
  } else if (b.month !== undefined && (bm < a.month || (bm === a.month && b.day < a.day))) {
    bRoll = 1; // 12/31〜1/5 は年をまたぐ
  }
  const make = (startYear: number): { from: string; to: string } | null => {
    const from = realDate(startYear, a.month!, a.day);
    const to = realDate(startYear + bRoll, bm!, b.day);
    return from && to ? { from, to } : null;
  };
  let range: { from: string; to: string } | null = null;
  if (a.year !== undefined || b.year !== undefined) {
    // 書いた年を使う（2つとも書いてあれば、食い違っていないか確かめる）
    const startYear = a.year ?? b.year! - bRoll;
    if (a.year !== undefined && b.year !== undefined && b.year !== a.year + bRoll) {
      const from = realDate(a.year, a.month, a.day);
      const to = realDate(b.year, bm, b.day);
      range = from && to ? { from, to } : null;
    } else range = make(startYear);
    if (!range || range.to < today) return null; // 書いた年の期間がもう終わっている
  } else {
    const y = Number(today.slice(0, 4));
    for (const year of [y - 1, y, y + 1]) {
      const r = make(year);
      if (r && r.to >= today) {
        range = r;
        break;
      }
    }
  }
  if (!range || range.to < range.from) return null;
  if (dayDiff(range.from, range.to) + 1 > MAX_OWNER_CLOSED_DAYS) return null;
  return daysBetween(range.from, range.to);
}

/** 1日ずつの日付（年が無ければ、今日以降のいちばん近い日）。決められなければ null */
function singleDate(t: Token, today: string): string | null {
  if (t.month === undefined) return null;
  if (t.year !== undefined) {
    const d = realDate(t.year, t.month, t.day);
    return d && d >= today ? d : null;
  }
  const y = Number(today.slice(0, 4));
  for (const year of [y, y + 1]) {
    const d = realDate(year, t.month, t.day);
    if (d && d >= today) return d;
  }
  return null;
}

/** 1つの「休」の文から読む。日付が無ければ "none" */
function readSentence(sentence: string, today: string): OwnerClosed {
  if (NEGATIONS.some((w) => sentence.includes(w))) return { kind: "unreadable" };
  const s = withoutOpenClauses(sentence);
  const tokens = tokensOf(s);
  if (tokens.length === 0) {
    // 読めない形の日付（漢数字の日付・月だけの数字の後ろに日）が残っていれば読まない
    return KANJI_DATE.test(s) ? { kind: "unreadable" } : { kind: "none" };
  }
  // 日付のほかに数字・漢数字の日付が残っていたら読み切れていない
  let rest = "";
  let last = 0;
  for (const t of tokens) {
    rest += s.slice(last, t.at) + "　";
    last = t.end;
  }
  rest += s.slice(last);
  if (/\d/.test(rest) || KANJI_DATE.test(rest)) return { kind: "unreadable" };

  const gaps = tokens.slice(1).map((t, i) => s.slice(tokens[i].end, t.at).trim());
  const after = s.slice(tokens[tokens.length - 1].end);
  // (a) 期間1つ
  if (tokens.length === 2 && RANGE_GAP.test(gaps[0]) && !/^\s*(から|より|〜|~|-|－)/.test(after)) {
    const dates = periodDates(tokens[0], tokens[1], today);
    return dates ? { kind: "dates", dates } : { kind: "unreadable" };
  }
  // (b) 1日ずつの並び
  if (gaps.every((g) => LIST_GAP.test(g))) {
    if (tokens.some((t, i) => OPEN_END.test(s.slice(t.end, tokens[i + 1]?.at ?? s.length)))) return { kind: "unreadable" };
    if (tokens.some((t) => /(〜|~|-|－|から)\s*$/.test(s.slice(0, t.at)))) return { kind: "unreadable" };
    const dates: string[] = [];
    for (const t of tokens) {
      const d = singleDate(t, today);
      if (!d) return { kind: "unreadable" };
      dates.push(d);
    }
    return { kind: "dates", dates: [...new Set(dates)].sort() };
  }
  return { kind: "unreadable" };
}

/**
 * 材料の文（種類の欄を改行でつないだ物）から、オーナーが書いたお休みの日付を読む。
 * 日付のある「休」の文が2つ以上・どれか1つでも読み切れない時は、全体を読み取れない扱い。
 */
export function readOwnerClosed(text: string, today: string): OwnerClosed {
  const sentences = text
    .normalize("NFKC")
    .split(/[。\n]/)
    .map((x) => x.trim())
    .filter((x) => x.includes("休"));
  const found: OwnerClosed[] = sentences.map((s) => readSentence(s, today));
  if (found.some((f) => f.kind === "unreadable")) return { kind: "unreadable" };
  const withDates = found.filter((f): f is Extract<OwnerClosed, { kind: "dates" }> => f.kind === "dates");
  if (withDates.length === 0) return { kind: "none" };
  if (withDates.length > 1) return { kind: "unreadable" };
  return withDates[0];
}
