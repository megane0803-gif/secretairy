// LINE に出す文とボタンの形。決まった文はここにまとめる（やさしい言葉で。docs/SPEC.md §3.3）。
// 言葉の使い分け：ホームの「LINE とつなぐ」に出て店の LINE に送る6けたの印 =「つなぐ番号」。
// 環境変数 LINE_OWNER_PASSCODE =「オーナー用の合言葉」（LINE には出さない）。

import { NO_REAL_NAMES_NOTE } from "../notices";
import type { LineMessage } from "./api";
import type { ApprovalCard } from "./wire";

export const LINE_TEXT = {
  askCode: "つなぐ番号を送ってください（画面のホームの「LINE とつなぐ」に出ます）。",
  wrongCode: "つなぐ番号が違うか、期限が切れています。画面の「LINE とつなぐ」で新しいつなぐ番号を出してください。",
  tooMany: "つなぐ番号を何回も試したので、10分ほど待ってから送ってください。",
  screenClosed: "画面を開いている間だけ動きます。画面を開いてから、もう一度送ってください。",
  buttonUsed: "このボタンはもう使われました（1つの行のボタンは1回だけ効きます）。",
  buttonNotYours: "このボタンは押せません。",
  linkGone: "つながりの期限が切れています。画面の「LINE とつなぐ」でつなぎなおしてください。",
  textOnly: "文で送ってください。",
  /** 友だち追加された時の返事に入れる注意の1行（予約チャットの入力欄の近くと同じ文） */
  noRealNames: `${NO_REAL_NAMES_NOTE}。`,
  /** 友だち追加された時（まだつながっていない人）：注意の1行と、つなぐ番号のお願い */
  followHello: `${NO_REAL_NAMES_NOTE}。\nつなぐ番号を送ってください（画面のホームの「LINE とつなぐ」に出ます）。`,
  /** もう決まった行のボタンを押した時（予約の仮押さえ・広告の案で同じ言い方） */
  decidedHold: "この仮押さえは、もう決まっているか、期限が切れています。今の様子は画面で確かめてください。",
  decidedAd: "この広告の案は、もう決まっているか、期限が切れています。今の様子は画面で確かめてください。",
  /** 一言を振り分けられなかった時（長さに関係ない理由もあるので「短くして」とは言わない） */
  retry: (message: string) => `うまくいきませんでした。${withPeriod(message)}もう一度送ってください。`,
  linked: (hours: number) =>
    `LINE とつながりました（${hours}時間有効です）。画面を開いている間だけ動きます。例：「明日15時に青木さんカットで仮押さえ」「シャンプー発注」`,
} as const;

/** 文の終わりに「。」が無ければ足す（「。。」にはしない） */
export function withPeriod(s: string): string {
  const t = s.trim();
  return !t || t.endsWith("。") ? t : `${t}。`;
}

/** 画面の右の列に出す「LINE の様子」の1行（送った＝今日の送信数に数える／返事した＝数えない） */
export function sentStatus(via: "push" | "reply", text: string): string {
  return `LINE に${via === "push" ? "送りました（今日の送信数に数えます）" : "返事しました"}：${text.slice(0, 40)}`;
}

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
