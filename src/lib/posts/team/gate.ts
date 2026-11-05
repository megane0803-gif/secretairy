// 発信のチームの、候補にしてよいかの確かめ（プログラム）。AI は使わない。
// 確かめは3つに分ける（日付を入れた後の下書き全体に、作る時の門 gatePost をそのまま掛けると正しい日付まで当たるので掛けない）：
//   (1) 直す前と後の1文：数字（算用数字・漢字の数の言い方は postNumbersWritten）・日付・曜日・URL が無い
//   (2) 置きかえた後の全文：使わない言葉が無い・プログラムが入れた所（日付・空き枠・リンクの印）が変わっていない・事実の確かめ（closedCautions）
//   (3) 印【…】の確かめは別に持つ（postNumbersWritten は決まった印を外して数えるので）
// 元の文は、下書きの中で「1文まるごと一致し、1回だけ出てくる」文だけ（文は「。」「！」「？」と改行で区切る）。
// 直した文は、発信の言葉の門（使わない言葉 gateWordsIn・数 postNumbersWritten）と🔒の2つに通す。

import { normalizeText } from "../../karte/gate";
import { KARTE_GATE_WORDS } from "../../rules/locked";
import { lockedConflict } from "../../rules/validate";
import type { Reservation } from "../../reservations";
import type { ShopSettings } from "../../settings";
import { closedCautions } from "../facts";
import { gateWordsIn, postNumbersWritten } from "../gate";
import type { PostEdit } from "./types";

