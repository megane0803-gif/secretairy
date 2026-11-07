// オーナーが直すメニューの「時間（分）・値段（円）・最終受付」（ルールのタブの「メニュー」の欄）。
// 最初の状態は config/menus.json。直した分はこのブラウザの中だけ（secretairy:menus）。同じ時間に受ける人数（capacity.ts）・休みの日（holidays.ts）と同じ扱い：
//   - 「最初に戻す」で消え、設定のファイルの値に戻る
//   - 画面の台帳（useBook の data.menus）に重ねる。メニューを読む所は、みなそこを通す（data.menus を直に読まない）
//   - サーバーの窓口（予約チャット・LINE の一言・AI の仕事・言葉でルールを足す）には、画面が直したメニューを毎回送る。
//     サーバーは readMenus で形と数を確かめてから使う（id がそろっていること・id と名前と色と includes は設定と同じ・数は幅の中）
// id・名前・色・組み合わせの中身（includes）は変えない。
// 組み合わせは2種類：設定にある組み合わせ（カット＋カラーのように includes を持つ物）は、それ自体の時間と値段を持つので自分の欄で直す
// （中のメニューを直しても自動では変わらない）。設定に無い組み合わせ（カット＋ヘッドスパ。combo.ts）は、中のメニューを足して作るので、中を直すと変わる。

import { writeBrowser, type BrowserWrite } from "./browser";
import { calDay, lastStartOf, toHHMM, toMinutes } from "./calendar";
import { partsOf, resolveMenu } from "./combo";
import { guestName } from "./guestName";
import { writeJournal } from "./journal";
import type { Reservation } from "./reservations";
import { judge, type Booked } from "./rules/judge";
import type { Menu, ShopSettings } from "./settings";

/** ブラウザの中の置き場所（browser.ts の PREFIX の後ろ） */
export const MENUS_KEY = "menus";

/** 欄の近くに出す1行 */
export const MENU_EDIT_NOTE = "このブラウザだけに保存します。最初に戻すと設定の値に戻ります";

/** 設定にある組み合わせの欄に出す1行 */
export const COMBO_EDIT_NOTE = "組み合わせのメニューは、それ自体の時間と値段を持ちます。中のメニューを直しても、自動では変わりません。";

export type MenuLimits = {
  minMinutes: number;
  maxMinutes: number;
  maxPrice: number;
  /** 時間と最終受付のきざみ（予約の枠のきざみ。shop.slotMinutes） */
  step: number;
  /** 最終受付に選べる最初の時刻（どの営業日でもいちばん早い開店） */
  firstOpen: string;
  /** 最終受付に選べる最後の時刻（いちばん遅い閉店） */
  lastClose: string;
};

/** 直せる幅（config/shop.json の menuLimits と slotMinutes・営業時間。無ければこの数） */
export function menuLimitsOf(shop: Pick<ShopSettings, "menuLimits" | "slotMinutes" | "hours">): MenuLimits {
  const l = shop.menuLimits;
  const pos = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
  const step = pos(shop.slotMinutes) ? shop.slotMinutes : 30;
  const minMinutes = pos(l?.minMinutes) ? l!.minMinutes : 30;
  const maxMinutes = pos(l?.maxMinutes) && l!.maxMinutes >= minMinutes ? l!.maxMinutes : 300;
  const maxPrice = typeof l?.maxPrice === "number" && Number.isInteger(l.maxPrice) && l.maxPrice >= 0 ? l.maxPrice : 100000;
  const days = Object.values(shop.hours).filter((h): h is { open: string; close: string } => !!h);
  const opens = days.map((h) => toMinutes(h.open));
  const closes = days.map((h) => toMinutes(h.close));
  return {
    minMinutes,
    maxMinutes,
    maxPrice,
    step,
    firstOpen: toHHMM(opens.length ? Math.min(...opens) : 600),
    lastClose: toHHMM(closes.length ? Math.max(...closes) : 1200),
  };
}

export type MenuFields = { minutes: number; price: number; lastStart: string };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 時間（分）を確かめる。よければ null、ちがえば理由の1文 */
export function minutesProblem(x: unknown, lim: MenuLimits): string | null {
  if (typeof x !== "number" || !Number.isInteger(x)) return "時間は分の整数で入れてください";
  if (x < lim.minMinutes || x > lim.maxMinutes) return `時間は ${lim.minMinutes}〜${lim.maxMinutes}分 にしてください`;
  if (x % lim.step !== 0) return `時間は ${lim.step}分 きざみにしてください`;
  return null;
}

