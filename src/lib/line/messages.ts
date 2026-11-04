// LINE に出す文とボタンの形。決まった文はここにまとめる（やさしい言葉で。docs/SPEC.md §3.3）。

import { NO_REAL_NAMES_NOTE } from "../notices";
import type { LineMessage } from "./api";
import type { ApprovalCard } from "./wire";

export const LINE_TEXT = {
  askCode: "この店の合言葉を送ってください（画面のホームの「LINE とつなぐ」に出ます）。",
  wrongCode: "合言葉が違うか、期限が切れています。画面の「LINE とつなぐ」で新しい合言葉を出してください。",
  tooMany: "合言葉を何回も試したので、10分ほど待ってから送ってください。",
  screenClosed: "画面を開いている間だけ動きます。画面を開いてから、もう一度送ってください。",
  buttonUsed: "このボタンはもう使われました（1つの行のボタンは1回だけ効きます）。",
  buttonNotYours: "このボタンは押せません。",
  linkGone: "つながりの期限が切れています。画面の「LINE とつなぐ」でつなぎなおしてください。",
  textOnly: "文で送ってください。",
  /** 友だち追加された時の返事に入れる注意の1行（予約チャットの入力欄の近くと同じ文） */
  noRealNames: `${NO_REAL_NAMES_NOTE}。`,
  /** 友だち追加された時（まだつながっていない人）：注意の1行と、合言葉のお願い */
  followHello: `${NO_REAL_NAMES_NOTE}。\nこの店の合言葉を送ってください（画面のホームの「LINE とつなぐ」に出ます）。`,
  linked: (hours: number) =>
    `つながりました（${hours}時間）。画面を開いている間だけ動きます。例：「明日15時に青木さんカットで仮押さえ」「シャンプー発注」`,
} as const;

export function textMessage(text: string): LineMessage {
  return { type: "text", text: text.slice(0, 5000) };
}

const nonEmpty = (s: string) => (s.trim() ? s : "—");

/** 承認待ちの1行（何を・いつ・理由）と「承認」「見送り」のボタン。ボタンの印（ticket）は1回だけ効く */
export function approvalMessage(card: ApprovalCard, ticket: string): LineMessage {
  const head = card.target === "ad" ? "承認待ち（広告の案）" : "承認待ち（予約の仮押さえ）";
  const button = (label: string, how: "approve" | "skip", style: "primary" | "secondary") => ({
    type: "button",
    style,
    height: "sm",
    action: { type: "postback", label, data: `tk=${ticket}&do=${how}`, displayText: label },
  });
  return {
    type: "flex",
    altText: `${head}：${card.what} ${card.when}`.slice(0, 400),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: head, size: "xs", color: "#888888" },
          { type: "text", text: nonEmpty(card.what), weight: "bold", wrap: true },
          { type: "text", text: nonEmpty(card.when), wrap: true },
          { type: "text", text: nonEmpty(card.why), size: "sm", color: "#555555", wrap: true },
          { type: "text", text: nonEmpty(card.check), size: "sm", wrap: true },
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        contents: [button("承認", "approve", "primary"), button("見送り", "skip", "secondary")],
      },
    },
  };
}
