// 広告の見直しで AI に渡す道具は2つだけ：「止める」と「外す」。
// 言葉を足す道具は作らない（売りのメニュー以外へ広げない）。
// どちらの道具も、番号と理由1文しか受け取らない。数（回数・お金・予約）は AI に書かせず、表からプログラムが入れる。
// 道具を呼んでも何も変わらない。案は門（gate.ts）を通ってから承認の箱に入り、変えるのはオーナーの「承認」だけ。

import type { AdAction } from "./report";

export type AdToolName = "stop_keyword" | "exclude_term";

export const AD_TOOL_ACTION: Record<AdToolName, AdAction> = {
  stop_keyword: "stop",
  exclude_term: "exclude",
};

/** 画面の言葉での道具の名前 */
export const AD_TOOL_LABEL: Record<AdToolName, string> = {
  stop_keyword: "止める",
  exclude_term: "外す",
};

export type AdToolDef = {
  name: AdToolName;
  description: string;
  input_schema: {
    type: "object";
    properties: {
      no: { type: "integer"; description: string };
      reason: { type: "string"; description: string };
    };
    required: ["no", "reason"];
    additionalProperties: false;
  };
};

const REASON = "理由を1文で（40字くらいまで）。数字は書かない（数はプログラムが表から入れる）。";

export const AD_TOOL_DEFS: AdToolDef[] = [
  {
    name: "stop_keyword",
    description:
      "広告を出す言葉を1つ止める案を出す。番号は「広告を出す言葉」の表の番号。言葉を足す・変える案は出せない。呼ぶと承認の箱に入り、オーナーが決める。",
    input_schema: {
      type: "object",
      properties: {
        no: { type: "integer", description: "止める言葉の番号（広告を出す言葉の表）" },
        reason: { type: "string", description: REASON },
      },
      required: ["no", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "exclude_term",
    description:
      "お客さんが調べた言葉を1つ外す（その言葉では広告を出さない）案を出す。番号は「お客さんが調べた言葉」の表の番号。町の名前が入った言葉は外さない。呼ぶと承認の箱に入り、オーナーが決める。",
    input_schema: {
      type: "object",
      properties: {
        no: { type: "integer", description: "外す言葉の番号（お客さんが調べた言葉の表）" },
        reason: { type: "string", description: REASON },
      },
      required: ["no", "reason"],
      additionalProperties: false,
    },
  },
];

export function isAdTool(name: string): name is AdToolName {
  return name === "stop_keyword" || name === "exclude_term";
}