/** 値段（円）を確かめる */
export function priceProblem(x: unknown, lim: MenuLimits): string | null {
  if (typeof x !== "number" || !Number.isInteger(x)) return "値段は円の整数で入れてください";
  if (x < 0 || x > lim.maxPrice) return `値段は 0〜${lim.maxPrice.toLocaleString("ja-JP")}円 にしてください`;
  return null;
}

/** 最終受付（HH:MM）を確かめる */
export function lastStartProblem(x: unknown, lim: MenuLimits): string | null {
  if (typeof x !== "string" || !TIME.test(x)) return "最終受付は 10:00 のような時刻で入れてください";
  const m = toMinutes(x);
  if (m < toMinutes(lim.firstOpen) || m > toMinutes(lim.lastClose)) return `最終受付は ${lim.firstOpen}〜${lim.lastClose} にしてください`;
  if (m % lim.step !== 0) return `最終受付は ${lim.step}分 きざみにしてください`;
  return null;
}

/** 3つの欄をまとめて確かめる（最初に当たった1文） */
export function fieldsProblem(f: Partial<Record<keyof MenuFields, unknown>>, lim: MenuLimits): string | null {
  return minutesProblem(f.minutes, lim) ?? priceProblem(f.price, lim) ?? lastStartProblem(f.lastStart, lim);
}

/** 時間の選びの並び（30〜300分・30分きざみ） */
export function minuteChoices(lim: MenuLimits): number[] {
  const out: number[] = [];
  const from = Math.ceil(lim.minMinutes / lim.step) * lim.step;
  for (let m = from; m <= lim.maxMinutes; m += lim.step) out.push(m);
  return out;
}

/** 最終受付の選びの並び（開店ちょうど〜閉店・30分きざみ） */
export function lastStartChoices(lim: MenuLimits): string[] {
  const out: string[] = [];
  const from = Math.ceil(toMinutes(lim.firstOpen) / lim.step) * lim.step;
  for (let m = from; m <= toMinutes(lim.lastClose); m += lim.step) out.push(toHHMM(m));
  return out;
}

/** そのメニューの今の3つ（最終受付が設定に無ければ「閉店 − 所要時間」） */
export function fieldsOf(m: Pick<Menu, "minutes" | "price" | "lastStart">, lim: MenuLimits): MenuFields {
  return { minutes: m.minutes, price: m.price, lastStart: lastStartOf(m, lim.lastClose) };
}

const sameFields = (a: MenuFields, b: MenuFields) => a.minutes === b.minutes && a.price === b.price && a.lastStart === b.lastStart;

/** 設定のメニューに、直した3つを重ねる（設定の並び・id・名前・色・includes のまま） */
export function withMenuFields(base: Menu[], edits: Record<string, MenuFields>, lim: MenuLimits): Menu[] {
  let changed = false;
  const out = base.map((m) => {
    const e = edits[m.id];
    if (!e || sameFields(e, fieldsOf(m, lim))) return m;
    changed = true;
    return { ...m, minutes: e.minutes, price: e.price, lastStart: e.lastStart };
  });
  return changed ? out : base;
}

/** ブラウザに残した分を読む（形のおかしい物・幅の外・知らない id は落として、そのメニューは設定のまま） */
export function parseMenuEdits(raw: string | null, base: Menu[], shop: Pick<ShopSettings, "menuLimits" | "slotMinutes" | "hours">): Menu[] {
  if (!raw) return base;
  const lim = menuLimitsOf(shop);
  try {
    const list = (JSON.parse(raw) as { menus?: unknown })?.menus;
    if (!Array.isArray(list)) return base;
    const edits: Record<string, MenuFields> = {};
    for (const x of list) {
      if (!x || typeof x !== "object") continue;
      const e = x as Record<string, unknown>;
      if (typeof e.id !== "string" || !base.some((m) => m.id === e.id) || edits[e.id]) continue;
      if (fieldsProblem(e, lim)) continue;
      edits[e.id] = { minutes: e.minutes as number, price: e.price as number, lastStart: e.lastStart as string };
    }
    return withMenuFields(base, edits, lim);
  } catch {
    return base;
  }
}

/** ブラウザに書く形（設定と違うメニューだけ）。どれも設定のままなら消す（null） */
export function menuEditsRaw(next: Menu[], base: Menu[], shop: Pick<ShopSettings, "menuLimits" | "slotMinutes" | "hours">): string | null {
  const lim = menuLimitsOf(shop);
  const list = base.flatMap((b) => {
    const n = next.find((m) => m.id === b.id);
    if (!n) return [];
    const f = fieldsOf(n, lim);
    return sameFields(f, fieldsOf(b, lim)) ? [] : [{ id: b.id, ...f }];
  });
  return list.length ? JSON.stringify({ menus: list }) : null;
}

