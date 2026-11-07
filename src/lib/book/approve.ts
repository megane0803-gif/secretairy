// 承認の時の確かめ（画面の承認の箱と、合言葉でつないだ LINE の承認のボタンの両方で同じここを使う）。
// 休みの日（定休日・設定の closedDates・オーナーが決めた休みの日）の仮押さえと、開始の時刻をもう過ぎた仮押さえと、暦に無い日付の仮押さえは確定しない。
// ほかのルールに当たる時（✗ いまの台帳・ルールでは受けられません）は今までどおり、人が確かめて押せば確定できる（注意だけ）。

import { calDay, dayDiff, isRealDate, toMinutes } from "../calendar";
import type { ChatReservation } from "../reservations";
import type { ShopSettings } from "../settings";

/** 確定しない理由（1文）。確定してよければ null。now は店の時間帯での、いまの日付と時刻（「翌日へ」も入れた物） */
export function approveBlocker(
  shop: ShopSettings,
  now: { date: string; time: string },
  r: Pick<ChatReservation, "date" | "start">,
): string | null {
  // 暦に無い日付（11/32 など）の仮押さえは確定しない（文字のまま確かめる。暦の計算で次の月に回すと別の日に見えるため）
  if (!isRealDate(r.date) || !isRealDate(now.date)) return "日付が暦にないので確定できません（「見送り」で仮押さえを外せます）";
  const day = calDay(shop, r.date);
  if (!day.open)
    return `${day.label}は${day.holiday ? "休みの日" : "お休みの日"}なので確定できません（お客様に別の日時を案内するときは「直す」か「見送り」を押してください）`;
  const lead = dayDiff(now.date, r.date) * 1440 + toMinutes(r.start) - toMinutes(now.time);
  if (lead <= 0) return `開始の時刻（${day.label} ${r.start}）をもう過ぎたので確定できません（「見送り」で仮押さえを外せます）`;
  return null;
}
