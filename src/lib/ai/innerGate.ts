// 予約チャットの返事の門（後ろの守り）。お客様に伝えないルール（オーナーが「お客様に伝える」にしていない物。rules/tellable.ts）の言葉が返事の文に入っていたら当てる。
// 前の守りは「伝えない理由のときは AI に文を作らせない」（agent.ts）。ここは、それでも AI の文に入ってしまった時だけ止める。
// 止めるのは2つの形だけ：
//   1. 伝えないルールの文（オーナーが書いた言葉。言葉で足したルールも同じ）がそのまま入っている
//   2. 「15分あける」「15分の間をあけて」「間を15分」のような、何分あけるかの形（「お客様に伝える」にしたルールの文の中の物は数えない）
// 「カットは60分です」「90分ほどかかります」のような、ふつうの時間の言い方は止めない。

import { LOCKED_RULES } from "../rules/locked";
import { tellsRule } from "../rules/tellable";
import type { Rule } from "../rules/types";

/** 比べるために、字の形をそろえて、空白・かっこ・句読点を外す */
function flat(text: string): string {
  return text.normalize("NFKC").replace(/[\s「」『』"'“”‘’、。，．,.！!？?・：:]/g, "");
}

/** 何分あけるかの形（数字のあとに「あける」「間をあける」など。「60分です」「90分ほどかかります」は当たらない） */
const GAP =
  /\d+分(?:ほど|くらい|ぐらい|程度)?(?:の)?(?:間|あいだ|間隔|休憩|インターバル)?(?:を|は)?(?:あけ|空け|開け|あく|空く|開く|置い|置く|置き|おい|おく|おき)|(?:間|あいだ|間隔)を\d+分/;

/** ラベルが短すぎると、ふつうの文に当たってしまうので比べない */
const MIN_LABEL = 4;

/** 当たった言葉（ルールの文か、何分あけるかの形）。当たらなければ null */
export function innerWordsHit(text: string, rules: Rule[]): string | null {
  let t = flat(text);
  const own = rules.filter((r) => !r.locked && !LOCKED_RULES.some((l) => l.id === r.id));
  for (const r of own) {
    if (tellsRule(r)) continue;
    const l = flat(r.label ?? "");
    if (l.length >= MIN_LABEL && t.includes(l)) return r.label;
  }
  // 伝えてよいルールの文は、そのまま伝えてよいので外してから形を見る
  for (const r of own) {
    const l = flat(r.label ?? "");
    if (tellsRule(r) && l.length >= MIN_LABEL) t = t.split(l).join("／");
  }
  const m = t.match(GAP);
  return m ? m[0] : null;
}