/**
 * メニューの設定の印（直していなければ ""）。予約チャットの返事を始めた時と今で違えば、届いた仮押さえ・候補を入れない
 * （直す前の時間で作った仮押さえを、直した後の台帳に入れないため。台帳の epoch と同じ考え方）
 */
export function menusMark(menus: Menu[], base: Menu[], shop: Pick<ShopSettings, "menuLimits" | "slotMinutes" | "hours">): string {
  return menuEditsRaw(menus, base, shop) ?? "";
}

const sameList = (a: string[] | undefined, b: string[] | undefined) => (a ?? []).join(",") === (b ?? []).join(",") && (a === undefined) === (b === undefined);

/**
 * サーバーの窓口で、画面から来た直したメニューを読む。無い（undefined・null）なら設定のまま。
 * 設定と同じ id がそろっていること（足りない・重なる・知らない id は断る）・id と名前と色と includes は設定と同じ・3つの数は幅の中
 * （設定と同じ値はそのまま受ける）。1つでもおかしければ断る（ok: false）。edited = 設定と違うメニューがある
 */
export function readMenus(
  x: unknown,
  base: Menu[],
  shop: Pick<ShopSettings, "menuLimits" | "slotMinutes" | "hours">,
): { ok: true; value: Menu[]; edited: boolean } | { ok: false; reason: string } {
  if (x === undefined || x === null) return { ok: true, value: base, edited: false };
  const bad = (reason: string) => ({ ok: false as const, reason });
  if (!Array.isArray(x)) return bad("メニューの形がおかしいです");
  if (x.length > base.length * 2) return bad("メニューが多すぎます");
  const lim = menuLimitsOf(shop);
  const edits: Record<string, MenuFields> = {};
  for (const raw of x) {
    if (!raw || typeof raw !== "object") return bad("メニューの形がおかしいです");
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== "string") return bad("メニューの形がおかしいです");
    const b = base.find((y) => y.id === m.id);
    if (!b) return bad("知らないメニューがあります");
    if (edits[m.id]) return bad("同じメニューが2つあります");
    if (m.name !== b.name || m.color !== b.color) return bad("メニューの名前か色が設定と違います");
    const inc = m.includes;
    if (inc !== undefined && (!Array.isArray(inc) || !inc.every((s) => typeof s === "string"))) return bad("メニューの形がおかしいです");
    if (!sameList(inc as string[] | undefined, b.includes)) return bad("組み合わせの中身が設定と違います");
    const now = fieldsOf(b, lim);
    // 最終受付が設定に無いメニューは、送られなければ「閉店 − 所要時間」のまま
    const f = { minutes: m.minutes, price: m.price, lastStart: m.lastStart === undefined && b.lastStart === undefined ? now.lastStart : m.lastStart };
    const keep = f.minutes === now.minutes && f.price === now.price && f.lastStart === now.lastStart;
    if (!keep) {
      const why = fieldsProblem(f, lim);
      if (why) return bad(`${b.name}：${why}`);
    }
    edits[m.id] = f as MenuFields;
  }
  if (Object.keys(edits).length !== base.length) return bad("メニューが足りません");
  const value = withMenuFields(base, edits, lim);
  return { ok: true, value, edited: value !== base };
}

export type MenuChange = { id: string; name: string; field: keyof MenuFields; before: string; after: string };

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;

/** 直す前と後の違い（メニューの並び・時間 → 値段 → 最終受付の順） */
export function menuChanges(before: Menu[], after: Menu[], shop: Pick<ShopSettings, "menuLimits" | "slotMinutes" | "hours">): MenuChange[] {
  const lim = menuLimitsOf(shop);
  const out: MenuChange[] = [];
  for (const b of before) {
    const a = after.find((m) => m.id === b.id);
    if (!a) continue;
    const fb = fieldsOf(b, lim);
    const fa = fieldsOf(a, lim);
    if (fb.minutes !== fa.minutes) out.push({ id: b.id, name: b.name, field: "minutes", before: `${fb.minutes}分`, after: `${fa.minutes}分` });
    if (fb.price !== fa.price) out.push({ id: b.id, name: b.name, field: "price", before: yen(fb.price), after: yen(fa.price) });
    if (fb.lastStart !== fa.lastStart) out.push({ id: b.id, name: b.name, field: "lastStart", before: fb.lastStart, after: fa.lastStart });
  }
  return out;
}

/** 「カラー 90分 → 60分」「カラー 最終受付 18:00 → 17:30」 */
export function changeText(c: MenuChange): string {
  return `${c.name} ${c.field === "lastStart" ? "最終受付 " : ""}${c.before} → ${c.after}`;
}

