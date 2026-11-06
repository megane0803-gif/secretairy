// 押せる所を増やす（使い勝手。直しB）。AI は呼ばない。画面の部品はファイルの中身で、決まり（数・位置）は関数で確かめる。
// 2. カルテ（スマホ）の案へ飛ぶ  5. 発信のコピー  6. スマホのタブの帯  7. 広告の4週分がはみ出さない  8. 経理の「あと N件 選ぶ」

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { COPY_MESSAGE, copyText } from "../copy";
import { scrollLeftToShow } from "../scroll";

const root = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const css = read("src/app/globals.css");

describe("2. カルテ（スマホ）：「カルテにする」の後、案の所へ", () => {
  const memo = read("src/app/karte/KarteMemo.tsx");
  const board = read("src/app/karte/KarteBoard.tsx");
  it("案のカードに id があり、案ができたらスマホ（1列）でそこまで画面を動かす", () => {
    assert.match(board, /<article className="karte-card ai" id=\{KARTE_DRAFT_ID\}/);
    assert.match(memo, /if \(isOneColumn\(\)\) scrollToId\(KARTE_DRAFT_ID\)/);
    const set = memo.indexOf("drafts: { ...s.drafts, [key!]");
    assert.ok(set > 0 && memo.indexOf("scrollToId(KARTE_DRAFT_ID)") > set, "案をしまった後に動かす");
  });
  it("ボタンのすぐ下に、案へ飛ぶリンク（スマホだけ）", () => {
    const button = memo.indexOf('"カルテにする"');
    const link = memo.indexOf("✓ 案ができました。上で見て保存 ↑");
    assert.ok(button > 0 && link > button);
    assert.match(memo, /className="karte-made sp-only"/);
    assert.match(memo, /href=\{`#\$\{KARTE_DRAFT_ID\}`\}/);
  });
});

describe("5. 発信の下書き：コピー", () => {
  const board = read("src/app/posts/PostsBoard.tsx");
  it("コピーできたら「✓ コピーしました」", async () => {
    let got = "";
    const r = await copyText("下書きの文", { clipboard: { writeText: async (t) => void (got = t) }, select: () => assert.fail("選ばない") });
    assert.equal(r, "copied");
    assert.equal(got, "下書きの文");
    assert.equal(COPY_MESSAGE.copied, "✓ コピーしました");
  });
  it("クリップボードが無い・断られたブラウザでは、文を選んだ状態にする", async () => {
    let selected = 0;
    assert.equal(await copyText("x", { clipboard: undefined, select: () => (selected++, true) }), "selected");
    assert.equal(await copyText("x", { clipboard: { writeText: async () => Promise.reject(new Error("no")) }, select: () => (selected++, true) }), "selected");
    assert.equal(selected, 2);
    assert.equal(await copyText("x", { clipboard: null, select: () => false }), "failed");
  });
  it("見て直す所（手で直した後の文）と、保存した一覧の両方にコピーのボタン", () => {
    assert.match(board, /<CopyButton text=\{draft\.text\} targetId=\{DRAFT_TEXT_ID\} \/>/);
    assert.match(board, /<textarea\s+id=\{DRAFT_TEXT_ID\}/);
    assert.match(board, /<CopyButton text=\{p\.text\} targetId=\{`posts-full-\$\{p\.id\}`\} \/>/);
    assert.match(board, /<p className="posts-full" id=\{`posts-full-\$\{p\.id\}`\}>/);
  });
});

