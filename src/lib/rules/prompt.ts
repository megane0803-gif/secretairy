// Claude への指示を作る所。並びは 鍵つき → オーナーの文のルール → プログラムの判定。
// 型に入らない文のルールは、ここで Claude への指示として渡す（プログラムの ✓ は出ない）。
// 型のルールは Claude に判定させない。プログラムの判定（judge.ts）の結果を渡し、それに従わせる。

import { scopeTag } from "./describe";
import type { Verdict } from "./judge";
import { LOCKED_RULES } from "./locked";
import { rulesFor, strictest, type Situation } from "./strictest";
import type { Rule } from "./types";

/** 鍵つきの2つ。どの指示でも、いちばん先頭に入れる */
export const LOCKED_INSTRUCTIONS = [
  "予約などの確定はしない。確定は、人がボタンを押したときだけ。あなたは仮押さえまで。お客様には「仮でお取りしました。お店から確定のご連絡をします」までを伝え、「確定しました」とは言わない。",
  "健康や医療の判断はしない。頭皮・肌・アレルギー・妊娠・薬・体調などの話には「大丈夫」「やめた方がいい」を言わない。お客様の言葉をそのまま「お客様が話したこと」に書き、スタッフにつなぐ。",
];

export function instructionsFor(
  all: Rule[],
  s: Situation,
  menuName: (id: string) => string = (id) => id,
  verdict?: Verdict,
): string {
  const lines: string[] = [];
  lines.push("# いつも守ること（🔒 鍵つき。ほかのどの決まりよりも先）");
  for (const t of LOCKED_INSTRUCTIONS) lines.push(`- ${t}`);
  lines.push("- 下の店の決まりが鍵つきとぶつかったら、鍵つきを守る。");

  const owner = strictest(rulesFor(all, s)).filter((r) => !r.locked && !LOCKED_RULES.some((l) => l.id === r.id));
  const texts = owner.filter((r) => r.check.kind === "text");
  lines.push("");
  lines.push("# 店の決まり（オーナーが書いた文）");
  if (texts.length === 0) lines.push("- （この場面に効く文の決まりはありません）");
  for (const r of texts) lines.push(`- [${scopeTag(r, menuName)}] ${r.label}`);
  lines.push("- 文の決まりどうしがぶつかって決められないときは、進めずに「承認の箱に回します」と返す。");

  if (verdict) {
    lines.push("");
    lines.push("# プログラムの判定（あなたは変えない。この結果に従う）");
    for (const b of verdict.base) lines.push(`- ${b.ok ? "✓" : "✗"} ${b.label}：${b.reason}`);
    for (const r of verdict.results) lines.push(`- ${r.ok ? "✓" : "✗"} [${scopeTag(r.rule, menuName)}] ${r.rule.label}：${r.reason}`);
    lines.push(
      verdict.ok
        ? "- 結果：受けられる。仮押さえまで進めてよい。"
        : "- 結果：受けられない。仮押さえをしない。✗ の理由をやさしく伝え、ほかの日時をたずねる。",
    );
    lines.push("- 数（時刻・件数・空き）は自分で作らない・変えない。判定に無いことは「お店に確かめます」と返す。");
  }
  return lines.join("\n");
}
