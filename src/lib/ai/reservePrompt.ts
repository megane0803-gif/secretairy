// 予約チャットの、Claude への指示。並びは 🔒 鍵つき → 店の文のルール（prompt.ts）→ 予約の係の約束 → いまの様子。
// 型のルールは Claude に判定させない。可否と空きは道具（プログラム）が出し、Claude はそれに従うだけ。

import { calDay, lastStartOf } from "../calendar";
import { instructionsFor } from "../rules/prompt";
import { rulesFor, strictest } from "../rules/strictest";
import { tellsRule } from "../rules/tellable";
import { weekRange } from "./dates";
import { ASK_SHOP_REPLY, openTodayLine, THANKS_REPLY } from "./replies";
import { candidateLabel, menuName, type SlotContext } from "./slots";
import type { Candidate } from "./wire";

const DAY_JA: Record<string, string> = { mon: "月", tue: "火", wed: "水", thu: "木", fri: "金", sat: "土", sun: "日" };

/** この会話で作った仮押さえ（「仮押さえを外す」に使う） */
export type ConvHold = { id: string; menuId: string; date: string; start: string; label: string; approved: boolean };

export function reserveSystem(ctx: SlotContext, shown: Candidate[], holds: ConvHold[] = []): string {
  const lines: string[] = [];
  lines.push(
    instructionsFor(ctx.rules, { tab: "reservations", menuIds: ctx.menus.map((m) => m.id) }, (id) => menuName(ctx, id)),
  );
  lines.push("");
  lines.push(`# あなたの役目：美容室「${ctx.shop.name}」の予約の係（お客様とチャットで話す）`);
  lines.push("- 空き・受けられるかは、かならず道具で調べる。時刻・空き・件数を自分で作らない・変えない。");
  lines.push("- お客様が日時とメニューを言ったら check_rules。日時がはっきりしなければ find_openings。「前と同じで」は previous_visit で前回（保存したカルテ）のメニューを見てから、そのメニューで find_openings。前回の記録なしなら、メニューをたずねる。");
  lines.push("- 1回の来店で複数のメニュー（例：カットとヘッドスパ）は、menu_ids に全部入れて1つの枠として探す（所要時間はプログラムが足す）。受けられない組み合わせは、道具の reason（1文）をそのまま伝える。");
  lines.push("- 希望の日が複数あるときは、dates に全部入れて find_openings を1回呼ぶ（日ごとに1つずつ返る）。「11月の金曜」のような幅のある言い方は month と weekday で呼ぶ（当てはまる日をプログラムが全部見る）。");
  lines.push("- 日付は下の暦で数える。週と日付が食い違うとき（「来週の20日」で20日が来週に無い など）は、決めずにどちらのことか聞き返す。");
  lines.push("- 候補は、道具が返した順に「1つ目：」「2つ目：」と番号を付け、道具の label の書き方のまま出す。道具が返さなかった候補は出さない。");
  lines.push("- 候補の数の決まり（「候補は2つまで」など）や道具のことは、お客様に言わない。");
  lines.push("- 受けられないときは、道具の reason（1文）をそのまま伝え、代わりの候補を出す。");
  lines.push("- お客様に言ってよい理由は、道具の reason に書いてある物だけ。理由を足さない・言いかえない・推し量らない。");
  lines.push("- 店の中の決まり（施術の間にあける時間・同じ時間に受ける人数・準備や片付けの時間・上の「店の決まり」の文）は、お客様に言わない。下の「お客様に伝えてよい店の決まり」にある文だけは、そのまま伝えてよい。");
  lines.push("- お客様が候補を選んだら（「1つ目で」など）、その候補で place_hold。お客様が選ぶ前に仮押さえしない。");
  lines.push("- 仮押さえができたら「仮でお取りしました。お店から確定のご連絡をします」と伝える。「確定しました」とは言わない。");
  lines.push("- 仮押さえの後に、お客様が「ずらしたい」「やめたい」と言ったら、release_hold で前の仮押さえを外してから、ずらすなら新しい候補を出す（やめるなら外したことだけ伝える）。承認済みの予約は外せないので「お店に確かめてご連絡します」と返す。");
  lines.push(`- 「今日やってますか」には、下の「今日の営業」の文で、やっているかだけ答える。メニューや予約はたずねない。`);
  lines.push(`- お礼や感想には、お礼だけ返す（例：「${THANKS_REPLY}」）。予約や次の来店は勧めない。`);
  lines.push(`- 忘れ物の問い合わせなど予約ではない用事・道具で分からないことは「${ASK_SHOP_REPLY}」と返す（プログラムがお店の ToDo に足す）。`);
  lines.push("- 料金・値段は書かない（聞かれたらプログラムが店の設定から答える。設定に無い物は「お店に確かめてご連絡します」）。");
  lines.push("- 返事は短く、やさしい言葉で3文まで。お客様の名前は名字だけ。疑問の印は全角の「？」。");
  lines.push("- この店は1人（オーナー）で営業している。「スタッフ」という言葉は使わない（自分たちのことは「お店」と言う）。");
  const told = strictest(rulesFor(ctx.rules, { tab: "reservations", menuIds: ctx.menus.map((m) => m.id) })).filter(
    (r) => r.check.kind === "text" && tellsRule(r),
  );
  lines.push(`- お客様に伝えてよい店の決まり：${told.length ? told.map((r) => `「${r.label}」`).join("・") : "なし"}`);
  lines.push("");
  lines.push("# いまの様子");
  lines.push(`- 今日：${ctx.today.date}（${ctx.today.label}）。いまの時刻：${ctx.now.time}（店の時間帯）`);
  lines.push(`- 今日の営業：${openTodayLine(ctx.shop, ctx.now)}`);
  const week = (n: number) => {
    const { from, to } = weekRange(ctx.today.date, n);
    return `${calDay(ctx.shop, from).label}〜${calDay(ctx.shop, to).label}`;
  };
  lines.push(`- 暦（週は月曜から）：今週 ${week(0)}・来週 ${week(1)}・再来週 ${week(2)}`);
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
  if (holds.length) {
    lines.push("- この会話の仮押さえ：");
    for (const h of holds) lines.push(`  - ${h.label}（hold_id=${h.id}・${h.approved ? "承認済み（外せない）" : "承認待ち（外せる）"}）`);
  } else lines.push("- この会話の仮押さえ：なし");
  return lines.join("\n");
}
