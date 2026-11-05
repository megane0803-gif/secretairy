// 会議の言葉の門（プログラム）。分身の文・野党の「危ない所」「代わりの選び方」・補佐の3行を、欄ごとに通す。
// 通った文だけを画面に出し、日誌に書き、補佐に渡す。サーバーで通し、画面でももう一度通す。
// 今の広告の門（words.ts の gateAdSentence）は最初の1文しか取らないので使わない。ここは欄の文の全部を見る。
//   1. 形：空でない・文の数（分身は2文まで・ほかは1文）・長さ（config/ai.json の adsTeam）
//   2. 数字・日付・曜日を書いていない（数はリサーチャー＝プログラムが入れる）
//   3. 広告の使わない言葉（責める言い方・言い切り。config/ads.json の gateWords）・英字（会社やサービスの名前）が無い
//   4. 🔒 鍵つきの2つ：決めた・承認した・確定した・止めた／外した、と言わない（確定は人）。
//      体・健康・病院・薬・判断や助言の言葉（KARTE_GATE_WORDS）が材料に無ければ外す・lockedConflict（健康や医療の判断はしない）

import { normalizeText } from "../../karte/gate";
import { gateWordsIn, numbersWritten } from "../../posts/gate";
import { KARTE_GATE_WORDS } from "../../rules/locked";
import { lockedConflict } from "../../rules/validate";
import type { AdAction } from "../report";

export type TeamTextGate = { ok: true; text: string } | { ok: false; problems: string[] };

/** 文の数（「。」「！」「？」で数える。終わりに印が無い文も1つ） */
export function sentenceCount(s: string): number {
  const parts = s.split(/(?<=[。！？!?])/).map((x) => x.trim()).filter((x) => x.length > 0);
  return parts.length;
}

/** 🔒 確定は人：AI が自分で決めた・押した・変えた、と言う文 */
const DECIDED =
  /(承認|確定|決定)(しておきました|しておきます|済み|済ませ)|(確定|決定)しました|見送(っておきました|りにしておきました)|(止め|外し|戻し)(ておきました|ておきます)|(私|わたし|AI|チーム|補佐|分身|野党)(が|で)(決め|承認|確定|見送|止め|外し)/;

/** 1つの欄の文を門に通す */
export function gateTeamText(
  raw: unknown,
  opts: { maxSentences: number; maxChars: number; gateWords: string[]; material: string },
): TeamTextGate {
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!text) return { ok: false, problems: ["文がありません"] };
  const problems: string[] = [];
  if ([...text].length > opts.maxChars) problems.push(`${opts.maxChars}字より長い文でした`);
  const n = sentenceCount(text);
  if (n > opts.maxSentences) problems.push(`${opts.maxSentences}文より多く書いています`);
  const nums = numbersWritten(text);
  if (nums.length) problems.push(`数字・日付（${nums.map((x) => `「${x}」`).join("")}）を書いています。数はリサーチャー（プログラム）が入れます`);
  const hit = gateWordsIn(text, opts.gateWords);
  if (hit.length) problems.push(`${hit.map((w) => `「${w}」`).join("")}は使わない言葉です`);
  if (/[A-Za-z]/.test(text.normalize("NFKC"))) problems.push("英字（会社やサービスの名前）は書きません");
  if (DECIDED.test(text)) problems.push("🔒 決めるのはオーナーのボタンだけです。決めた・承認した・確定したとは書きません");
  const lock = lockedConflict(text);
  if (lock) problems.push(lock);
  const material = normalizeText(opts.material);
  const t = normalizeText(text);
  const body = KARTE_GATE_WORDS.filter((w) => t.includes(w) && !material.includes(w));
  if (body.length) problems.push(`🔒 ${body.map((w) => `「${w}」`).join("")}は材料に無い言葉です（健康や医療・判断の言葉は書きません）`);
  return problems.length ? { ok: false, problems } : { ok: true, text };
}

/** 過去の判断が0件なのに、過去があるように言う文（分身） */
const PAST_TALK = /(前も|前は|前回|以前|これまで|今まで|いつも|過去|前に|毎回|この前)/;

export function claimsPast(text: string): boolean {
  return PAST_TALK.test(text);
}

/** 賛成の言いかえ（野党の答えが、反対になっていない） */
const AGREE = /(賛成|同意|異論|その通り|そのとおり|案のとおり|案どおり|案の通り|良い案|よい案|いい案|反対しません|反対はしません|特に(ない|ありません|無い)|ありません。?$|問題(ない|ありません|無い))/;

/**
 * 野党の答えが、反対意見になっているか。なっていなければ理由。
 * - 賛成の言葉がある
 * - 「代わりの選び方」が、案のとおりにする（同じ言葉を同じく止める・外す）だけ
 * - 「危ない所」と「代わりの選び方」が同じ文
 */
export function notOpposition(risk: string, alternative: string, p: { action: AdAction; text: string }): string | null {
  if (AGREE.test(risk) || AGREE.test(alternative)) return "賛成の言いかえになっていました";
  if (normalizeText(risk) === normalizeText(alternative)) return "危ない所と代わりの選び方が同じでした";
  const verb = p.action === "stop" ? /止め(る|て|よう|たい|ましょう|た方|るべき|るの)/ : /外(す|して|そう|したい|しましょう|した方|すべき|すの)/;
  const negated = p.action === "stop" ? /止め(ない|ず)/ : /外(さない|さず)/;
  const keeps = /(残|戻|待|確かめ|見送|別の|ほかの|他の|代わり)/;
  if (verb.test(alternative) && !negated.test(alternative) && !keeps.test(alternative)) return "代わりの選び方が、元の案と同じ選び方でした";
  return null;
}
