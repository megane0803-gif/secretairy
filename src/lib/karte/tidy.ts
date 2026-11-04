// カルテの下書きを、見出しに分けた後にプログラムで整える（AI の書き方に任せない所）。言葉の門（gate.ts）の前に通す。
// 1. 同じ中身を重ねない：同じ見出しの中の同じ行（「大丈夫です」が2行など）は1つに。
//    2つの見出しに同じ行があれば、手がかりの言葉（config/karte.json の hints）が当たる見出しの方に残す
//    （「頭皮が赤かった」が来店時の状態と注意点の両方 → 注意点）。当たらなければ先の見出しに残す。
// 2. 次の来店についての希望（「次は暗めのカラーをやりたい」）は、お客様のご希望と次回提案の両方に入れる（メモの言葉のまま）。
//    この2つの見出し（role: "request" と role: "next"）の間だけは、同じ行が2つあってよい。
// 足す言葉はメモの言葉だけ。良い悪いの判断はしない（🔒 鍵つきの2つ目）。

import type { KarteHeading } from "../settings";
import { emptySections, headingWithRole, MAX_LINE_CHARS, MAX_LINES_PER_HEADING, type KarteSections } from "./format";

/** 比べるための形（全角半角・空白・句読点・かっこを除く） */
export function lineKey(s: string): string {
  return s.normalize("NFKC").replace(/[\s、。，．,.!！?？「」『』（）()・:：]/g, "");
}

/** 同じ中身か：形をそろえて同じ。または短い方（4字以上）が長い方にそのまま入っていて、数がちがわない */
export function sameContent(a: string, b: string): boolean {
  const x = lineKey(a);
  const y = lineKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 4 || !long.includes(short)) return false;
  const nums = (s: string) => (s.match(/\d+/g) ?? []).join(",");
  return nums(short) === nums(long);
}

/** 文字の2つ組の重なり（0〜1）。次回の希望をもう書いてあるかの見分けにだけ使う（消すのには使わない） */
function overlap(a: string, b: string): number {
  const grams = (s: string) => {
    const k = lineKey(s);
    const out: string[] = [];
    for (let i = 0; i < k.length - 1; i++) out.push(k.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.length || !gb.length) return 0;
  const pool = [...gb];
  let hit = 0;
  for (const g of ga) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      hit += 1;
      pool.splice(i, 1);
    }
  }
  return (2 * hit) / (ga.length + gb.length);
}

const NEXT_WORDS = /(次は|次回|今度は|次の(来店|時|とき|予約))/;
const WISH_WORDS = /(したい|やりたい|してみたい|してほしい|して欲しい|にしたい|がいい|が良い|希望|ほしい|欲しい)/;
const FILLER = /^(えーと|えっと|ええと|あと|それと|それから|で)[、,\s]*/;
const TAIL = /(って(言って(た|ました|いた|いました))?|と(言って(た|ました|いた|いました))|とのこと|そう)$/;

/** メモの中の「次の来店についての希望」の文（メモの言葉のまま。前の「えーと」と終わりの「って言ってた」だけ外す） */
export function nextWishes(memo: string): string[] {
  const out: string[] = [];
  for (const raw of memo.split(/[。！？!?\n]+/)) {
    const s = raw.trim().replace(/^[・\-]\s*/, "").replace(FILLER, "").trim();
    if (!s || !NEXT_WORDS.test(s) || !WISH_WORDS.test(s)) continue;
    const line = s.replace(TAIL, "").trim().slice(0, MAX_LINE_CHARS);
    if (line && !out.some((x) => sameContent(x, line))) out.push(line);
  }
  return out;
}

function hintHits(h: KarteHeading, line: string): boolean {
  return (h.hints ?? []).some((w) => line.includes(w));
}

export type TidyResult = {
  sections: KarteSections;
  /** 重なっていたので外した行（見出しの label と行） */
  merged: { heading: string; line: string }[];
  /** 次の来店の希望として足した行 */
  added: { heading: string; line: string }[];
};

export function tidySections(input: KarteSections, memo: string, headings: KarteHeading[]): TidyResult {
  const sections = emptySections(headings);
  const merged: TidyResult["merged"] = [];
  const added: TidyResult["added"] = [];
  const request = headingWithRole(headings, "request");
  const next = headingWithRole(headings, "next");
  const pairOk = (a: KarteHeading, b: KarteHeading) =>
    !!request && !!next && ((a.id === request.id && b.id === next.id) || (a.id === next.id && b.id === request.id));

  // 1. 同じ見出しの中の重なりを1つに
  for (const h of headings) {
    for (const line of input[h.id] ?? []) {
      if (sections[h.id].some((x) => sameContent(x, line))) merged.push({ heading: h.label, line });
      else sections[h.id].push(line);
    }
  }

  // 2. 見出しをまたぐ重なり：手がかりの言葉が当たる見出しに残す（当たらなければ先の見出し）
  for (let i = 0; i < headings.length; i++) {
    const a = headings[i];
    for (const line of [...sections[a.id]]) {
      const holders = headings.filter((h) => sections[h.id].some((x) => sameContent(x, line)));
      if (holders.length < 2) continue;
      const keep = holders.find((h) => hintHits(h, line)) ?? holders[0];
      for (const h of holders) {
        if (h.id === keep.id || pairOk(h, keep)) continue;
        const before = sections[h.id];
        sections[h.id] = before.filter((x) => {
          const same = sameContent(x, line);
          if (same) merged.push({ heading: h.label, line: x });
          return !same;
        });
      }
    }
  }

  // 3. 次の来店の希望は、ご希望と次回提案の両方に（もう同じような行があれば足さない）
  if (request && next) {
    for (const wish of nextWishes(memo)) {
      for (const h of [request, next]) {
        const list = sections[h.id];
        if (list.some((x) => sameContent(x, wish) || overlap(x, wish) >= 0.6)) continue;
        if (list.length >= MAX_LINES_PER_HEADING) continue;
        list.push(wish);
        added.push({ heading: h.label, line: wish });
      }
    }
  }
  return { sections, merged, added };
}
