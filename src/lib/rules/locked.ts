// 鍵つきの2つ。店の設定ではなく仕組みそのものの約束なので、ここに書く。
// オーナーが足すルールでも、この2つは緩められない。

import type { Rule } from "./types";

export const LOCKED_RULES: Rule[] = [
  {
    id: "locked-human-confirms",
    level: "global",
    label: "予約などの確定は、人がボタンを押したときだけ。AI は仮押さえまで",
    check: { kind: "text" },
    locked: true,
  },
  {
    id: "locked-no-medical",
    level: "global",
    label: "健康や医療の判断はしない。お客様の言葉をそのまま人に渡す",
    check: { kind: "text" },
    locked: true,
  },
];
