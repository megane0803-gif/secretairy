// 決まった返事（AI なし）。テストで Claude の代わりに使う。AI につながらないときの「お試し」にも使う。
// お店のメモと材料の文だけを並べて、種類ごとの形（段落・見出し・タグ）にする。日時・数字は書かず、印だけ置く。
// 1回目はわざと使わない言葉（「今だけ」）を1つまぜる。門が弾いて、作り直しで消える（門の働きを見られる）。

import type { PostMemo } from "../data/types";
import type { PostKind } from "../settings";
import { BLOG_LINK_MARK, CLOSED_MARK, numbersWritten, OPENINGS_MARK } from "./gate";
import type { PostsModel, PostsTurn } from "./model";

/** 材料の文のうち、日時・数字・リンクの無い物だけ（決まった返事も日時は書かない） */
function plain(s: string | undefined): string {
  return (s ?? "")
    .split(/[。\n]/)
    .map((x) => x.trim())
    .filter((x) => x && numbersWritten(x).length === 0 && !/https?:|www\./i.test(x))
    .join("。");
}

const end = (s: string) => (s && !/[。！？!?]$/.test(s) ? `${s}。` : s);

export function scriptPostText(kind: PostKind, materials: Record<string, string>, memos: PostMemo[], tryNo: number): string {
  const topic = plain(materials[kind.materials[0]?.id ?? "topic"]) || "お店からのお知らせ";
  const rest = kind.materials
    .slice(1)
    .map((f) => plain(materials[f.id]))
    .filter(Boolean)
    .map(end)
    .join("");
  const memoLines = memos.map((m) => end(m.text));
  const hurry = tryNo === 1 ? "今だけの" : "";

  if (kind.id === "notice") {
    return [
      `いつもありがとうございます。${hurry}${topic}について、お知らせです。`,
      [rest, memoLines[0]].filter(Boolean).join(""),
      memoLines.slice(1).join(""),
      `空きのある日時は${OPENINGS_MARK}です。お休みは${CLOSED_MARK}です。`,
      `くわしくはブログに書きました。${BLOG_LINK_MARK}\nまたお会いできるのを楽しみにしています。`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  if (kind.id === "blog") {
    const heads = [topic, ...memos.map((m) => m.title)];
    return [
      `${hurry}${topic}`,
      `## ${heads[0]}について\n${rest || memoLines[0] || ""}`,
      ...memos.map((m, i) => `## ${heads[i + 1]}\n${memoLines[i]}`),
    ].join("\n\n");
  }
  // SNS など短い物
  return [
    `${hurry}${topic}のご案内です。${rest}${memoLines[0] ?? ""}`,
    `空きは${OPENINGS_MARK}。${BLOG_LINK_MARK}`,
    "#美容室 #ヘアケア #ヘッドスパ #ひとりで営む美容室",
  ].join("\n\n");
}

/** 決まった返事。作り直しのたびに tryNo が進む */
export function scriptPostsModel(kind: PostKind, materials: Record<string, string>, memos: PostMemo[]): PostsModel {
  let n = 0;
  return {
    async turn(): Promise<PostsTurn> {
      n += 1;
      return { text: scriptPostText(kind, materials, memos, n), stop: "end" };
    },
  };
}
