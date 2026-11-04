// 予約チャットの例文ボタン3つ。どの曜日・どの時刻に開いても、
// 「普通の予約」は受けられる日時、「ルールで断られる予約」はルールで断られる日時になるよう、プログラム（judge.ts）で選んで文を作る。

import { businessDays, calDay, toHHMM, toMinutes, type CalDay } from "../calendar";
import { findSlots, judgeSlot, menuOf, type SlotContext } from "./slots";
import type { Candidate } from "./wire";

export type Example = {
  id: "normal" | "rejected" | "previous";
  button: string;
  text: string;
  /** 例文を作った時のプログラムの見込み（画面の小さな字） */
  note: string;
};

function sentence(ctx: SlotContext, c: Candidate): string {
  return `${calDay(ctx.shop, c.date).label}の${c.start}から${menuOf(ctx, c.menuId)?.name ?? c.menuId}をお願いします`;
}

function startsOf(ctx: SlotContext, d: CalDay): string[] {
  if (!d.hours) return [];
  const out: string[] = [];
  for (let t = toMinutes(d.hours.open); t < toMinutes(d.hours.close); t += Math.max(5, ctx.shop.slotMinutes)) out.push(toHHMM(t));
  return out;
}

/** 普通の予約：次の営業日（無ければ今日）の 13:00 以降で、受けられる最初の枠。メニューは一覧の先頭 */
export function normalExample(ctx: SlotContext): Example | null {
  const menu = ctx.menus[0];
  if (!menu) return null;
  const days = businessDays(ctx.shop, ctx.today, 3);
  for (const d of [days[1], days[0], days[2]].filter(Boolean)) {
    const found = findSlots(ctx, menu.id, { date: d.date, time: "13:00" }, 1).slots[0];
    if (found) return { id: "normal", button: "普通の予約", text: sentence(ctx, found), note: "✓ 受けられる日時で作りました" };
  }
  return null;
}

/**
 * ルールで断られる予約：店の設定（営業時間・最終受付・席）は通るのに、ルールで断られる枠。
 * メニューに付いたルールのあるメニューから先に探す。見つからなければ、店の設定で断られる枠（最終受付・定休日）にする。
 */
export function rejectedExample(ctx: SlotContext): Example | null {
  const menuRuled = new Set(ctx.rules.filter((r) => r.level === "menu").map((r) => (r.level === "menu" ? r.menuId : "")));
  const menus = [...ctx.menus].sort((a, b) => Number(menuRuled.has(b.id)) - Number(menuRuled.has(a.id)));
  const days = businessDays(ctx.shop, ctx.today, 3);
  // 次の営業日を先に（今日のすぐ先の時刻だと「来店まで1分」のような例になるため）
  for (const m of menus)
    for (const d of [days[1], days[0], days[2]].filter(Boolean))
      for (const start of startsOf(ctx, d)) {
        const c = { menuId: m.id, date: d.date, start };
        const v = judgeSlot(ctx, c);
        if (v.base.every((b) => b.ok) && v.results.some((r) => !r.ok)) {
          const rule = v.results.find((r) => !r.ok)!.rule;
          return { id: "rejected", button: "ルールで断られる予約", text: sentence(ctx, c), note: `✗ 「${rule.label}」で断られる日時で作りました` };
        }
      }
  // ルールで断られる枠が無い（いまの時刻とルールの組み合わせによる）→ メニューの最終受付だけを過ぎる枠
  for (const d of [days[1], days[0], days[2]].filter(Boolean))
    for (const m of ctx.menus)
      for (const start of startsOf(ctx, d)) {
        const v = judgeSlot(ctx, { menuId: m.id, date: d.date, start });
        const bad = v.base.filter((b) => !b.ok).map((b) => b.id);
        if (bad.length === 1 && bad[0] === "menu-last")
          return {
            id: "rejected",
            button: "ルールで断られる予約",
            text: sentence(ctx, { menuId: m.id, date: d.date, start }),
            note: "✗ いまはルールで断られる枠が無いので、最終受付を過ぎる日時で作りました",
          };
      }
  return null;
}

export function previousExample(): Example {
  return { id: "previous", button: "「前と同じで」", text: "前と同じでお願いします", note: "前回のメニューで空きを探します" };
}

export function buildExamples(ctx: SlotContext): Example[] {
  return [normalExample(ctx), rejectedExample(ctx), previousExample()].filter((e): e is Example => !!e);
}
