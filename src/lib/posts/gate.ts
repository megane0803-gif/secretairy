// 発信の言葉の門（プログラム）。AI の下書きを見て、
//   1. 使わない言葉（config/posts.json の gateWords）が無いか（全角は半角にそろえて調べる。「％」も「%」として当てる）
//   2. 日時・数字を書いていないか（算用数字（全角も）と曜日は全部。漢数字は「数字＋数える言葉（三回・二万円・十二月・五日）」と
//      2字以上の漢数字の並び（二十・百五十・二〇二六）だけ。「三が日」「一同」「今年一年」のような決まった言い方は通す。postNumbersWritten）
//   3. リンクを書いていないか（ブログのリンクは印だけ）
//   4. 【お休み】の前後に期間の言葉（から・まで・のあいだ）を付けていないか（期間はプログラムがまるごと入れる）
// を確かめる。当たったら理由を返す（作り直しは write.ts）。AI は使わない。

import { KANJI_RUN, kanjiNumber, NOT_NUMBER_WORDS, notNumberRe } from "../karte/gate";

export type PostGateId = "words" | "numbers" | "links" | "closedEdges";

export type PostGateCheck = { id: PostGateId; label: string; ok: boolean };

export const POST_GATE_LABELS: Record<PostGateId, string> = {
  words: "使わない言葉が無い",
  numbers: "日時・数字は台帳と設定から",
  links: "リンクは印だけ",
  closedEdges: "【お休み】の前後に期間の言葉を付けない",
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
  // 「一」が数ではない言葉（広告の理由・会議の文にも出る）。「一回」「一件」「一万」のような数え方は今までどおり数として当てる
  "一方", "一手", "一致", "一定", "一体", "一切", "一見", "一律", "一環", "一帯", "一向",
];
const POST_NOT_NUMBER_RE = notNumberRe(POST_NOT_NUMBER_WORDS);

/** AI が書いた日時・数字（算用数字・全角数字・漢数字・曜日）。「一度」「一緒」のような数ではない言葉は数えない */
export function numbersWritten(text: string): string[] {
  const t = withoutMarks(text);
  const kanji = (t.replace(POST_NOT_NUMBER_RE, "　").match(KANJI_RUN) ?? []).filter((k) => kanjiNumber(k) !== null);
  return [...new Set([...(t.match(DIGIT) ?? []), ...kanji, ...(t.match(WEEKDAY) ?? [])])];
}

/**
 * 発信だけの数の見方で足す、漢数字が数ではない言葉（POST_NOT_NUMBER_WORDS は朝の要点・広告の門・AI のチームの門と
 * 共有なので変えず、発信の門はこの表を足して使う）。「三が日」「一同」は数える言葉が付かないので、ここに無くても通る。
 */
export const POST_ONLY_NOT_NUMBER_WORDS = ["今年一年", "この一年"];
const POST_ONLY_NOT_NUMBER_RE = notNumberRe([...POST_NOT_NUMBER_WORDS, ...POST_ONLY_NOT_NUMBER_WORDS]);

/** 漢数字のすぐ後ろ（空白をはさんでも）にあれば数として当てる、数える言葉（単位）。長い物から */
export const KANJI_COUNT_UNITS = [
  "パーセント", "か月", "ヶ月", "カ月", "ヵ月", "ケ月", "箇月", "か所", "ヶ所", "カ所", "箇所",
  "年", "月", "日", "時", "分", "秒", "週", "回", "度", "件", "個", "つ", "本", "枚", "名", "人", "円", "万", "割", "倍", "歳", "才", "代",
  "%", "席", "杯", "泊", "点", "品", "種", "番", "号", "位", "冊", "台", "着", "階", "組", "部", "色",
];
const KANJI_WITH_UNIT = new RegExp(`(${KANJI_RUN.source})(\\s*)(${KANJI_COUNT_UNITS.join("|")})?`, "g");

