// 1回の来店で複数のメニュー（例：カット＋ヘッドスパ）。所要時間を足して1つの枠として扱う。
// 設定（config/menus.json）に組み合わせのメニューがあれば、それを使う（例：カット＋カラー。時間と値段は設定のまま）。
// 無い組み合わせは、id を「+」でつないだ物（例：cut+headspa）にして、時間と値段は足す。
// 判定（judge.ts）には中身のメニューを並べて渡す（時間は足され、どのメニューの最終受付・ルールも効く）。

import type { Menu } from "./settings";

export const COMBO_SEP = "+";

/** 組み合わせのメニュー（設定に無い物）。parts は中のメニューの id */
export type ComboMenu = Menu & { parts: string[] };

/** 設定の並びの順にそろえる */
function byConfigOrder(menus: Menu[], ids: string[]): string[] {
  return [...ids].sort((a, b) => menus.findIndex((m) => m.id === a) - menus.findIndex((m) => m.id === b));
}

/**
 * お客様が頼んだメニューの並びを、1つの id にする。知らないメニューがあれば null。
 * 設定の組み合わせ（includes）に当たる所は、その組み合わせのメニューにまとめる（cut＋color → cut_color）。
 */
export function comboIdOf(menus: Menu[], ids: string[]): string | null {
  const flat: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    const parts = id.includes(COMBO_SEP) ? id.split(COMBO_SEP) : [id];
    for (const p of parts) {
      const m = menus.find((x) => x.id === p);
      if (!m) return null;
      // 設定の組み合わせのメニューは中身に分けてから、まとめなおす
      for (const sub of m.includes?.length ? m.includes : [m.id]) if (!flat.includes(sub)) flat.push(sub);
    }
  }
  if (flat.length === 0) return null;
  let left = byConfigOrder(menus, flat);
  const out: string[] = [];
  // 中身の多い組み合わせから当てる
  const combos = menus.filter((m) => m.includes && m.includes.length > 1).sort((a, b) => b.includes!.length - a.includes!.length);
  for (const c of combos)
    if (c.includes!.every((x) => left.includes(x))) {
      out.push(c.id);
      left = left.filter((x) => !c.includes!.includes(x));
    }
  const all = byConfigOrder(menus, [...out, ...left]);
  return all.join(COMBO_SEP);
}

/** その id のメニュー。設定に無い組み合わせ（a+b）は、時間と値段を足して作る */
export function resolveMenu(menus: Menu[], id: string): Menu | ComboMenu | undefined {
  const found = menus.find((m) => m.id === id);
  if (found) return found;
  if (!id.includes(COMBO_SEP)) return undefined;
  const parts = id.split(COMBO_SEP).map((p) => menus.find((m) => m.id === p));
  if (parts.length < 2 || parts.some((p) => !p)) return undefined;
  const list = parts as Menu[];
  const lasts = list.map((m) => m.lastStart).filter((x): x is string => !!x).sort();
  return {
    id,
    name: list.map((m) => m.name).join("＋"),
    minutes: list.reduce((s, m) => s + m.minutes, 0),
    price: list.reduce((s, m) => s + m.price, 0),
    ...(lasts.length ? { lastStart: lasts[0] } : {}),
    parts: list.map((m) => m.id),
  };
}

/** 判定に渡すメニューの並び（設定に無い組み合わせは中身に分ける） */
export function partsOf(menus: Menu[], id: string): string[] {
  const m = resolveMenu(menus, id);
  return m && "parts" in m ? m.parts : [id];
}
