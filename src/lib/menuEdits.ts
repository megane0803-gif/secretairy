// オーナーが直すメニューの「時間（分）・値段（円）・最終受付」（ルールのタブの「メニュー」の欄）。
// 最初の状態は config/menus.json。直した分はこのブラウザの中だけ（secretairy:menus）。同じ時間に受ける人数（capacity.ts）・休みの日（holidays.ts）と同じ扱い：
//   - 「最初に戻す」で消え、設定のファイルの値に戻る
//   - 画面の台帳（useBook の data.menus）に重ねる。メニューを読む所は、みなそこを通す（data.menus を直に読まない）
//   - サーバーの窓口（予約チャット・LINE の一言・AI の仕事・言葉でルールを足す）には、画面が直したメニューを毎回送る。
//     サーバーは readMenus で形と数を確かめてから使う（id がそろっていること・id と名前と色と includes は設定と同じ・数は幅の中）
// 設定にあるメニューの id・名前・色・組み合わせの中身（includes）は変えない。
// オーナーはメニューを足せる（単品だけ。id は own-1, own-2 …。プログラムが付け、消しても番号を使い回さない）。足したメニューは同じ置き場所に入り、
// 時間・値段・最終受付は設定のメニューと同じ形で直せる。消せるのは足したメニューだけで、台帳（予約・カルテ）やルールで使っている間は消せない。
// 「最初に戻す」で足したメニューも消える（台帳も最初に戻るので、足したメニューを使った予約も一緒に消える）。
// 組み合わせは2種類：設定にある組み合わせ（カット＋カラーのように includes を持つ物）は、それ自体の時間と値段を持つので自分の欄で直す
// （中のメニューを直しても自動では変わらない）。設定に無い組み合わせ（カット＋ヘッドスパ。combo.ts）は、中のメニューを足して作るので、中を直すと変わる。

import { innerWordsHit, workTextHit } from "./ai/innerGate";
import { readBrowser, writeBrowser, type BrowserWrite } from "./browser";
import { MENU_COLORS } from "./book/menuColor";
import { calDay, lastStartOf, toHHMM, toMinutes } from "./calendar";
import { COMBO_SEP, partsOf, resolveMenu } from "./combo";
import { guestName } from "./guestName";
import { writeJournal } from "./journal";
import type { Reservation } from "./reservations";
import { judge, type Booked } from "./rules/judge";
import type { Rule } from "./rules/types";
import type { Menu, ShopSettings } from "./settings";

/** ブラウザの中の置き場所（browser.ts の PREFIX の後ろ） */
export const MENUS_KEY = "menus";

/** 欄の近くに出す1行 */
export const MENU_EDIT_NOTE = "このブラウザだけに保存します。最初に戻すと設定の値に戻ります";

/** 設定にある組み合わせの欄に出す1行 */
export const COMBO_EDIT_NOTE = "組み合わせのメニューは、それ自体の時間と値段を持ちます。中のメニューを直しても、自動では変わりません。";

type MenuShop = Pick<ShopSettings, "menuLimits" | "slotMinutes" | "hours">;

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
  /** オーナーが足せるメニューの数の上限 */
  maxAdded: number;
  /** 足すメニューの名前の字数の上限 */
  maxNameChars: number;
};

