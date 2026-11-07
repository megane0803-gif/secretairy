// 架空の広告の4週分を、画面と AI と門（gate.ts）が使う形にする。数はここでプログラムが出す（AI は数を作らない）。
// 最初の状態は seed/ads.json（src/lib/data/seed.ts から読む）。止めた・外した分はブラウザの中だけ（state.ts）。

import type { AdKeyword, AdReport, AdRow, AdWeek } from "../data/types";
import type { AdSettings } from "../settings";

/** stop = 広告を出す言葉を止める / exclude = お客さんが調べた言葉を外す（この言葉では広告を出さない） */
export type AdAction = "stop" | "exclude";

/** 表の1行（画面・AI・門で同じ物を使う） */
export type AdTableRow = {
  no: number;
  text: string;
  /** keyword = 広告を出す言葉（止められる） / term = お客さんが調べた言葉（外せる） */
  kind: "keyword" | "term";
  /** 売りのメニューの言葉（広告を出す言葉だけ） */
  featured: boolean;
  menuId?: string;
  /** 古い順に4週分 */
  weeks: AdWeek[];
  /** もう止めた（外した） */
  off: boolean;
  /**
   * 調べた言葉だけ：広告を出す言葉に足す案の印（add.ts）。pending = 足す案が承認待ち / added = もう足した / skipped = 足すのは見送った。
   * 足した言葉は、表の「広告を出す言葉」の数には入れない（数はまだ無い）。止める案の対象にもしない。
   */
  addMark?: AddMark;
};

export type AddMark = "pending" | "added" | "skipped";

export type AdTable = { keywords: AdTableRow[]; searchTerms: AdTableRow[] };

/** 週の数え方（古い順）。いつ開いても「先週まで4週分」 */
export const WEEK_LABELS = ["4週前", "3週前", "2週前", "先週"];

export const ZERO: AdWeek = { clicks: 0, cost: 0, bookings: 0 };

export function addWeek(a: AdWeek, b: AdWeek): AdWeek {
  return { clicks: a.clicks + b.clicks, cost: a.cost + b.cost, bookings: a.bookings + b.bookings };
}

/** 1行の4週の合計 */
export function totalOf(row: Pick<AdRow, "weeks">): AdWeek {
  return row.weeks.reduce(addWeek, ZERO);
}

/** 週ごとの合計（古い順）。広告を出す言葉の数を足す（調べた言葉はその内訳なので足さない） */
export function weeklyTotals(rows: Pick<AdRow, "weeks">[]): AdWeek[] {
  const n = Math.max(0, ...rows.map((r) => r.weeks.length));
  return Array.from({ length: n }, (_, i) => rows.reduce((s, r) => addWeek(s, r.weeks[i] ?? ZERO), ZERO));
}

/** 最初の状態の表に、止めた・外した番号と、足す案の印（調べた言葉の番号ごと）を重ねる */
export function buildTable(
  report: AdReport,
  settings: Pick<AdSettings, "featuredMenus">,
  off: Iterable<number> = [],
  marks: Iterable<readonly [number, AddMark]> = [],
): AdTable {
  const offSet = new Set(off);
  const markOf = new Map(marks);
  const kw = (k: AdKeyword): AdTableRow => ({
    no: k.no,
    text: k.text,
    kind: "keyword",
    featured: !!k.menuId && settings.featuredMenus.includes(k.menuId),
    ...(k.menuId ? { menuId: k.menuId } : {}),
    weeks: k.weeks,
    off: offSet.has(k.no),
  });
  const term = (t: AdRow): AdTableRow => {
    const mark = markOf.get(t.no);
    return { no: t.no, text: t.text, kind: "term", featured: false, weeks: t.weeks, off: offSet.has(t.no), ...(mark ? { addMark: mark } : {}) };
  };
  return {
    keywords: report.keywords.map(kw),
    // 調べた言葉は多い順（押された回数の4週の合計）
    searchTerms: report.searchTerms.map(term).sort((a, b) => totalOf(b).clicks - totalOf(a).clicks),
  };
}

/** 広告を出す言葉に足した言葉（調べた言葉の行。数はまだ無いので、週ごとの合計や止める案には入れない） */
export function addedRows(t: AdTable): AdTableRow[] {
  return t.searchTerms.filter((r) => r.addMark === "added");
}

export function allRows(t: AdTable): AdTableRow[] {
  return [...t.keywords, ...t.searchTerms];
}

export function findRow(t: AdTable, no: number): AdTableRow | null {
  return allRows(t).find((r) => r.no === no) ?? null;
}

/** その言葉に入っている町の名前（無ければ null） */
export function townIn(text: string, towns: string[]): string | null {
  const plain = text.replace(/\s+/g, "");
  return towns.find((t) => t && plain.includes(t.replace(/\s+/g, ""))) ?? null;
}

export function actionVerb(a: AdAction): string {
  return a === "stop" ? "止める" : "外す";
}

export function actionPast(a: AdAction): string {
  return a === "stop" ? "止めた" : "外した";
}

/** 「3番を止める」 */
export function actionLabel(a: AdAction, no: number): string {
  return `${no}番を${actionVerb(a)}`;
}

/** その種類の行に使える動き（広告を出す言葉は止める・調べた言葉は外す） */
export function actionFor(kind: AdTableRow["kind"]): AdAction {
  return kind === "keyword" ? "stop" : "exclude";
}

export function yen(n: number): string {
  return `${n.toLocaleString("ja-JP")}円`;
}

/** AI に渡す表の文（数はここでプログラムが書く。AI は読むだけ） */
export function tableText(t: AdTable, towns: string[]): string {
  const line = (r: AdTableRow) => {
    const s = totalOf(r);
    const tags = [
      r.featured ? "売り" : "",
      townIn(r.text, towns) ? "町の名前入り" : "",
      r.off ? (r.kind === "keyword" ? "もう止めた" : "もう外した") : "",
      r.addMark === "added" ? "もう足した" : "",
    ]
      .filter(Boolean)
      .join("・");
    const weeks = r.weeks.map((w, i) => `${WEEK_LABELS[i] ?? `${i + 1}週目`} ${w.clicks}回/${w.cost}円/予約${w.bookings}`).join("、");
    return `- ${r.no}番「${r.text}」${tags ? `［${tags}］` : ""}：4週で 押された${s.clicks}回・${s.cost}円・予約${s.bookings}件（${weeks}）`;
  };
  return [
    "## 広告を出す言葉（止められる：stop_keyword）",
    ...t.keywords.map(line),
    // 足した言葉は数がまだ無いので、数を書かずに印だけ（止める案には選ばない）
    ...addedRows(t).map((r) => `- 「${r.text}」［足した・数はまだ無い］（${r.no}番の調べた言葉から足した。止める案には選ばない）`),
    "",
    "## お客さんが調べた言葉（多い順。外せる：exclude_term）",
    ...t.searchTerms.map(line),
  ].join("\n");
}