describe("6. スマホのタブの帯：開いているタブを見える位置へ", () => {
  // 390px の帯に、1つ 96px のタブが8つ（帯の中身は 8 × 96 + 間 = 796px）
  const box = { width: 358, scrollLeft: 0, scrollWidth: 796 };
  it("見えていれば動かさない", () => {
    assert.equal(scrollLeftToShow(box, { left: 100, width: 96 }), 0);
    assert.equal(scrollLeftToShow({ ...box, scrollLeft: 200 }, { left: 0, width: 96 }), 200);
  });
  it("帯の外に隠れていれば、真ん中に来るまで動かす", () => {
    // 5つ目（左から 400px）：真ん中へ
    assert.equal(scrollLeftToShow(box, { left: 400, width: 96 }), Math.round(400 - (358 - 96) / 2));
    // 少しだけはみ出している（3つ目の半分）も動かす
    assert.ok(scrollLeftToShow(box, { left: 300, width: 96 }) > 0);
  });
  it("端では帯の端で止める（最後のタブ・左に隠れたタブ）", () => {
    assert.equal(scrollLeftToShow(box, { left: 700, width: 96 }), 796 - 358);
    assert.equal(scrollLeftToShow({ ...box, scrollLeft: 300 }, { left: -300, width: 96 }), 0);
  });
  it("帯は開いているタブ（aria-current）の位置で、帯の横だけ動かす（ページは縦に動かさない）", () => {
    const nav = read("src/components/TabNav.tsx");
    assert.match(nav, /a\[aria-current="page"\]/);
    assert.match(nav, /ul\.scrollLeft = scrollLeftToShow\(/);
    assert.doesNotMatch(nav, /scrollIntoView/);
    assert.match(nav, /\[pathname, shown\.length\]/, "タブを開くたびに");
  });
});

describe("7. 広告の4週分：数字がカードからはみ出さない", () => {
  it("箱の幅に合わせて字を小さくし、折り返さない（見た目の型に依らない書き方）", () => {
    assert.match(css, /\.ad-weeks \.bignums > div \{ min-width: 0; \}/);
    assert.match(css, /\.ad-weeks \.bignum \{ min-width: 0; container-type: inline-size; \}/);
    assert.match(css, /\.ad-weeks \.bignum-value \{ white-space: nowrap; font-size: min\(2\.6rem, 20cqi\); \}/);
  });
});

describe("8. 経理：「あと N件 選ぶ」は選ぶ所へのリンク・押せない矢印は外す", () => {
  const card = read("src/app/accounting/CardStatement.tsx");
  it("「人が選ぶ N件」の見出しに id、「あと N件 選ぶ」（登録の欄・freee の欄）はそこへのリンク", () => {
    assert.match(card, /<h3 className="acct-h3" id=\{ACCT_CHOOSE_ID\}>/);
    for (const p of ["src/app/accounting/RegisterPanel.tsx", "src/app/accounting/FreeePanel.tsx"])
      assert.match(read(p), /<ChooseLink>\s*あと <strong className="num">\{gate\.remaining\}<\/strong>件 選ぶ ↓\s*<\/ChooseLink>/, p);
  });
  it("「未処理 N件 →」の押せない矢印は無い。人が選ぶ物があればリンク", () => {
    const head = card.slice(card.indexOf('<p className="ad-change">'), card.indexOf("</p>", card.indexOf('<p className="ad-change">')));
    assert.doesNotMatch(head, /className="arrow"/);
    assert.match(head, /<ChooseLink>\s*人が選ぶ/);
  });
});

describe("12. 広告：「AI に見直してもらう」がうまくいった直後の出し方", () => {
  const review = read("src/app/ads/AdsReview.tsx");
  it("うまくいった1行（✓ 承認の箱に入れました…すぐ下で決める ↓）が、押せない理由より先", () => {
    const ok = review.indexOf("承認の箱に入れました：{shown.text}");
    const why = review.indexOf('<p className="ad-review-why"');
    assert.ok(ok > 0 && why > ok, "うまくいった1行が先");
    assert.match(review, /すぐ下で決める ↓/);
    assert.match(review, /href=\{`#\$\{ADS_APPROVALS_ID\}`\}/);
    assert.match(review, /export const ADS_APPROVALS_ID = "ads-approvals";/);
    assert.match(read("src/app/ads/page.tsx"), /<h2 id="ads-approvals">/);
  });
  it("押せない理由はふつうの字（太字にしない）", () => {
    assert.match(css, /\.ad-review-why \{[^}]*font-weight: 400;/);
    const why = review.slice(review.indexOf('<p className="ad-review-why"'), review.indexOf("</p>", review.indexOf('<p className="ad-review-why"')));
    assert.doesNotMatch(why, /<strong>/);
  });
});
