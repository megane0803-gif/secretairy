// 発信の下書きの、Claude への指示。種類が違っても形は1つで、変わるのは種類の指示文（config/posts.json）と材料だけ。
// 並びは 鍵つき → オーナーの文のルール（タブ：発信）→ 下書きの決まり。日時・数字は書かせない（プログラムが入れる）。

import type { PostMemo } from "../data/types";
import { instructionsFor } from "../rules/prompt";
import type { Rule } from "../rules/types";
import type { PostKind } from "../settings";
import { BLOG_LINK_MARK, CLOSED_MARK, OPENINGS_MARK } from "./gate";

export function postsSystem(
  rules: Rule[],
  kind: PostKind,
  shopName: string,
  gateWords: string[],
  menuName: (id: string) => string = (id) => id,
  maxChars?: number,
): string {
  const lines = [instructionsFor(rules, { tab: "posts", menuIds: [] }, menuName)];
  lines.push("");
  lines.push(`# あなたの仕事：美容室「${shopName}」の「${kind.label}」の下書きを1つ書く`);
  lines.push(`- ${kind.instruction}`);
  lines.push(
    `- 長さの目安：${kind.targetChars}字前後・${kind.shape}。${maxChars ? `長くても${maxChars}字まで（印【…】は数えない）。長くなりそうなら段落を短くする。` : ""}`,
  );
  lines.push("- 書いてよいのは、下の「お店のメモ」と「材料」にある事だけ。無い事（メニュー・値段・効き目・キャンペーンなど）は足さない。");
  lines.push("- 日時と数字は書かない（日付・時刻・曜日・値段・回数・割合、算用数字も全角の数字も漢数字も。「一度」「一緒」のような数ではない言い方はよい）。材料に数字があっても書かない。");
  lines.push(`- 空き枠の日時を伝えたい所には「${OPENINGS_MARK}」、お休みの日付を伝えたい所には「${CLOSED_MARK}」とだけ書く（お店のほうで中身を入れる）。`);
  lines.push(`- ブログのリンクを入れる所には「${BLOG_LINK_MARK}」とだけ書く。URL は書かない。`);
  lines.push(`- 次の言葉は使わない：${gateWords.map((w) => `「${w}」`).join("")}。急がせる言い方・こわがらせる言い方もしない。`);
  lines.push("- 髪・頭皮・肌の具合について「良くなる」「治る」「大丈夫」のような判断や効き目は書かない。");
  lines.push("- お客様の名前は書かない。");
  lines.push("- 返事は下書きの本文だけ。前置き・説明・かぎかっこでくくることはしない。");
  return lines.join("\n");
}

export function postsUserText(kind: PostKind, materials: Record<string, string>, memos: PostMemo[]): string {
  const lines = ["# お店のメモ（全部読んで、使えるところを使う）"];
  for (const m of memos) lines.push(`- ${m.title}：${m.text}`);
  lines.push("");
  lines.push("# 材料");
  for (const f of kind.materials) {
    const v = materials[f.id]?.trim();
    lines.push(`- ${f.label}：${v ? v : "（なし）"}`);
  }
  lines.push("");
  lines.push(`「${kind.label}」の下書きを1つ書いてください。`);
  return lines.join("\n");
}
