// 予約チャットで料金を聞かれたとき。値段は AI に書かせず、店の設定（config/menus.json）からプログラムが返す。
// - 設定にあるメニュー → そのメニューの値段（2つ以上なら、いっしょの時の値段も。組み合わせは combo.ts）
// - メニューを言わずに料金だけ → 設定のメニューを全部
// - 設定に無い物（例：トリートメント）→ 値段は作らず「お店に確かめてご連絡します」（ToDo はいつもどおり replies.ts が足す）

import { COMBO_SEP, comboIdOf, resolveMenu } from "../combo";
import type { Menu } from "../settings";
import { normalizeText } from "./dates";
import { ASK_SHOP_REPLY } from "./replies";

/** 料金を聞いているか */
export function asksPrice(text: string): boolean {
  return /(料金|値段|価格|金額|費用|お代|いくら|幾ら|何円|なん円|円くらい|円ぐらい|円ほど)/.test(text);
}

/** 予約の話もいっしょにしているか（日時・空き・予約の言葉）。そのときは料金だけ先に返し、あとは AI が続ける */
export function alsoBooking(text: string): boolean {
  const t = normalizeText(text);
  return /(\d{1,2}\s*[/月]\s*\d{1,2}|\d{1,2}\s*(時|:\d{2})|今日|本日|明日|あした|あす|明後日|今週|来週|再来週|週末|[月火水木金土日]曜|午前|午後|夕方|夜|朝|空い|空き|予約したい|予約を?お願い|取れ|とれます|行きたい|伺いたい|前と同じ)/.test(t);
}

/** 料金の話でよく出る言葉（これは「設定に無いメニュー」とは見ない） */
const COMMON = [
  "料金", "値段", "価格", "金額", "費用", "お代", "幾ら", "何円", "税込", "税抜", "全部", "合計", "一緒", "全体", "大体",
  "予約", "今日", "本日", "明日", "明後日", "今週", "来週", "再来週", "週末", "曜日", "午前", "午後", "夕方", "前回", "同", "次回",
  "場合", "時間", "何分", "教", "知", "聞", "気", "確認", "円", "目安", "相場", "初", "方", "私", "自分", "追加", "別", "込", "何",
  "メニュー", "コース", "セット", "プラン", "オプション",
];

/** 文に出てきた、設定のメニュー（名前が長い物から当てる。カット＋カラーはカットとカラーより先） */
export function menusInText(menus: Menu[], text: string): { found: Menu[]; rest: string } {
  let rest = normalizeText(text).replace(/[＋+]/g, "＋");
  const found: Menu[] = [];
  for (const m of [...menus].sort((a, b) => b.name.length - a.name.length)) {
    const name = normalizeText(m.name);
    if (rest.includes(name)) {
      found.push(m);
      rest = rest.split(name).join(" ");
    }
  }
  // 設定の並びの順に
  found.sort((a, b) => menus.indexOf(a) - menus.indexOf(b));
  return { found, rest };
}

/** 設定に無い物の名前（カタカナ・漢字2字以上のまとまりで、料金の話でよく出る言葉ではない物）。無ければ空 */
export function unknownItems(rest: string): string[] {
  const out: string[] = [];
  for (const raw of rest.match(/[ァ-ヶー]{2,}|[一-龠々]{2,}/g) ?? []) {
    let w = raw;
    for (const c of COMMON) w = w.split(c).join("");
    if (w.replace(/ー/g, "").length >= 2 && !out.includes(raw)) out.push(raw);
  }
  return out;
}

export function yen(n: number): string {
  return `${n.toLocaleString("ja-JP")}円`;
}

export type PriceAnswer = {
  /** お客様に返す文 */
  text: string;
  /** AI の手順・日誌の1行 */
  step: string;
  /** 設定に無い物があって「お店に確かめてご連絡します」と返したか */
  askShop: boolean;
};

/** 料金の答え（プログラム）。料金を聞いていなければ null */
export function priceAnswer(menus: Menu[], text: string): PriceAnswer | null {
  if (!asksPrice(text)) return null;
  const { found, rest } = menusInText(menus, text);
  const unknown = unknownItems(rest);
  const parts: string[] = [];
  if (found.length) {
    parts.push(`${found.map((m) => `${m.name}は ${yen(m.price)}`).join("、")}です。`);
    const id = found.length > 1 ? comboIdOf(menus, found.map((m) => m.id)) : null;
    const combo = id ? resolveMenu(menus, id) : undefined;
    // 設定の組み合わせのメニュー（カット＋カラー）があれば、その名前と値段。無い組み合わせは足した値段
    if (combo && !found.some((m) => m.id === combo.id))
      parts.push(id!.includes(COMBO_SEP) ? `いっしょだと ${yen(combo.price)}です。` : `いっしょだと${combo.name}で ${yen(combo.price)}です。`);
  } else if (unknown.length === 0) {
    parts.push(`メニューの料金です：${menus.map((m) => `${m.name} ${yen(m.price)}`).join("・")}。`);
  }
  // 設定に無い物は、値段を作らずにお店に確かめる（その言葉はお客様の文のままなので、手順にだけ書く）
  if (unknown.length) parts.push(found.length ? `それ以外は、${ASK_SHOP_REPLY}` : ASK_SHOP_REPLY);
  const shown = found.length ? found.map((m) => `${m.name} ${yen(m.price)}`).join("・") : unknown.length ? "" : "メニュー全部";
  const step = [
    shown ? `料金を店の設定から答えた：${shown}` : "",
    unknown.length ? `設定に無いので、お店に確かめる：${unknown.join("・")}` : "",
  ]
    .filter(Boolean)
    .join("。");
  return { text: parts.join(""), step, askShop: unknown.length > 0 };
}
