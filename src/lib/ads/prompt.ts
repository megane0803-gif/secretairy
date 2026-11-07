// 広告の見直しで Claude に渡す指示。並びは 鍵つき → オーナーの文のルール（タブ：広告）→ この仕事の決まり。
// 表の数はプログラムが書く（report.ts の tableText）。AI は読んで、番号と理由1文だけを道具で返す。

import { instructionsFor } from "../rules/prompt";
import type { Rule } from "../rules/types";
import type { AdSettings } from "../settings";
import type { AddCandidate } from "./add";
import { yen } from "./report";

export function adsSystem(rules: Rule[], settings: Pick<AdSettings, "channel" | "towns">, menuName: (id: string) => string): string {
  return [
    instructionsFor(rules, { tab: "ads", menuIds: [] }, menuName),
    "",
    "# この仕事",
    `- あなたは架空の美容室の${settings.channel}を見直す係です。4週分の表を見て、案を1つだけ出します。`,
    "- 案は道具で出す：stop_keyword（広告を出す言葉を1つ止める）か exclude_term（お客さんが調べた言葉を1つ外す）。どちらか1回だけ呼ぶ。",
    "- この見直しで出すのは止める・外すの案だけ。言葉を足す案は、このあと別の1回で、プログラムが決めた候補（売りのメニューの名前が入って予約につながった調べ言葉）から選ぶ。売り以外へは広げない。表に無い番号は使わない。もう止めた（外した）物は選ばない。",
    `- 町の名前（${settings.towns.join("・")}）が入った言葉は外さない。近くのお客様の言葉なので、予約が少なく見えても残す。`,
    "- お金がかかっているのに予約につながっていない言葉を選ぶ。売りのメニューの言葉は止める前によく考える。",
    "- 理由は1文（40字くらいまで）。数字は書かない（回数・お金・予約の数は、プログラムが表から入れる）。",
    "- 道具は呼ぶだけで、何も変わらない。決めるのはオーナー（承認BOX）。",
    "- プログラムに弾かれたら、その理由に従って別の案を1つ出しなおす。",
  ].join("\n");
}

/** 1回目に渡す文：表と、（直すときは）オーナーの一言 */
export function adsUserText(table: string, fix?: { text: string; current: string }): string {
  const lines = ["# 4週分の表（数はプログラムが出した物）", table, ""];
  if (fix) {
    lines.push(`# いまの案：${fix.current}`);
    lines.push(`# オーナーの一言：「${fix.text}」`);
    lines.push("オーナーの一言に合わせて、案を1つだけ出しなおしてください。");
  } else {
    lines.push("この表から、案を1つだけ出してください。");
  }
  return lines.join("\n");
}

/**
 * 足す案の1回に渡す指示（止める・外すとは別の1回。作り直しはしない）。
 * 選べるのは、プログラムが作った候補（add.ts の addCandidates）の番号だけ。
 */
export function adsAddSystem(
  rules: Rule[],
  settings: Pick<AdSettings, "channel">,
  menuName: (id: string) => string,
  words: readonly string[],
  maxAdds: number,
): string {
  return [
    instructionsFor(rules, { tab: "ads", menuIds: [] }, menuName),
    "",
    "# この仕事",
    `- あなたは架空の美容室の${settings.channel}を見直す係です。お客さんが調べた言葉のうち、売りのメニュー（${words.join("・")}）の名前が入って予約につながった言葉を、広告を出す言葉に足す案を出します。`,
    "- 選べるのは、プログラムが作った「足す候補」の番号だけ。候補に無い番号は使わない。売り以外へは広げない。",
    `- 道具 add_keyword を、足したい候補ごとに1回ずつ呼ぶ（多くても${maxAdds}回）。足さなくてよいと思えば呼ばない。`,
    "- 理由は1文（40字くらいまで）。数字は書かない（回数・お金・予約の数は、プログラムが表から入れる）。",
    "- 道具は呼ぶだけで、何も変わらない。決めるのはオーナー（承認BOX）。",
    "- これは1回だけで、作り直しはしない。",
  ].join("\n");
}

/** 足す案の1回に渡す文：プログラムが作った候補の一覧（数はプログラムが書く） */
export function adsAddUserText(candidates: readonly AddCandidate[], maxAdds: number): string {
  return [
    "# 足す候補（プログラムが選んだ物。数はプログラムが出した物）",
    ...candidates.map(
      (c) => `- ${c.no}番「${c.text}」：売りの言葉「${c.word}」・4週で 押された${c.total.clicks}回・${yen(c.total.cost)}・予約${c.total.bookings}件`,
    ),
    "",
    `この候補から、足したい言葉を${maxAdds}つまで道具で出してください。`,
  ].join("\n");
}
