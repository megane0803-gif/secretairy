// 「予約を入れる」の1枚（OwnerBookSheet.tsx）の ②メニューを選ぶ段：前回のメニュー・よく使うメニュー・全部のメニュー。プログラムだけ（AI は使わない）。
// メニューは今の入口（useBook の data.menus。ルールのタブで直した分・足した分を重ねた物）から読み、id を決め打ちしない。
//   ・前回のメニュー：お客様のいちばん新しい来店の記録（karte/customers.ts の lastVisitOf。お客様一覧と同じ物）のメニュー。組み合わせは組み合わせのまま1行。
//     記録が無い・いま無いメニュー（消したメニュー）なら出さない
//   ・よく使うメニュー：今日より前の確定の予約だけを数える（仮押さえ・取り消した予約・今日とこれから先の予約は数えない）。組み合わせは組み合わせのまま1つ。
//     多い順に最大5つ、同じ数なら全部のメニューの並び順（設定に無い組み合わせは、その後ろで、中の1つ目のメニューの並び順）。1回も無い・いま無いメニューは出さない

import { COMBO_SEP, comboIdOf, resolveMenu } from "../combo";
import type { LastVisit } from "../karte/customers";
import type { Reservation } from "../reservations";
import type { Menu } from "../settings";

/** よく使うメニューの数 */
export const FREQUENT_MAX = 5;

export type MenuChoice = { id: string; menu: Menu; count?: number };

/** 選ぶ時の中身（設定に無い組み合わせ a+b は a と b を選んだことにする。設定の組み合わせはそのまま） */
export const idsOfChoice = (id: string): string[] => id.split(COMBO_SEP);

/** 前回のメニュー（記録が無い・いま無いメニューなら null） */
export function lastMenuChoice(menus: Menu[], last: LastVisit | null): MenuChoice | null {
  if (!last) return null;
  const id = comboIdOf(menus, idsOfChoice(last.menuId));
  const menu = id ? resolveMenu(menus, id) : undefined;
  return id && menu ? { id, menu } : null;
}

/** 全部のメニューの並び順での位置（設定に無い組み合わせは後ろ） */
function orderOf(menus: Menu[], id: string): number {
  const i = menus.findIndex((m) => m.id === id);
  if (i >= 0) return i;
  const first = menus.findIndex((m) => m.id === idsOfChoice(id)[0]);
  return menus.length + Math.max(0, first);
}

/** よく使うメニュー（多い順に最大5つ）。todayDate は台帳の今日（「翌日へ」で進んだ日）。その日より前の確定の予約だけを数える */
export function frequentMenus(all: Reservation[], todayDate: string, menus: Menu[], max: number = FREQUENT_MAX): MenuChoice[] {
  const counts = new Map<string, number>();
  for (const r of all) {
    if (r.status !== "confirmed" || r.date >= todayDate) continue;
    const id = comboIdOf(menus, idsOfChoice(r.menu.id));
    if (!id || !resolveMenu(menus, id)) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || orderOf(menus, a[0]) - orderOf(menus, b[0]) || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, max))
    .map(([id, count]) => ({ id, menu: resolveMenu(menus, id)!, count }));
}

/** 今選んでいる物が、その1行（前回・よく使う）とちょうど同じか */
export function isChoice(menus: Menu[], selected: string[], id: string): boolean {
  return selected.length > 0 && comboIdOf(menus, selected) === comboIdOf(menus, idsOfChoice(id));
}

/** 「4,800円」 */
export const yen = (n: number): string => `${n.toLocaleString("ja-JP")}円`;
