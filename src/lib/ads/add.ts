// 言葉を足す案（docs/SPEC.md §1.7.5）。足してよい言葉はプログラムが決める。AI は、ここで作った候補の番号から選ぶだけ。
// 足すのは、売りのメニューの名前（featured.ts の売りの言葉）が入って予約につながった調べ言葉だけ。売り以外へは広げない。
// 候補にする（画面の印は ✓ 4つ）：
//   1. 候補の表（お客さんが調べた言葉の表）にある
//   2. 売りの言葉が入っている（featured.ts の featuredWordIn。空白を除いて比べる）
//   3. その4週で予約が1件以上ある
//   4. まだ足していない・外していない・見送っていない（もう「広告を出す言葉」にある・足す案が承認待ち、もここ）
// 承認BOXに入れる前に、画面でもう一度ここで確かめる（addRowsFrom）。承認する時も（state.ts の approveAdd）。

import { featuredWordIn } from "./featured";
import type { AdWeek } from "../data/types";
import { totalOf, type AdTable, type AdTableRow } from "./report";
import type { ReviewStep } from "./review";
import { gateAdSentence } from "./words";
import { getAdSettings } from "../settings";

export type AddCheckId = "listed" | "featured" | "booked" | "fresh";

/** ok: true = ✓ / false = ✗ / null = 前の確認で止まったので見ていない（gate.ts の GateCheck と同じ形） */
export type AddCheck = { id: AddCheckId; label: string; ok: boolean | null; reason?: string };

export const ADD_CHECK_IDS: readonly AddCheckId[] = ["listed", "featured", "booked", "fresh"];

export const ADD_CHECK_LABELS: Record<AddCheckId, string> = {
  listed: "候補の表（お客さんが調べた言葉）にある",
  featured: "売りの言葉が入っている",
  booked: "4週で予約がある",
  fresh: "まだ足していない・外していない・見送っていない",
};

/** 足す候補（プログラムが選んだ物。数は表から） */
export type AddCandidate = { no: number; text: string; word: string; total: AdWeek };

/** 門を通った足す案（数は入れていない。数は画面が表から入れる） */
export type GatedAdd = { no: number; text: string; reason: string };

/** サーバーが返す足す案（AI か決まった返事が候補から選んだ物）と、日誌に書く手順 */
export type AddPick = { picks: GatedAdd[]; steps: ReviewStep[] };

const plain = (s: string) => s.replace(/\s+/g, "");

export type AddResult = { ok: true; candidate: AddCandidate; checks: AddCheck[] } | { ok: false; checks: AddCheck[]; problems: string[] };

/**
 * その番号を足してよいか。ownPending = 承認する時（その案の「承認待ち」の印は自分の物なので数えない）
 */
export function checkAdd(table: AdTable, words: readonly string[], no: unknown, opts: { ownPending?: boolean } = {}): AddResult {
  const n = typeof no === "number" ? no : typeof no === "string" && /^\d+$/.test(no) ? Number(no) : NaN;
  const row: AdTableRow | null = Number.isInteger(n) ? (table.searchTerms.find((r) => r.no === n) ?? null) : null;

  const listed: AddCheck = { id: "listed", label: ADD_CHECK_LABELS.listed, ok: !!row };
  if (!row) {
    listed.reason = Number.isInteger(n)
      ? table.keywords.some((r) => r.no === n)
        ? `${n}番は広告を出す言葉です。足せるのはお客さんが調べた言葉だけです`
        : `${n}番は候補の表にありません`
      : "番号がありません";
    const rest = ADD_CHECK_IDS.slice(1).map((id) => ({ id, label: ADD_CHECK_LABELS[id], ok: null }));
    return { ok: false, checks: [listed, ...rest], problems: [listed.reason] };
  }

  const word = featuredWordIn(row.text, words);
  const featured: AddCheck = { id: "featured", label: ADD_CHECK_LABELS.featured, ok: !!word };
  if (!word) featured.reason = `${row.no}番「${row.text}」には売りの言葉（${words.join("・")}）が入っていません。売り以外へは広げません`;

  const total = totalOf(row);
  const booked: AddCheck = { id: "booked", label: ADD_CHECK_LABELS.booked, ok: total.bookings >= 1 };
  if (!booked.ok) booked.reason = `${row.no}番「${row.text}」はこの4週で予約につながっていません`;

  const fresh: AddCheck = { id: "fresh", label: ADD_CHECK_LABELS.fresh, ok: true };
  const mark = row.addMark === "pending" && opts.ownPending ? undefined : row.addMark;
  if (table.keywords.some((k) => plain(k.text) === plain(row.text))) fresh.reason = `「${row.text}」はもう広告を出す言葉にあります`;
  else if (mark === "added") fresh.reason = `${row.no}番「${row.text}」はもう足しました`;
  else if (mark === "pending") fresh.reason = `${row.no}番「${row.text}」を足す案は、もう承認待ちです`;
  else if (mark === "skipped") fresh.reason = `${row.no}番「${row.text}」を足すのは、前に見送りました`;
  else if (row.off) fresh.reason = `${row.no}番「${row.text}」は外した言葉です`;
  if (fresh.reason) fresh.ok = false;

  const checks = [listed, featured, booked, fresh];
  const problems = checks.filter((c) => c.ok === false && c.reason).map((c) => c.reason!);
  if (problems.length || !word) return { ok: false, checks, problems };
  return { ok: true, candidate: { no: row.no, text: row.text, word, total }, checks };
}

