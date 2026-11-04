// 発信の言葉の門（プログラム）。AI の下書きを見て、
//   1. 使わない言葉（config/posts.json の gateWords）が無いか（全角は半角にそろえて調べる。「％」も「%」として当てる）
//   2. 日時・数字を書いていないか（算用数字も漢数字も。「一度」「一緒」のような数ではない言葉は数えない。日時と数字はプログラムが台帳と設定から入れる）
//   3. リンクを書いていないか（ブログのリンクは印だけ）
// を確かめる。当たったら理由を返す（作り直しは write.ts）。AI は使わない。

import { KANJI_RUN, kanjiNumber, NOT_NUMBER_WORDS, notNumberRe } from "../karte/gate";

export type PostGateId = "words" | "numbers" | "links";

export type PostGateCheck = { id: PostGateId; label: string; ok: boolean };

export const POST_GATE_LABELS: Record<PostGateId, string> = {
  words: "使わない言葉が無い",
  numbers: "日時・数字は台帳と設定から",
  links: "リンクは印だけ",
};

/** ブログのリンクの印（公開したあとに人が入れる） */
export const BLOG_LINK_MARK = "【ブログのリンク：公開したあとに入れる】";
/** AI が書いてよい印。プログラムが中身に置きかえる */
export const OPENINGS_MARK = "【空き枠】";
export const CLOSED_MARK = "【お休み】";

/** 比べやすくする：全角の英数字・記号を半角に（「１００％」→「100%」）し、空白を除く */
export function normalizeForGate(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, "");
}

/** 当たった使わない言葉（重ねない・書いた順） */
export function gateWordsIn(text: string, words: string[]): string[] {
  const t = normalizeForGate(text);
  return [...new Set(words.filter((w) => w && t.includes(normalizeForGate(w))))];
}

/** 印（【…】）は AI が書いてよいので、数字・リンクの確かめからは外す */
function withoutMarks(text: string): string {
  return text.normalize("NFKC").replace(/【[^】]{0,40}】/g, "");
}

const DIGIT = /\d+/g;
const WEEKDAY = /[月火水木金土日]曜/g;
const URL = /(https?:\/\/|www\.)\S*/gi;

/**
 * 漢数字が数ではない言葉。カルテの門の言葉（「一緒」「一応」など）に、お知らせの文でよく使う言い方を足した物
 * （「一度」「一番」「十分に」「七五三」など）。前後に漢数字が続かないときだけ外す（カルテの門と同じやり方）。
 */
export const POST_NOT_NUMBER_WORDS = [
  ...NOT_NUMBER_WORDS,
  "一度", "一番", "一息", "一言", "一歩", "一休み", "一人ひとり", "一人一人", "お一人", "一つひとつ", "一つ一つ", "一部", "一面", "一新",
  "一層", "一段と", "一時的", "一生懸命", "一石二鳥", "一期一会", "十人十色", "千差万別", "万全", "万が一", "十分に", "十分な", "十分です",
  "七五三", "三日坊主", "百貨店",
];
const POST_NOT_NUMBER_RE = notNumberRe(POST_NOT_NUMBER_WORDS);

/** AI が書いた日時・数字（算用数字・全角数字・漢数字・曜日）。「一度」「一緒」のような数ではない言葉は数えない */
export function numbersWritten(text: string): string[] {
  const t = withoutMarks(text);
  const kanji = (t.replace(POST_NOT_NUMBER_RE, "　").match(KANJI_RUN) ?? []).filter((k) => kanjiNumber(k) !== null);
  return [...new Set([...(t.match(DIGIT) ?? []), ...kanji, ...(t.match(WEEKDAY) ?? [])])];
}

export function linksWritten(text: string): string[] {
  return [...new Set(withoutMarks(text).match(URL) ?? [])];
}

export type PostGateResult = { ok: boolean; checks: PostGateCheck[]; problems: string[] };

/** AI の下書き（プログラムが日時を入れる前の物）を門に通す */
export function gatePost(text: string, words: string[]): PostGateResult {
  const hitWords = gateWordsIn(text, words);
  const nums = numbersWritten(text);
  const links = linksWritten(text);
  const problems: string[] = [];
  if (!text.trim()) problems.push("下書きが空でした");
  if (hitWords.length) problems.push(`${hitWords.map((w) => `「${w}」`).join("")}は使わない言葉です`);
  if (nums.length)
    problems.push(
      `${nums.map((n) => `「${n}」`).join("")}は書かないでください（日時と数字はお店のほうで入れます。空き枠は${OPENINGS_MARK}、お休みは${CLOSED_MARK}と書く）`,
    );
  if (links.length) problems.push(`リンクは書かないでください（${BLOG_LINK_MARK}の印だけにする）`);
  const checks: PostGateCheck[] = [
    { id: "words", label: POST_GATE_LABELS.words, ok: hitWords.length === 0 },
    { id: "numbers", label: POST_GATE_LABELS.numbers, ok: nums.length === 0 },
    { id: "links", label: POST_GATE_LABELS.links, ok: links.length === 0 },
  ];
  return { ok: problems.length === 0, checks, problems };
}