/** 下書きを文に分ける（改行で行に分け、行の中は「。」「！」「？」の後ろで分ける。前後の空白は外す） */
export function sentencesOf(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap((line) => line.split(/(?<=[。！？!?])/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 文字列が何回出てくるか（重ならない数え方） */
export function occurrences(text: string, s: string): number {
  if (!s) return 0;
  let n = 0;
  for (let i = text.indexOf(s); i >= 0; i = text.indexOf(s, i + s.length)) n++;
  return n;
}

/** 1回だけ出てくる文を置きかえる（2回以上・無い時はそのまま） */
export function replaceOnce(text: string, from: string, to: string): string {
  if (occurrences(text, from) !== 1) return text;
  const at = text.indexOf(from);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

const WEEKDAY_PAREN = /[（(]\s*[月火水木金土日]\s*[)）]/;
const URL_RE = /(https?:\/\/|www\.)/i;
const MARK_RE = /[【】]/;

/** (1)(3) 1文の中の事実（数字・日付・曜日・印・URL）。あれば候補にしない（事実はリサーチャーに任せる） */
export function factsIn(s: string): string[] {
  const out: string[] = [];
  const nums = postNumbersWritten(s);
  if (nums.length) out.push(`数字・日付（${nums.map((x) => `「${x}」`).join("")}）が入っています`);
  else if (WEEKDAY_PAREN.test(s.normalize("NFKC"))) out.push("曜日が入っています");
  // (3) 印は数字の確かめとは別に見る（postNumbersWritten は決まった印を外すので）
  if (MARK_RE.test(s)) out.push("印【…】が入っています");
  if (URL_RE.test(s.normalize("NFKC"))) out.push("URL が入っています");
  return out;
}

/** 元の文として使えるか。使えなければ理由 */
export function fromProblems(text: string, from: string, pieces: string[]): string[] {
  const f = typeof from === "string" ? from.trim() : "";
  if (!f) return ["元の文がありません"];
  const sentences = sentencesOf(text);
  if (!sentences.includes(f)) return ["下書きの1文まるごとと一致しません"];
  if (sentences.filter((s) => s === f).length !== 1 || occurrences(text, f) !== 1) return ["同じ文が下書きに2回以上あります"];
  const out: string[] = [];
  if (/^#/.test(f)) out.push("見出し・タグの行は直しません");
  if (pieces.some((p) => p && (f.includes(p) || p.includes(f)))) out.push("プログラムが入れた所を含む文です");
  out.push(...factsIn(f));
  return out;
}

/** 候補にしてよい元の文（1回だけ出てくる・事実が無い・見出しでない）。指示の「直してよい文」と決まった返事が使う */
export function editableSentences(text: string, pieces: string[]): string[] {
  return [...new Set(sentencesOf(text))].filter((s) => fromProblems(text, s, pieces).length === 0);
}

/** 🔒 確定は人：下書きの文に、元の文に無い「確定」「承認」を足さない */
const DECIDE = /(確定|承認)/;

/** 1文を発信の言葉の門と🔒に通す（直した文・理由に使う） */
export function lineProblems(raw: unknown, opts: { maxChars: number; gateWords: string[]; material: string }): string[] {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (!t) return ["文がありません"];
  const out: string[] = [];
  if (/\n/.test(t) || sentencesOf(t).length !== 1) out.push("1文ではありません");
  if ([...t].length > opts.maxChars) out.push(`${opts.maxChars}字より長い文でした`);
  out.push(...factsIn(t));
  const hit = gateWordsIn(t, opts.gateWords);
  if (hit.length) out.push(`${hit.map((w) => `「${w}」`).join("")}は使わない言葉です`);
  const lock = lockedConflict(t);
  if (lock) out.push(lock);
  const material = normalizeText(opts.material);
  const nt = normalizeText(t);
  const body = KARTE_GATE_WORDS.filter((w) => nt.includes(w) && !material.includes(w));
  if (body.length) out.push(`🔒 ${body.map((w) => `「${w}」`).join("")}は元の文に無い言葉です（健康や医療・判断の言葉は足しません）`);
  if (DECIDE.test(t) && !DECIDE.test(opts.material)) out.push("🔒 「確定」「承認」は足しません（確定は人のボタンだけです）");
  return out;
}

export type ReplacedCheck = { ok: boolean; problems: string[]; cautions: string[] };

/**
 * (2) 置きかえた後の全文の確かめ。作る時の門（gatePost）は掛けない（正しい日付まで当てるので）。
 * - 使わない言葉が無い
 * - プログラムが入れた所（日付・空き枠・リンクの印）が、置きかえる前と同じ数だけ残っている。印【…】の数も変わらない
 * - 事実の確かめ（頼み P の closedCautions）：材料に書いたお休みの日の、台帳・店の設定とのぶつかり（知らせるだけ。止めない）
 */
export function checkReplaced(
  before: string,
  after: string,
  ctx: { pieces: string[]; gateWords: string[]; closed?: { shop: ShopSettings; dates: string[]; all: Reservation[] } },
): ReplacedCheck {
  const problems: string[] = [];
  const hit = gateWordsIn(after, ctx.gateWords);
  if (hit.length) problems.push(`置きかえた後の下書きに${hit.map((w) => `「${w}」`).join("")}（使わない言葉）があります`);
  for (const p of ctx.pieces) if (p && occurrences(before, p) !== occurrences(after, p)) problems.push("プログラムが入れた所（日付・空き枠・リンクの印）が変わります");
  if ((before.match(/【[^】]*】/g) ?? []).join("") !== (after.match(/【[^】]*】/g) ?? []).join("")) problems.push("印【…】が変わります");
  const cautions = ctx.closed ? closedCautions(ctx.closed.shop, ctx.closed.dates, ctx.closed.all) : [];
  return { ok: problems.length === 0, problems: [...new Set(problems)], cautions };
}

/** 1つの直しを、(1)〜(3) の全部で確かめる。通れば元の文と直した文（前後の空白を外した物） */
export function checkEdit(
  text: string,
  raw: unknown,
  ctx: { pieces: string[]; gateWords: string[]; maxChars: number },
): { ok: true; edit: PostEdit } | { ok: false; problems: string[] } {
  const e = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const from = typeof e.from === "string" ? e.from.trim() : "";
  const to = typeof e.to === "string" ? e.to.trim() : "";
  const problems = [...fromProblems(text, from, ctx.pieces)];
  if (problems.length) return { ok: false, problems };
  problems.push(...lineProblems(to, { maxChars: ctx.maxChars, gateWords: ctx.gateWords, material: from }));
  if (to && normalizeText(to) === normalizeText(from)) problems.push("元の文と同じでした");
  if (problems.length) return { ok: false, problems };
  const r = checkReplaced(text, replaceOnce(text, from, to), ctx);
  if (!r.ok) return { ok: false, problems: r.problems };
  return { ok: true, edit: { from, to } };
}

/** 下書きの中身の印（会議を始めた時と答えが戻った時に比べる。短い印なので中身は残さない） */
export function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}-${(h >>> 0).toString(36)}`;
}
