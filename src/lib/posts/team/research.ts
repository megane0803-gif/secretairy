// リサーチャー（プログラム。AI は呼ばない）：下書きの事実を確かめる。数・日時はここだけが入れる。
//   - お休みの日付・空き枠が、今の台帳と店の設定に合っているか（頼み P の closedCautions と同じ確かめ。空き枠とお休みは今の台帳と設定で出しなおして比べる）
//   - プログラムが入れた所（日付・空き枠・ブログのリンクの印）が、入れた時のまま残っているか
//   - 印が残っていないか（【ブログのリンク：公開したあとに入れる】は知らせるだけ）
//   - 言葉の門（使わない言葉）・文字数が種類の目安と上限に入っているか
// 画面で、今の台帳と設定から毎回出しなおす（台帳や設定が変わったら確かめなおす）。カードの札は「日時・空き枠を確かめた」まで。

import type { CalDay } from "../../calendar";
import type { Reservation } from "../../reservations";
import type { PostKind, PostsSettings, ShopSettings } from "../../settings";
import { CLOSED_FROM_LABEL, closedCautions, postFacts } from "../facts";
import type { PostDraft } from "../deskStore";
import { BLOG_LINK_MARK, gateWordsIn } from "../gate";
import { bodyChars, maxCharsOf } from "../write";

/** カードの札（施術の説明まで確かめたとは書かない） */
export const RESEARCH_TAG = "日時・空き枠を確かめた";

export type ResearchLine = { label: string; value: string; state: "ok" | "ng" | "info" };

export type PostResearch = { lines: ResearchLine[] };

export type ResearchContext = {
  kind: PostKind;
  shop: ShopSettings;
  settings: PostsSettings;
  today: CalDay;
  now: { date: string; time: string };
  all: Reservation[];
};

type DraftFacts = Pick<PostDraft, "text" | "inserted" | "pieces" | "closedFrom" | "unreadable" | "closedDates" | "openings" | "closed" | "period">;

const same = (a: string[] | undefined, b: string[]) => (a ?? []).join("\n") === b.join("\n");
const short = (s: string) => ([...s].length > 40 ? `${[...s].slice(0, 40).join("")}…` : s);

export function researchPost(d: DraftFacts, ctx: ResearchContext): PostResearch {
  const lines: ResearchLine[] = [];
  const owner = d.unreadable
    ? ({ kind: "unreadable" } as const)
    : d.closedDates?.length
      ? ({ kind: "dates", dates: d.closedDates } as const)
      : ({ kind: "none" } as const);
  const now = postFacts(ctx.shop, ctx.settings, ctx.today, ctx.now, ctx.all, d.period ?? null, owner);
  const hasClosed = d.inserted.includes("closed") || !!d.closedDates?.length || !!d.unreadable;

  // お休みの日付
  if (hasClosed) {
    if (d.unreadable) lines.push({ label: "お休みの日付", value: "お休みの日付を読み取れなかった下書きです", state: "ng" });
    else if (d.closedDates?.length) {
      const cautions = closedCautions(ctx.shop, d.closedDates, ctx.all);
      if (cautions.length === 0)
        lines.push({ label: CLOSED_FROM_LABEL.materials, value: `${(d.closed ?? []).join("、")}。台帳の予約・店の設定とぶつかりません`, state: "ok" });
      for (const c of cautions) lines.push({ label: CLOSED_FROM_LABEL.materials, value: c, state: "ng" });
    } else if (same(d.closed, now.closed))
      lines.push({ label: CLOSED_FROM_LABEL.shop, value: `${d.closed?.length ? d.closed.join("、") : "しばらくお休みはありません"}。今の店の設定と同じです`, state: "ok" });
    else
      lines.push({
        label: CLOSED_FROM_LABEL.shop,
        value: `今の店の設定では「${now.closed.join("、") || "しばらくお休みはありません"}」です（入れた時：「${(d.closed ?? []).join("、")}」）`,
        state: "ng",
      });
  }

  // 空き枠
  if (d.inserted.includes("openings")) {
    if (d.unreadable) lines.push({ label: "空き枠", value: "お休みの日付を読み取れなかったので、空き枠は入れていません", state: "info" });
    else if (same(d.openings, now.openings))
      lines.push({ label: "空き枠（台帳から）", value: `${d.openings?.length ? d.openings.join("、") : "いまはご案内できる空きがありません"}。今の台帳でも同じです`, state: "ok" });
    else
      lines.push({
        label: "空き枠（台帳から）",
        value: `今の台帳では「${now.openings.join("、") || "いまはご案内できる空きがありません"}」です（入れた時から変わりました）`,
        state: "ng",
      });
  }

  // プログラムが入れた所
  const pieces = (d.pieces ?? []).filter(Boolean);
  if (pieces.length) {
    const missing = pieces.filter((p) => !d.text.includes(p));
    lines.push(
      missing.length
        ? { label: "プログラムが入れた所", value: `変わっています：${missing.map((p) => `「${short(p)}」`).join("")}`, state: "ng" }
        : { label: "プログラムが入れた所", value: "入れた時のまま残っています", state: "ok" },
    );
  }

  // 印
  const marks = (d.text.match(/【[^】]*】/g) ?? []).filter((m) => m !== BLOG_LINK_MARK);
  if (d.text.includes(BLOG_LINK_MARK)) lines.push({ label: "印", value: "公開したあとに入れる印が残っています", state: "info" });
  if (marks.length) lines.push({ label: "印", value: `印が残っています：${[...new Set(marks)].join("")}`, state: "ng" });

  // 言葉の門
  const hit = gateWordsIn(d.text, ctx.settings.gateWords);
  lines.push(
    hit.length
      ? { label: "言葉の門", value: `${hit.map((w) => `「${w}」`).join("")}は使わない言葉です`, state: "ng" }
      : { label: "言葉の門", value: "使わない言葉はありません", state: "ok" },
  );

  // 文字数
  const n = bodyChars(d.text);
  const max = maxCharsOf(ctx.kind, ctx.settings.lengthSlack);
  const aim = `目安 ${ctx.kind.targetChars}字前後${max ? `・${max}字まで` : ""}・印はのぞく`;
  lines.push(
    max && n > max
      ? { label: "文字数", value: `${n}字で長すぎます（${aim}）`, state: "ng" }
      : { label: "文字数", value: `${n}字（${aim}）`, state: "ok" },
  );
  return { lines };
}

/** 日誌の1行（リサーチャー） */
export function researchJournal(r: PostResearch): string {
  const ng = r.lines.filter((l) => l.state === "ng");
  return `リサーチャー：${RESEARCH_TAG}（${ng.length ? `確かめてください ${ng.length}つ：${ng.map((l) => l.value).join("。")}` : "ぶつかる所はありません"}）`;
}