/** 直せる幅（config/shop.json の menuLimits と slotMinutes・営業時間。無ければこの数） */
export function menuLimitsOf(shop: MenuShop): MenuLimits {
  const l = shop.menuLimits;
  const pos = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
  const step = pos(shop.slotMinutes) ? shop.slotMinutes : 30;
  const minMinutes = pos(l?.minMinutes) ? l!.minMinutes : 30;
  const maxMinutes = pos(l?.maxMinutes) && l!.maxMinutes >= minMinutes ? l!.maxMinutes : 300;
  const maxPrice = typeof l?.maxPrice === "number" && Number.isInteger(l.maxPrice) && l.maxPrice >= 0 ? l.maxPrice : 100000;
  const maxAdded = typeof l?.maxAdded === "number" && Number.isInteger(l.maxAdded) && l.maxAdded >= 0 ? l.maxAdded : 10;
  const maxNameChars = pos(l?.maxNameChars) ? l!.maxNameChars! : 20;
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
    maxAdded,
    maxNameChars,
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

// ---- オーナーが足したメニュー ----

/** 足したメニューの id の頭（own-1, own-2 …） */
export const OWN_MENU_PREFIX = "own-";
const OWN_ID = /^own-([1-9]\d{0,3})$/;

/** オーナーが足したメニューの id か */
export function isOwnMenuId(id: unknown): id is string {
  return typeof id === "string" && OWN_ID.test(id);
}

/** 足したメニューの番号（own-3 → 3）。足したメニューでなければ 0 */
function ownNo(id: string): number {
  const m = OWN_ID.exec(id);
  return m ? Number(m[1]) : 0;
}

/** いちばん大きい番号 */
const maxOwnNo = (menus: Pick<Menu, "id">[]) => menus.reduce((n, m) => Math.max(n, ownNo(m.id)), 0);

/** 次に足すメニューの id（今ある物と、前に付けた番号 seq のどちらよりも大きい番号。消しても使い回さない） */
export function nextOwnId(menus: Pick<Menu, "id">[], seq: number): string {
  return `${OWN_MENU_PREFIX}${Math.max(seq, maxOwnNo(menus)) + 1}`;
}

/** 足したメニューの色に選べる物（設定のメニューの色のうち、帯の色の値がある物。設定の並びの順） */
export function menuColorChoices(base: Pick<Menu, "color">[]): string[] {
  const known = new Set<string>(MENU_COLORS);
  const out: string[] = [];
  for (const m of base) if (m.color && known.has(m.color) && !out.includes(m.color)) out.push(m.color);
  return out.length ? out : [...MENU_COLORS];
}

/** 最初に選んでおく色：まだどのメニューにも使われていない色。全部使われていれば一覧の最初の色 */
export function defaultMenuColor(base: Pick<Menu, "color">[], menus: Pick<Menu, "color">[]): string {
  const choices = menuColorChoices(base);
  return choices.find((c) => !menus.some((m) => m.color === c)) ?? choices[0];
}

/** 名前を比べる形（字の形をそろえ、前後の空白を取る） */
const nameKey = (name: string) => name.normalize("NFKC").trim();

/**
 * 足すメニューの名前を確かめる。よければ null、ちがえば理由の1文。
 * 前後の空白を取って 1〜maxNameChars 字・改行や見えない字は断る・「＋」（組み合わせの印）は使えない・
 * ほかのメニュー（設定にある物・足した物）と同じ名前は断る・英字が長く続く名前（返事の門 workTextHit と同じ目安）と、
 * 店の中の決まりの言葉（innerWordsHit が当たる言葉。rules = 今のルール）が入った名前も断る。
 */
export function menuNameProblem(name: unknown, others: Pick<Menu, "name">[], lim: Pick<MenuLimits, "maxNameChars">, rules: Rule[] = []): string | null {
  if (typeof name !== "string") return "名前を入れてください";
  if (/[\r\n\u2028\u2029]/.test(name)) return "名前に改行は入れられません";
  if (/[\u0000-\u001f\u007f\u200b-\u200f\ufeff]/.test(name)) return "名前に使えない字が入っています";
  const t = name.trim();
  if (!t) return "名前を入れてください";
  if ([...t].length > lim.maxNameChars) return `名前は ${lim.maxNameChars}字 までにしてください`;
  if (/[＋+]/.test(t.normalize("NFKC")) || t.includes(COMBO_SEP)) return "「＋」は組み合わせの印なので、名前には使えません";
  if (workTextHit(t)) return "英字が長く続く名前は使えません。短くするか、カタカナにしてください";
  if (innerWordsHit(t, rules)) return "店の中の決まりの言葉が入った名前は使えません";
  const k = nameKey(t);
  const same = others.find((o) => nameKey(o.name) === k);
  if (same) return `同じ名前のメニュー（${same.name}）があります`;
  return null;
}

/** 足したメニュー1つ（ブラウザに残す形・サーバーに送る形） */
type OwnMenu = { id: string; name: string; minutes: number; price: number; lastStart: string; color: string };

/**
 * 足したメニュー1つを確かめる（ブラウザから読む時とサーバーで受け取る時の両方）。よければ null、ちがえば理由の1文。
 * others = それより前のメニュー（設定の物と、先に読んだ足した物。名前の重なりを見る）
 */
export function ownMenuProblem(x: unknown, others: Menu[], base: Menu[], lim: MenuLimits, rules: Rule[] = []): string | null {
  if (!x || typeof x !== "object") return "メニューの形がおかしいです";
  const m = x as Record<string, unknown>;
  if (!isOwnMenuId(m.id)) return "メニューの番号の形がおかしいです";
  if (others.some((o) => o.id === m.id)) return "同じメニューが2つあります";
  if (m.includes !== undefined) return "足したメニューに組み合わせは作れません";
  if (typeof m.name !== "string" || m.name !== m.name.trim()) return "メニューの名前の形がおかしいです";
  const name = menuNameProblem(m.name, others, lim, rules);
  if (name) return name;
  const f = fieldsProblem(m, lim);
  if (f) return `${m.name}：${f}`;
  if (typeof m.color !== "string" || !menuColorChoices(base).includes(m.color)) return `${m.name}：色は今あるメニューの色から選んでください`;
  return null;
}

const ownOf = (m: Record<string, unknown>): OwnMenu => ({
  id: m.id as string,
  name: m.name as string,
  minutes: m.minutes as number,
  price: m.price as number,
  lastStart: m.lastStart as string,
  color: m.color as string,
});

/** 足したメニューを Menu の形に（includes は持たない） */
const ownMenu = (o: OwnMenu): Menu => ({ id: o.id, name: o.name, minutes: o.minutes, price: o.price, lastStart: o.lastStart, color: o.color });

/** 足したメニューだけ（並びのまま） */
export function ownMenusOf(menus: Menu[]): Menu[] {
  return menus.filter((m) => isOwnMenuId(m.id));
}

/**
 * ブラウザに残した分を読む。menus = 設定のメニュー（直した3つを重ねた物）＋足したメニュー（足した順）。
 * seq = これまでに付けた足したメニューのいちばん大きい番号（消しても使い回さないため）。
 * 形のおかしい物・幅の外・知らない id は落として、そのメニューは設定のまま（足した物は落とす）。
 * 直しF の形（足したメニューが無い物）もそのまま読める。
 */
export function readMenuStore(raw: string | null, base: Menu[], shop: MenuShop): { menus: Menu[]; seq: number } {
  if (!raw) return { menus: base, seq: 0 };
  const lim = menuLimitsOf(shop);
  try {
    const parsed = JSON.parse(raw) as { menus?: unknown; added?: unknown; seq?: unknown } | null;
    if (!parsed || typeof parsed !== "object") return { menus: base, seq: 0 };
    const list = Array.isArray(parsed.menus) ? parsed.menus : [];
    const edits: Record<string, MenuFields> = {};
    for (const x of list) {
      if (!x || typeof x !== "object") continue;
      const e = x as Record<string, unknown>;
      if (typeof e.id !== "string" || !base.some((m) => m.id === e.id) || edits[e.id]) continue;
      if (fieldsProblem(e, lim)) continue;
      edits[e.id] = { minutes: e.minutes as number, price: e.price as number, lastStart: e.lastStart as string };
    }
    const edited = withMenuFields(base, edits, lim);
    const added: Menu[] = [];
    for (const x of Array.isArray(parsed.added) ? parsed.added : []) {
      if (added.length >= lim.maxAdded) break;
      if (ownMenuProblem(x, [...edited, ...added], base, lim)) continue;
      added.push(ownMenu(ownOf(x as Record<string, unknown>)));
    }
    const stored = typeof parsed.seq === "number" && Number.isInteger(parsed.seq) && parsed.seq > 0 && parsed.seq < 10000 ? parsed.seq : 0;
    return { menus: added.length ? [...edited, ...added] : edited, seq: Math.max(stored, maxOwnNo(added)) };
  } catch {
    return { menus: base, seq: 0 };
  }
}

/** ブラウザに残した分を読む（メニューだけ） */
export function parseMenuEdits(raw: string | null, base: Menu[], shop: MenuShop): Menu[] {
  return readMenuStore(raw, base, shop).menus;
}

/**
 * ブラウザに書く形（設定と違うメニューの3つ・足したメニュー・付けた番号）。どれも設定のままで、番号も付けていなければ消す（null）。
 * seq = 前に付けた番号（消した分も数える。足したメニューの番号より小さければ、そちらを使う）
 */
export function menuEditsRaw(next: Menu[], base: Menu[], shop: MenuShop, seq: number = 0): string | null {
  const lim = menuLimitsOf(shop);
  const list = base.flatMap((b) => {
    const n = next.find((m) => m.id === b.id);
    if (!n) return [];
    const f = fieldsOf(n, lim);
    return sameFields(f, fieldsOf(b, lim)) ? [] : [{ id: b.id, ...f }];
  });
  const added = ownMenusOf(next).map((m) => ({ id: m.id, name: m.name, ...fieldsOf(m, lim), color: m.color ?? "" }));
  const n = Math.max(seq, maxOwnNo(added));
  if (!list.length && !added.length && n === 0) return null;
  return JSON.stringify({ menus: list, ...(added.length ? { added } : {}), ...(n > 0 ? { seq: n } : {}) });
}

/**
 * メニューの設定の印（直していなければ ""）。予約チャットの返事を始めた時と今で違えば、届いた仮押さえ・候補を入れない
 * （直す前の時間で作った仮押さえを、直した後の台帳に入れないため。台帳の epoch と同じ考え方）。
 * 足したメニュー・消したメニューも印に入る（足した物の名前・時間・色・番号。消せば印が変わる）
 */
export function menusMark(menus: Menu[], base: Menu[], shop: MenuShop): string {
  return menuEditsRaw(menus, base, shop) ?? "";
}

/** 今このブラウザに残っているメニュー（画面の外の lib から読む時。React の画面は useBook の data.menus を通す） */
export function browserMenus(base: Menu[], shop: MenuShop): Menu[] {
  return parseMenuEdits(readBrowser(MENUS_KEY), base, shop);
}

const sameList = (a: string[] | undefined, b: string[] | undefined) => (a ?? []).join(",") === (b ?? []).join(",") && (a === undefined) === (b === undefined);

/**
 * サーバーの窓口で、画面から来たメニューを読む。無い（undefined・null）なら設定のまま。
 * 設定の id は全部そろっていること（足りない・重なるは断る）・id と名前と色と includes は設定と同じ・3つの数は幅の中
 * （設定と同じ値はそのまま受ける）。足したメニュー（own- で始まる id）は形を確かめてから受ける（id の形・名前・3つの数・色・
 * includes が無い・数の上限・名前の重なり）。それ以外の id は断る。1つでもおかしければ断る（ok: false）。
 * edited = 設定と違うメニューがある（直した・足した）。rules = 今のルール（名前に店の中の決まりの言葉が入っていないかを見る。無ければ形だけ）
 */
export function readMenus(
  x: unknown,
  base: Menu[],
  shop: MenuShop,
  rules: Rule[] = [],
): { ok: true; value: Menu[]; edited: boolean } | { ok: false; reason: string } {
  if (x === undefined || x === null) return { ok: true, value: base, edited: false };
  const bad = (reason: string) => ({ ok: false as const, reason });
  if (!Array.isArray(x)) return bad("メニューの形がおかしいです");
  const lim = menuLimitsOf(shop);
  if (x.length > base.length + lim.maxAdded) return bad("メニューが多すぎます");
  const edits: Record<string, MenuFields> = {};
  const added: Menu[] = [];
  for (const raw of x) {
    if (!raw || typeof raw !== "object") return bad("メニューの形がおかしいです");
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== "string") return bad("メニューの形がおかしいです");
    const b = base.find((y) => y.id === m.id);
    if (!b) {
      if (!isOwnMenuId(m.id)) return bad("知らないメニューがあります");
      if (added.length >= lim.maxAdded) return bad(`足したメニューは ${lim.maxAdded}個 までです`);
      const why = ownMenuProblem(m, [...base, ...added], base, lim, rules);
      if (why) return bad(why);
      added.push(ownMenu(ownOf(m)));
      continue;
    }
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
  const edited = withMenuFields(base, edits, lim);
  const value = added.length ? [...edited, ...added] : edited;
  return { ok: true, value, edited: value !== base };
}

/**
 * 足したメニューの名前に、店の中の決まりの言葉（今のルール）が入っていないか（サーバーでルールを読んだ後にもう一度見る）。
 * よければ null、ちがえば理由の1文
 */
export function ownNamesProblem(menus: Menu[], rules: Rule[]): string | null {
  for (const m of ownMenusOf(menus)) if (innerWordsHit(m.name, rules)) return "店の中の決まりの言葉が入ったメニューの名前があります";
  return null;
}

/** 台帳で、そのメニューを使っている所（予約・カルテ・ルール）。空なら消してよい */
export type MenuUse = { kind: "reservation" | "karte" | "rule"; label: string };

/**
 * そのメニュー（足したメニュー）が使われている所。all = 画面の台帳（book.all。過ぎた予約・これから先の確定・期限の切れていない仮押さえ。
 * 設定に無い組み合わせ（own-1+cut）の中にあっても数える）。kartes = 保存したカルテ・rules = 今のルール（メニューごとのルール・いっしょに受けない組み合わせ）
 */
export function menuUses(
  id: string,
  o: {
    menus: Menu[];
    all: Reservation[];
    kartes?: { menuId: string; date: string; customerId: string }[];
    rules?: Rule[];
    dayLabel?: (date: string) => string;
    surnameOf?: (customerId: string) => string | undefined;
  },
): MenuUse[] {
  const label = o.dayLabel ?? ((d: string) => d);
  const uses = (menuId: string) => menuId === id || menuId.split(COMBO_SEP).includes(id);
  const out: MenuUse[] = [];
  for (const r of o.all)
    if (uses(r.menu.id))
      out.push({ kind: "reservation", label: `${label(r.date)} ${r.start} ${r.menu.name} ${guestName(r.customer.surname)}（${r.status === "confirmed" ? "確定" : "仮押さえ"}）` });
  for (const k of o.kartes ?? [])
    if (uses(k.menuId)) {
      const s = o.surnameOf?.(k.customerId);
      out.push({ kind: "karte", label: `カルテ ${label(k.date)}${s ? ` ${guestName(s)}` : ""}` });
    }
  for (const r of o.rules ?? []) {
    if (r.locked) continue;
    const scoped = r.level === "menu" && r.menuId === id;
    const pair = r.check.kind === "notTogether" && r.check.with === id;
    if (scoped || pair) out.push({ kind: "rule", label: `ルール「${r.label}」` });
  }
  return out;
}

export type MenuChange = { id: string; name: string; field: keyof MenuFields | "added" | "removed"; before: string; after: string };

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;

/** 足したメニューの中身の1行（「30分・3,000円・最終受付 19:00」） */
export function ownMenuText(m: Pick<Menu, "minutes" | "price" | "lastStart">, lim: MenuLimits): string {
  const f = fieldsOf(m, lim);
  return `${f.minutes}分・${yen(f.price)}・最終受付 ${f.lastStart}`;
}

/** 直す前と後の違い（メニューの並び・時間 → 値段 → 最終受付の順。足した物・消した物も） */
export function menuChanges(before: Menu[], after: Menu[], shop: MenuShop): MenuChange[] {
  const lim = menuLimitsOf(shop);
  const out: MenuChange[] = [];
  for (const b of before) {
    const a = after.find((m) => m.id === b.id);
    if (!a) {
      if (isOwnMenuId(b.id)) out.push({ id: b.id, name: b.name, field: "removed", before: ownMenuText(b, lim), after: "" });
      continue;
    }
    const fb = fieldsOf(b, lim);
    const fa = fieldsOf(a, lim);
    if (fb.minutes !== fa.minutes) out.push({ id: b.id, name: b.name, field: "minutes", before: `${fb.minutes}分`, after: `${fa.minutes}分` });
    if (fb.price !== fa.price) out.push({ id: b.id, name: b.name, field: "price", before: yen(fb.price), after: yen(fa.price) });
    if (fb.lastStart !== fa.lastStart) out.push({ id: b.id, name: b.name, field: "lastStart", before: fb.lastStart, after: fa.lastStart });
  }
  for (const a of after)
    if (isOwnMenuId(a.id) && !before.some((b) => b.id === a.id)) out.push({ id: a.id, name: a.name, field: "added", before: "", after: ownMenuText(a, lim) });
  return out;
}

/** 「カラー 90分 → 60分」「カラー 最終受付 18:00 → 17:30」「トリートメントを足す（30分・3,000円・最終受付 19:00）」「トリートメントを消す」 */
export function changeText(c: MenuChange): string {
  if (c.field === "added") return `${c.name}を足す（${c.after}）`;
  if (c.field === "removed") return `${c.name}を消す`;
  return `${c.name} ${c.field === "lastStart" ? "最終受付 " : ""}${c.before} → ${c.after}`;
}

/** 日誌の1行（だれ：オーナー。直した3つだけ） */
export function menuJournal(changes: MenuChange[]): string {
  return `メニューを直した（${changes.map(changeText).join("・")}）`;
}

/**
 * 日誌の行（だれ：オーナー）。直した分は1行にまとめ、足した物・消した物は1つずつ：
 * 「メニューを直した（カラー 90分 → 60分）」「メニューを足した（トリートメント 30分・3,000円）」「メニューを消した（トリートメント）」
 */
export function menuJournalLines(changes: MenuChange[], after: Menu[], shop: MenuShop): string[] {
  const lim = menuLimitsOf(shop);
  const edits = changes.filter((c) => c.field !== "added" && c.field !== "removed");
  const lines: string[] = [];
  if (edits.length) lines.push(menuJournal(edits));
  for (const c of changes) {
    if (c.field === "added") {
      const m = after.find((x) => x.id === c.id);
      const f = m ? fieldsOf(m, lim) : null;
      lines.push(`メニューを足した（${c.name}${f ? ` ${f.minutes}分・${yen(f.price)}` : ""}）`);
    }
    if (c.field === "removed") lines.push(`メニューを消した（${c.name}）`);
  }
  return lines;
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
 * 🔒 オーナーの「保存」ボタンだけが呼ぶ。直した・足した・消したメニューをこのブラウザに書き、書けた時だけ日誌に書く（だれ：オーナー）。
 * 書けなかった時は前のまま（BrowserWrite の ok: false。画面は SAVE_FAILED_MESSAGE を出し、入力を残す）。もう一度押せば書け、日誌は書けた1回だけ。
 * 足したメニューの番号は、書く直前にブラウザに残った番号（seq）と比べ、消した分も使い回さないように残す
 */
export function commitMenus(next: Menu[], before: Menu[], base: Menu[], shop: MenuShop): { write: BrowserWrite; changes: MenuChange[] } {
  const changes = menuChanges(before, next, shop);
  const seq = Math.max(readMenuStore(readBrowser(MENUS_KEY), base, shop).seq, maxOwnNo(before));
  const write = writeBrowser(MENUS_KEY, menuEditsRaw(next, base, shop, seq));
  if (write.ok) for (const text of menuJournalLines(changes, next, shop)) writeJournal({ who: "オーナー", text });
  return { write, changes };
}
