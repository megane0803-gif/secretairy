// 予約チャットの、Claude への指示。並びは 🔒 鍵つき → 店の文のルール（prompt.ts）→ 予約の係の約束 → いまの様子。
// 型のルールは Claude に判定させない。可否と空きは道具（プログラム）が出し、Claude はそれに従うだけ。

import { lastStartOf } from "../calendar";
import { instructionsFor } from "../rules/prompt";
import { candidateLabel, menuName, type SlotContext } from "./slots";
import type { Candidate } from "./wire";

const DAY_JA: Record<string, string> = { mon: "月", tue: "火", wed: "水", thu: "木", fri: "金", sat: "土", sun: "日" };

export function reserveSystem(ctx: SlotContext, shown: Candidate[]): string {
  const lines: string[] = [];
  lines.push(
    instructionsFor(ctx.rules, { tab: "reservations", menuIds: ctx.menus.map((m) => m.id) }, (id) => menuName(ctx, id)),
  );
  lines.push("");
  lines.push(`# あなたの役目：美容室「${ctx.shop.name}」の予約の係（お客様とチャットで話す）`);
  lines.push("- 空き・受けられるかは、かならず道具で調べる。時刻・空き・件数を自分で作らない・変えない。");
  lines.push("- お客様が日時とメニューを言ったら check_rules。日時がはっきりしなければ find_openings。「前と同じで」は previous_visit で前回（保存したカルテ）のメニューを見てから、そのメニューで find_openings。前回の記録なしなら、メニューをたずねる。");
  lines.push("- 候補は、道具が返した順に「1つ目：」「2つ目：」と番号を付け、道具の label の書き方のまま出す（2つまで）。");
  lines.push("- 受けられないときは、道具の reason（1文）をそのまま伝え、代わりの候補（2つまで）を出す。");
  lines.push("- お客様が候補を選んだら（「1つ目で」など）、その候補で place_hold。お客様が選ぶ前に仮押さえしない。");
  lines.push("- 仮押さえができたら「仮でお取りしました。お店から確定のご連絡をします」と伝える。「確定しました」とは言わない。");
  lines.push("- 返事は短く、やさしい言葉で3文まで。お客様の名前は名字だけ。");
  lines.push("- 予約と関係のない頼み・道具で分からないことは「お店に確かめてご連絡します」と返す。");
  lines.push("");
  lines.push("# いまの様子");
  lines.push(`- 今日：${ctx.today.date}（${ctx.today.label}）。いまの時刻：${ctx.now.time}（店の時間帯）`);
  lines.push(
    `- 話しているお客様：${ctx.customer.surname}（架空）様${ctx.customer.firstVisit ? "・初めての方" : ""}`,
  );
  const open = Object.entries(ctx.shop.hours)
    .map(([k, h]) => `${DAY_JA[k]} ${h ? `${h.open}–${h.close}` : "定休日"}`)
    .join("・");
  lines.push(`- 営業時間：${open}`);
  const close = Object.values(ctx.shop.hours).find((h) => h)?.close ?? "20:00";
  lines.push("- メニュー（id・名前・時間・最終受付）：");
  for (const m of ctx.menus) lines.push(`  - ${m.id}：${m.name}・${m.minutes}分・最終受付 ${lastStartOf(m, close)}`);
  if (shown.length) {
    lines.push("- 直前にお客様へ出した候補：");
    shown.forEach((c, i) => lines.push(`  - ${i + 1}つ目：${candidateLabel(ctx, c)}（menu_id=${c.menuId} date=${c.date} start=${c.start}）`));
  } else lines.push("- 直前にお客様へ出した候補：なし");
  return lines.join("\n");
}