/** 発信の門で外してよい、決まった印だけ（ほかの【…】は中の数字も当てる） */
const FIXED_MARKS = new RegExp(`${OPENINGS_MARK}|${CLOSED_MARK}|【ブログのリンク(?:[：:][^】0-9]{0,30})?】`, "g");

/**
 * 発信の下書きの日時・数字（発信の門と、試験10問の発信の問いだけが使う）。
 * 算用数字（全角も）と曜日は全部当てる。漢数字は「数字＋数える言葉」（三回・二万円・十二月・五日・三 回）の時と、
 * 2字以上の漢数字の並び（二十・百五十・二〇二六）の時に当てる（門は厳しい方に倒す）。「三が日」「一同」は通す。
 * 決まった印（【空き枠】【お休み】【ブログのリンク…】）だけを外して調べる。
 */
export function postNumbersWritten(text: string): string[] {
  const t = text.normalize("NFKC").replace(FIXED_MARKS, "・");
  const kanji: string[] = [];
  for (const m of t.replace(POST_ONLY_NOT_NUMBER_RE, "・").matchAll(KANJI_WITH_UNIT)) {
    const [whole, run, , unit] = m;
    if (unit || ([...run].length >= 2 && kanjiNumber(run) !== null)) kanji.push(unit ? whole : run);
  }
  return [...new Set([...(t.match(DIGIT) ?? []), ...kanji, ...(t.match(WEEKDAY) ?? [])])];
}

/** 【お休み】のすぐ後ろの「から」「まで」「の間」「のあいだ」「の期間」と、すぐ前の「から」（期間はプログラムがまるごと入れる） */
export function closedEdgesWritten(text: string): string[] {
  const t = text.normalize("NFKC");
  const after = [...t.matchAll(new RegExp(`${CLOSED_MARK}\\s*(から|まで|の間|のあいだ|の期間)`, "g"))].map((m) => m[1]);
  const before = [...t.matchAll(new RegExp(`(から)\\s*${CLOSED_MARK}`, "g"))].map((m) => m[1]);
  return [...new Set([...before, ...after])];
}

/** 【お休み】の前後に期間の言葉を付けた時に、作り直しへ渡す理由 */
export const CLOSED_EDGE_PROBLEM = `${CLOSED_MARK}の前後に『から』『まで』『のあいだ』を付けないでください（期間はお店のほうで入れます）`;

export function linksWritten(text: string): string[] {
  return [...new Set(withoutMarks(text).match(URL) ?? [])];
}

export type PostGateResult = { ok: boolean; checks: PostGateCheck[]; problems: string[] };

/** AI の下書き（プログラムが日時を入れる前の物）を門に通す */
export function gatePost(text: string, words: string[]): PostGateResult {
  const hitWords = gateWordsIn(text, words);
  const nums = postNumbersWritten(text);
  const links = linksWritten(text);
  const edges = closedEdgesWritten(text);
  const problems: string[] = [];
  if (!text.trim()) problems.push("下書きが空でした");
  if (hitWords.length) problems.push(`${hitWords.map((w) => `「${w}」`).join("")}は使わない言葉です`);
  if (nums.length)
    problems.push(
      `${nums.map((n) => `「${n}」`).join("")}は書かないでください（日時と数字はお店のほうで入れます。空き枠は${OPENINGS_MARK}、お休みは${CLOSED_MARK}と書く）`,
    );
  if (links.length) problems.push(`リンクは書かないでください（${BLOG_LINK_MARK}の印だけにする）`);
  if (edges.length) problems.push(CLOSED_EDGE_PROBLEM);
  const checks: PostGateCheck[] = [
    { id: "words", label: POST_GATE_LABELS.words, ok: hitWords.length === 0 },
    { id: "numbers", label: POST_GATE_LABELS.numbers, ok: nums.length === 0 },
    { id: "links", label: POST_GATE_LABELS.links, ok: links.length === 0 },
    { id: "closedEdges", label: POST_GATE_LABELS.closedEdges, ok: edges.length === 0 },
  ];
  return { ok: problems.length === 0, checks, problems };
}
