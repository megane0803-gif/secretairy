// 発信の言葉の門（プログラム）。AI の下書きを見て、
//   1. 使わない言葉（config/posts.json の gateWords）が無いか（全角は半角にそろえて調べる。「％」も「%」として当てる）
//   2. 日時・数字を書いていないか（日時と数字はプログラムが台帳と設定から入れる）
//   3. リンクを書いていないか（ブログのリンクは印だけ）
// を確かめる。当たったら理由を返す（作り直しは write.ts）。AI は使わない。

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

/** AI が書いた日時・数字（算用数字・全角数字・曜日） */
export function numbersWritten(text: string): string[] {
  const t = withoutMarks(text);
  return [...new Set([...(t.match(DIGIT) ?? []), ...(t.match(WEEKDAY) ?? [])])];
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
