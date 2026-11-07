// 「日報を入れる」のボタン（直しK）：経理の見出しのすぐ下（スマホ）とホームのボタンから、経理の売上の欄の今日の1枚（1つだけ）を開く。
// スマホの幅では「日報を入れる」が1つだけ見える（売上の欄の中のボタンは出さない）。PC の幅は今のまま。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DAILY_OPEN_HREF, onDailySheetRequest, requestDailySheet, wantsDailyOpen, withoutDailyOpen } from "../dailyOpen";

const ROOT = join(__dirname, "../../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const css = read("src/app/globals.css");

/** @media (…) { … } の中身（最初に見つかった物から、括弧が閉じるまで）を全部つなぐ */
function mediaBodies(query: string): string {
  let out = "";
  let at = css.indexOf(`@media (${query})`);
  while (at >= 0) {
    const open = css.indexOf("{", at);
    let depth = 0;
    let i = open;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) break;
    }
    out += css.slice(open + 1, i) + "\n";
    at = css.indexOf(`@media (${query})`, i);
  }
  return out;
}

describe("日報のボタン 1：ホームのボタンで、経理の今日の1枚が開く", () => {
  test("行く先は経理のタブ（今日の1枚を開く印つき）", () => {
    assert.equal(DAILY_OPEN_HREF, "/accounting?daily=today");
    assert.equal(wantsDailyOpen(new URL(DAILY_OPEN_HREF, "https://x.test").search), true);
    assert.equal(wantsDailyOpen(""), false);
    assert.equal(wantsDailyOpen("?daily=no"), false);
    assert.equal(wantsDailyOpen("?freee=connected"), false);
  });
  test("開いたら印は URL から消す（ほかの印と #… は残す。開き直しでもう一度開かない）", () => {
    assert.equal(withoutDailyOpen("/accounting", "?daily=today", ""), "/accounting");
    assert.equal(withoutDailyOpen("/accounting", "?daily=today&freee=connected", "#acct-sales"), "/accounting?freee=connected#acct-sales");
  });
  test("ホーム：AI の仕事のボタンの横（承認待ちの1行の隣の beside）に、人のボタンとして置く", () => {
    const page = read("src/app/home/page.tsx");
    assert.match(page, /beside=\{\s*<HomeTopActions>\s*<AiJobsRunBar \/>\s*<\/HomeTopActions>\s*\}/);
    const btn = read("src/app/home/HomeDailyOpen.tsx");
    assert.match(btn, /href=\{DAILY_OPEN_HREF\}/);
    assert.match(btn, /<ActorTag actor="human"/);
    // AI の仕事のボタン（塗りの btn primary）と分ける
    assert.doesNotMatch(btn, /btn primary/);
  });
  test("経理の売上の欄が URL の印を見て、読み終えた描画で今日の1枚を開く（1枚は売上の欄の1つだけ）", () => {
    const sales = read("src/app/accounting/SalesReport.tsx");
    assert.match(sales, /wantsDailyOpen\(l\.search\)/);
    assert.match(sales, /withoutDailyOpen\(/);
    assert.match(sales, /if \(!wantOpen \|\| !hydrated\) return;/);
    assert.match(sales, /date: todayRef\.current/);
    // <DailySheet を描くのは売上の欄だけ
    const users = ["src/app/accounting/SalesReport.tsx", "src/app/accounting/DailyOpenTop.tsx", "src/app/home/HomeDailyOpen.tsx", "src/app/accounting/page.tsx", "src/app/home/page.tsx"].filter(
      (p) => read(p).includes("<DailySheet"),
    );
    assert.deepEqual(users, ["src/app/accounting/SalesReport.tsx"]);
  });
});

describe("日報のボタン 2：経理の見出しのすぐ下のボタン（スマホ）", () => {
  test("押すと売上の欄に頼む（同じページの1枚を開く）。外したら届かない", () => {
    let n = 0;
    const off = onDailySheetRequest(() => (n += 1));
    requestDailySheet();
    assert.equal(n, 1);
    off();
    requestDailySheet();
    assert.equal(n, 1);
  });
  test("経理のタブは beside（枠の TabFrame は直さない）に DailyOpenTop を渡す", () => {
    const page = read("src/app/accounting/page.tsx");
    assert.match(page, /<TabPage tab="accounting" right=\{<RegisterColumn \/>\} beside=\{<DailyOpenTop \/>\} rightFirstOnPhone>/);
    assert.match(read("src/app/accounting/DailyOpenTop.tsx"), /onClick=\{\(\) => requestDailySheet\(\)\}/);
    assert.match(read("src/app/accounting/SalesReport.tsx"), /onDailySheetRequest\(/);
  });
});

describe("日報のボタン 3：スマホでは「日報を入れる」が1つだけ見える・PC は今のまま", () => {
  const phone = mediaBodies("max-width: 1023.98px");
  const pc = mediaBodies("min-width: 1024px");
  test("ふだん（PC）は見出しの下のボタンを出さない。承認待ちの1行は横いっぱいのまま", () => {
    assert.match(css, /^\.acct-daily-top \{ display: none; \}/m);
    assert.match(pc, /\.pending-row:has\(> \.acct-daily-top\) \{ display: block; \}/);
    assert.doesNotMatch(pc, /\.acct-daily-in \{ display: none/);
  });
  test("スマホ：売上の欄の中のボタンは出さず、見出しの下のボタンを出す", () => {
    assert.match(phone, /\.acct-daily-in \{ display: none; \}/);
    assert.match(phone, /\.acct-daily-top \{ display: block; \}/);
    assert.match(read("src/app/accounting/SalesReport.tsx"), /className="btn primary acct-daily-open acct-daily-in"/);
  });
  test("スマホの並び：承認待ち → 見出し → 日報を入れる → 右の列（登録の欄）", () => {
    assert.match(phone, /\.pending-row:has\(> \.acct-daily-top\) > \.pending \{ order: -5; \}/);
    assert.match(phone, /\.page\.right-first-sp:has\(\.acct-daily-top\) > \.page-main > \.page-head \{ order: -4; \}/);
    assert.match(phone, /\.pending-row > \.acct-daily-top \{ order: -3; \}/);
    // 右の列は -1（今のまま）
    assert.match(phone, /\.page\.right-first-sp > \.page-right \{ order: -1; \}/);
  });
});