/** 日誌の1行（だれ：オーナー） */
export function menuJournal(changes: MenuChange[]): string {
  return `メニューを直した（${changes.map(changeText).join("・")}）`;
}

/** 保存する前の一覧の1行（重なり・閉店越え・最終受付） */
export type MenuConflict = { id: string; label: string; reasons: string[] };

/**
 * 新しいメニューの時間で、これから先の確定の予約と期限の切れていない仮押さえの全部を確かめる（予約は動かさない）。
 * 当たるのは：同じ時間に受ける人数を超える（重なり）・閉店の時刻を越える・最終受付を過ぎる。
 * all = 画面の台帳（book.all。期限の切れた仮押さえは入っていない）。shop = 人数と休みの日を重ねた店。now = 店の時間帯のいま。
 * 休みの日（営業時間の無い日）の予約は、ここでは数えない（休みの日の欄が ToDo で扱う）。
 */
export function menuConflicts(o: { shop: ShopSettings; menus: Menu[]; all: Reservation[]; now: { date: string; time: string } }): MenuConflict[] {
  const nowMin = toMinutes(o.now.time);
  const active = o.all.filter((r) => r.status === "confirmed" || r.status === "hold");
  const ahead = active.filter((r) => r.date > o.now.date || (r.date === o.now.date && r.startMin > nowMin));
  const out: MenuConflict[] = [];
  for (const r of ahead) {
    const day = calDay(o.shop, r.date);
    if (!day.hours) continue;
    const menuIds = partsOf(o.menus, r.menu.id);
    const existing: Booked[] = active
      .filter((x) => x.id !== r.id && x.date === r.date)
      .map((x) => ({ date: x.date, start: x.start, menuIds: partsOf(o.menus, x.menu.id), newCustomer: false }));
    const v = judge({ rules: [], booking: { date: r.date, start: r.start, menuIds, newCustomer: false }, now: o.now, hours: day.hours, seats: o.shop.seats, menus: o.menus, existing });
    const reasons = v.base
      .filter((b) => !b.ok && (b.id === "hours" || b.id === "menu-last" || b.id === "seats"))
      .map((b) => (b.id === "seats" ? `同じ時間に受ける人数（${o.shop.seats}人）を超えて重なります` : b.reason));
    if (!reasons.length) continue;
    const menu = resolveMenu(o.menus, r.menu.id) ?? r.menu;
    const end = toHHMM(r.startMin + menu.minutes);
    out.push({
      id: r.id,
      label: `${day.label} ${r.start}–${end} ${menu.name} ${guestName(r.customer.surname)}（${r.status === "confirmed" ? "確定" : "仮押さえ"}）`,
      reasons,
    });
  }
  return out;
}

/** 一覧の印（もう一度押すまでの間に、予約か直す中身が変わったかを見る） */
export function conflictsMark(list: MenuConflict[], draftMark: string): string {
  return JSON.stringify({ d: draftMark, l: list.map((c) => [c.id, c.label, c.reasons]) });
}

/**
 * 「保存」を押した時に、保存してよいか。当たる予約が無ければ保存。
 * 当たる予約があれば、前に見せた一覧（acknowledged）と今の一覧が同じ時だけ保存（もう一度押した）。違えば一覧を出し直す
 */
export function saveStep(conflicts: MenuConflict[], draftMark: string, acknowledged: string | null): { kind: "save" } | { kind: "show"; mark: string } {
  if (conflicts.length === 0) return { kind: "save" };
  const mark = conflictsMark(conflicts, draftMark);
  return acknowledged === mark ? { kind: "save" } : { kind: "show", mark };
}

/**
 * 🔒 オーナーの「保存」ボタンだけが呼ぶ。直したメニューをこのブラウザに書き、書けた時だけ日誌に1行（だれ：オーナー）。
 * 書けなかった時は前のまま（BrowserWrite の ok: false。画面は SAVE_FAILED_MESSAGE を出し、入力を残す）。もう一度押せば書け、日誌は書けた1回だけ
 */
export function commitMenus(
  next: Menu[],
  before: Menu[],
  base: Menu[],
  shop: Pick<ShopSettings, "menuLimits" | "slotMinutes" | "hours">,
): { write: BrowserWrite; changes: MenuChange[] } {
  const changes = menuChanges(before, next, shop);
  const write = writeBrowser(MENUS_KEY, menuEditsRaw(next, base, shop));
  if (write.ok && changes.length) writeJournal({ who: "オーナー", text: menuJournal(changes) });
  return { write, changes };
}