/** 足す候補：調べた言葉のうち、4つの確かめを全部通る物。予約の多い順（同じなら押された回数の多い順・番号の小さい順） */
export function addCandidates(table: AdTable, words: readonly string[], opts: { skipNo?: number } = {}): AddCandidate[] {
  return table.searchTerms
    .filter((r) => r.no !== opts.skipNo)
    .map((r) => checkAdd(table, words, r.no))
    .flatMap((r) => (r.ok ? [r.candidate] : []))
    .sort((a, b) => b.total.bookings - a.total.bookings || b.total.clicks - a.total.clicks || a.no - b.no);
}

/** 承認BOXに入れる足す案の1行（id と門の印つき） */
export type AddRow = { id: string; no: number; reason: string; checks: AddCheck[] };

/**
 * サーバーから受け取った足す案を、画面でもう一度確かめる（候補の4つ・理由の言葉の門・同じ番号は1つ・上限）。
 * skipNo = 同じ見直しで「外す」案にした調べ言葉（同じ言葉を外して足す、を同じ回に出さない）。
 * 通らなかった物は承認BOXに入れず、日誌の1行（プログラム）にする。
 */
export function addRowsFrom(
  table: AdTable,
  words: readonly string[],
  picks: readonly GatedAdd[] | undefined,
  opts: { baseId: string; maxAdds: number; skipNo?: number; gateWords?: string[] },
): { rows: AddRow[]; refused: ReviewStep[] } {
  const rows: AddRow[] = [];
  const refused: ReviewStep[] = [];
  const gw = opts.gateWords ?? getAdSettings().gateWords;
  for (const p of picks ?? []) {
    if (rows.length >= opts.maxAdds) {
      refused.push({ who: "プログラム", text: `画面の確認で断った：足す案は1回に${opts.maxAdds}件までなので、${p.no}番は入れなかった` });
      continue;
    }
    if (p.no === opts.skipNo) {
      refused.push({ who: "プログラム", text: `画面の確認で断った：${p.no}番は同じ見直しで外す案にしたので、足す案には入れなかった` });
      continue;
    }
    if (rows.some((r) => r.no === p.no)) continue;
    const c = checkAdd(table, words, p.no);
    const said = gateAdSentence(typeof p.reason === "string" ? p.reason : "", gw);
    if (!c.ok || !said.ok) {
      const why = !c.ok ? c.problems.join("。") : `理由の文が言葉の門を通りません（${said.ok ? "" : said.problems.join("。")}）`;
      refused.push({ who: "プログラム", text: `画面の確認で断った：${p.no}番を足す案（${why}）` });
      continue;
    }
    rows.push({ id: `${opts.baseId}-add${rows.length + 1}`, no: c.candidate.no, reason: said.text, checks: c.checks });
  }
  return { rows, refused };
}

/** 日誌の言葉：「11番「縮毛矯正 くせ毛 ひどい」を広告を出す言葉に足す」 */
export function addLabel(p: { no: number; text: string }): string {
  return `${p.no}番「${p.text}」を広告を出す言葉に足す`;
}
