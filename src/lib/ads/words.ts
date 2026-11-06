// 広告の言葉の門（プログラム）。AI が書いた文（案の理由・判定と報告の一言のまとめ）を、報告やカードに載せる前に見る。
//   1. 数字を書いていないか（算用数字・全角数字・漢数字・曜日。数はプログラムが表から入れる）
//   2. 使わない言葉が無いか（だれかを責める言い方・言い切り。config/ads.json の gateWords）
//   3. 英字を書いていないか（会社やサービスの名前を書かない。広告は「広告」のまま）
// 当たったら載せない（作り直しはしない）。AI は使わない。

import { gateWordsIn, numbersWritten } from "../posts/gate";

const MAX_REASON = 80;

/** 理由を1文にする（最初の「。」まで。長すぎる時は切る） */
export function oneSentence(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  const i = t.search(/[。！？!?]/);
  const first = i >= 0 ? t.slice(0, i + 1) : t;
  return first.length > MAX_REASON ? `${first.slice(0, MAX_REASON - 1)}…` : first;
}

export type AdWordGate = { ok: true; text: string } | { ok: false; problems: string[] };

/** 1文にして門に通す。通れば載せてよい1文、だめなら理由 */
export function gateAdSentence(text: string, words: string[]): AdWordGate {
  const s = oneSentence(text ?? "");
  if (!s) return { ok: false, problems: ["文がありません"] };
  const problems: string[] = [];
  const nums = numbersWritten(s);
  if (nums.length) problems.push(`数字（${nums.map((n) => `「${n}」`).join("")}）を書いています。数はプログラムが入れます`);
  const hit = gateWordsIn(s, words);
  if (hit.length) problems.push(`${hit.map((w) => `「${w}」`).join("")}は使わない言葉です`);
  if (/[A-Za-z]/.test(s.normalize("NFKC"))) problems.push("英字（会社やサービスの名前）は書きません");
  return problems.length ? { ok: false, problems } : { ok: true, text: s };
}
