// 「○○様に別の日時を案内」の ToDo を作る1か所（プログラム。AI は使わない。docs/SPEC.md §1.3・§1.4・§1.11）。
// 足す入口は3つあり、どれもここを通す（文・鍵・期限をそろえるため。後から入口を足す時もここを使う）：
//   - 承認の箱の「直す」「見送り」と、LINE のボタンの「見送り」（book/state.ts の withReleased）
//   - 予約サイトで人数をこえて仮押さえを外した時（book/site.ts）
//   - 承認待ちの仮押さえの枠が確定の予約で埋まった時（todo/full.ts。仮押さえはそのまま）
//   - 予約（確定・仮押さえ）がある日をオーナーが休みの日にした時（book/holiday.ts。予約はそのまま）
// 文には元の頼み（仮押さえ）の日時とメニューを添える。同じお客様の ToDo が何件あっても、どの予約の分か見分けられるように：
//   「大橋様に別の日時を案内（11/8（日） 15:00 カットの代わり）」
// 鍵は「予約:お客様＠日時」（同じ仮押さえの分は、どの入口からでも2回は入らない）。

import type { AddedTodo } from "../book/state";
import { calDay } from "../calendar";
import { resolveMenu } from "../combo";
import { browserMenus } from "../menuEdits";
import { getMenus, getShop } from "../settings";
import { guestName } from "../guestName";
import { reserveKey } from "./keys";

/** 元の頼み（仮押さえ）。ブラウザに残っていなかった時は null */
export type RescheduleFrom = { id: string; customerId: string; menuId: string; date: string; start: string };

/** ToDo の文。元の頼みが分からない時は今までの文だけ */
export function rescheduleTitle(surname: string, from?: Pick<RescheduleFrom, "date" | "start" | "menuId"> | null): string {
  const base = `${guestName(surname)}に別の日時を案内`;
  if (!from) return base;
  // メニューの名前だけ読む（時間は文に入れない）。足したメニュー（ルールのタブ）の名前も出すので、このブラウザに残したメニューから読む
  const menu = resolveMenu(browserMenus(getMenus(), getShop()), from.menuId)?.name ?? from.menuId;
  return `${base}（${calDay(getShop(), from.date).label} ${from.start} ${menu}の代わり）`;
}

/**
 * 足す ToDo。id は入口ごとの頭（直す・見送り = "td"・予約サイト = "td-site"・枠が埋まった = "td-full"・休みの日 = "td-hol"）＋仮押さえ（予約）の番号。
 * due（YYYY-MM-DD）を渡すと期限（今日中）にする。
 */
export function rescheduleTodo(input: {
  idPrefix: "td" | "td-site" | "td-full" | "td-hol";
  /** 元の仮押さえの番号（元の頼みが分からなくても、承認の箱の行から分かる） */
  reservationId: string;
  surname: string;
  from: RescheduleFrom | null | undefined;
  nowIso: string;
  due?: string;
}): AddedTodo {
  const { from } = input;
  return {
    id: `${input.idPrefix}-${input.reservationId}`,
    title: rescheduleTitle(input.surname, from),
    createdAt: input.nowIso,
    done: false,
    source: "reserve",
    ...(from ? { key: reserveKey(from.customerId, from.date, from.start) } : {}),
    ...(input.due && /^\d{4}-\d{2}-\d{2}$/.test(input.due) ? { due: input.due } : {}),
  };
}
