// 広告の見直しで Claude に渡す指示。並びは 鍵つき → オーナーの文のルール（タブ：広告）→ この仕事の決まり。
// 表の数はプログラムが書く（report.ts の tableText）。AI は読んで、番号と理由1文だけを道具で返す。

import { instructionsFor } from "../rules/prompt";
import type { Rule } from "../rules/types";
import type { AdSettings } from "../settings";

export function adsSystem(rules: Rule[], settings: Pick<AdSettings, "channel" | "towns">, menuName: (id: string) => string): string {
  return [
    instructionsFor(rules, { tab: "ads", menuIds: [] }, menuName),
    "",
    "# この仕事",
    `- あなたは架空の美容室の${settings.channel}を見直す係です。4週分の表を見て、案を1つだけ出します。`,
    "- 案は道具で出す：stop_keyword（広告を出す言葉を1つ止める）か exclude_term（お客さんが調べた言葉を1つ外す）。どちらか1回だけ呼ぶ。",
    "- 言葉を足す・変える・広げる案は出さない（売りのメニュー以外へ広げない）。表に無い番号は使わない。もう止めた（外した）物は選ばない。",
    `- 町の名前（${settings.towns.join("・")}）が入った言葉は外さない。近くのお客様の言葉なので、予約が少なく見えても残す。`,
    "- お金がかかっているのに予約につながっていない言葉を選ぶ。売りのメニューの言葉は止める前によく考える。",
    "- 理由は1文（40字くらいまで）。数字は書かない（回数・お金・予約の数は、プログラムが表から入れる）。",
    "- 道具は呼ぶだけで、何も変わらない。決めるのはオーナー（承認の箱）。",
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
