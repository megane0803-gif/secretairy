// 広告のタブの見た目の決まり（頼み UI3）：並び・スマホの「AI に見直してもらう」の場所・押せない時の出し方・デモの札。
// 動き（案・門・承認・判定・報告・日誌）は ads.test.ts・results.test.ts・team.test.ts のまま。ここは画面の決まりだけ。
// 広告の部品は描かず（ブラウザの中の置き場所を読むため）、ソースと CSS で確かめる。TabFrame だけは描いて確かめる。

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TabFrame } from "../../../components/TabFrame";
import { DEMO_TAG_NOTE } from "../../notices";
import { getTabSwitches } from "../../settings";

const ROOT = join(__dirname, "../../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const page = read("src/app/ads/page.tsx");
const review = read("src/app/ads/AdsReview.tsx");
const results = read("src/app/ads/AdsResults.tsx");
const report = read("src/app/ads/AdsReport.tsx");
const frame = read("src/components/TabFrame.tsx");
const css = read("src/app/globals.css");

describe("1. 並び：4週分 → 承認待ち → 効いたかの判定 → 毎週の見直しの報告 → 広告（架空）の画面 → 2つの一覧 → くわしく", () => {
  test("広告のページの真ん中の欄の順", () => {
    const at = (s: string) => {
      const i = page.indexOf(s);
      assert.ok(i >= 0, s);
      return i;
    };
    const order = [at("<AdsWeeks />"), at('aria-labelledby="ads-approvals"'), at("<AdsResults />"), at("<AdsReport />"), at('<Fold summary="くわしく')];
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });

  test("4週分（AdsWeeks）は大きい数字3つと週ごとの柱。AdsReport は画面と2つの一覧で、判定・報告より後", () => {
    const weeks = report.slice(report.indexOf("export function AdsWeeks"), report.indexOf("export function AdsReport"));
    assert.match(weeks, /の4週分/);
    assert.equal(weeks.match(/<BigNumber /g)?.length, 3);
    assert.match(weeks, /MiniColumns/);
    const rest = report.slice(report.indexOf("export function AdsReport"));
    assert.doesNotMatch(rest, /<BigNumber /);
    const site = rest.indexOf('className="ad-site"');
    const kw = rest.indexOf("広告を出す言葉（止められる）");
    const terms = rest.indexOf("お客さんが調べた言葉（多い順・外せる）");
    assert.ok(site >= 0 && site < kw && kw < terms);
    // 効いたかの判定 → 毎週の見直しの報告 の順（題名は変えない）
    assert.ok(results.indexOf(">効いたかの判定</h2>") < results.indexOf(">毎週の見直しの報告</h2>"));
  });

  test("PC の右の列は今のまま「AI に見直してもらう」。AdsReview は1つだけ（スマホでも同じ部品を並べ替えて出す）", () => {
    assert.match(page, /right=\{\s*<Panel title="AI に見直してもらう">\s*<AdsReview /);
    assert.equal(page.match(/<AdsReview /g)?.length, 1);
    assert.match(page, /rightAfterOnPhone=\{1\}/);
    assert.doesNotMatch(page, /rightFirstOnPhone/);
    // AdsReview を使うのは広告のページだけ
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(join(ROOT, d))) {
        const p = `${d}/${f}`;
        if (statSync(join(ROOT, p)).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f) && !p.includes("__tests__")) files.push(p);
      }
    };
    walk("src");
    const users = files.filter((f) => /<AdsReview\b/.test(read(f)));
    assert.deepEqual(users, ["src/app/ads/page.tsx"]);
  });
});

describe("1. TabFrame の rightAfterOnPhone（渡した時だけ使う口）", () => {
  const render = (extra: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(TabFrame, {
        tab: "ads",
        baseSwitches: getTabSwitches(),
        pending: createElement("a", { className: "pending" }, "p"),
        right: createElement("p", null, "RIGHT"),
        children: ["a", "b", "c"].map((id) => createElement("section", { key: id, id }, id.toUpperCase())),
        ...extra,
      }),
    );

  test("渡すと、真ん中の欄を前（page-lead）と後（page-rest）に分け、right-after-sp の札。右の列は1つ", () => {
    const html = render({ rightAfterOnPhone: 1 });
    assert.match(html, /class="page right-after-sp"/);
    assert.match(html, /<div class="page-lead"><section id="a">A<\/section><\/div><div class="page-rest"><section id="b">B<\/section><section id="c">C<\/section><\/div>/);
    assert.equal(html.match(/RIGHT/g)?.length, 1);
    assert.ok(html.indexOf("page-rest") < html.indexOf('class="page-right"'), "DOM では右の列は main の後（並べ替えは CSS）");
  });

  test("渡さないタブは今のまま（包まない・札なし）", () => {
    const html = render({});
    assert.match(html, /^<div class="page">/);
    assert.doesNotMatch(html, /page-lead|page-rest|right-after-sp/);
    assert.match(html, /<section id="a">A<\/section><section id="b">B<\/section><section id="c">C<\/section>/);
  });

  test("rightFirstOnPhone と一緒なら rightFirstOnPhone のまま（包まない）", () => {
    const html = render({ rightFirstOnPhone: true, rightAfterOnPhone: 1 });
    assert.match(html, /class="page right-first-sp"/);
    assert.doesNotMatch(html, /page-lead|right-after-sp/);
  });

  test("ほかのタブは rightAfterOnPhone を渡さない", () => {
    // ルールタブも、スマホで「🔒 鍵つき → ルールを足す欄（右の列）→ 一覧」にするので同じ口を使う（UI4。新しい口は作らない）
    assert.match(read("src/app/rules/page.tsx"), /rightAfterOnPhone=\{1\}/);
    for (const tab of ["home", "reservations", "karte", "accounting", "posts", "todo"])
      assert.doesNotMatch(read(`src/app/${tab}/page.tsx`), /rightAfterOnPhone/, tab);
    assert.match(frame, /rightAfterOnPhone\?: number;/);
  });

  test("CSS：スマホ（1024px より狭い）だけ、承認待ち・見出し・前の欄 → 右の列 → 後の欄・表示スイッチ", () => {
    const blocks = [...css.matchAll(/@media \(max-width: 1023\.98px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]);
    const block = blocks.find((b) => b.includes(".page.right-after-sp")) ?? "";
    assert.match(block, /\.page\.right-after-sp > \.page-main \{ display: contents; \}/);
    const order = (sel: string) => Number(block.match(new RegExp(`${sel.replace(/[.>]/g, (c) => `\\${c}`)} \\{[^}]*order: (-?\\d+)`))?.[1]);
    const pending = order(".page.right-after-sp > .page-main > .pending");
    const head = order(".page.right-after-sp > .page-main > .page-head");
    const lead = order(".page.right-after-sp > .page-main > .page-lead");
    const right = order(".page.right-after-sp > .page-right");
    const rest = order(".page.right-after-sp > .page-main > .page-rest");
    const sw = order(".page.right-after-sp > .page-main > .tab-switch-fold");
    assert.ok(pending <= head && head <= lead && lead < right && right < rest && rest <= sw, `${pending} ${head} ${lead} < ${right} < ${rest} ${sw}`);
    // PC（1024px 以上）の側には right-after-sp の決まりを置かない
    for (const m of css.matchAll(/@media \(min-width: 1024px\) \{([\s\S]*?)\n\}/g)) assert.doesNotMatch(m[1], /right-after-sp/);
  });
});

describe("2. 押せない時の理由と「最初に戻す」", () => {
  test("理由と次に頼める日時は、ボタンのすぐ下にふつうの字（hint ではない）", () => {
    const btn = review.indexOf('{busy ? "見直しています…" : "AI に見直してもらう"}');
    // うまくいった直後は「✓ 承認の箱に入れました」が先なので、理由の行の読み上げ（status）はその時だけ外す（直しB の12）
    const why = review.indexOf('<p className="ad-review-why" role={shown?.kind === "ok" ? undefined : "status"}>');
    assert.ok(btn >= 0 && why > btn);
    assert.match(review.slice(why, why + 200), /\{can\.reason\}\s*\{nextLabel && `次は \$\{nextLabel\} から頼めます。`\}/);
    assert.match(css, /\.ad-review-why \{[^}]*font-size: 1rem;/);
  });

  test("「広告（架空）を最初に戻す」は部品1つで、押せない時は理由の下・押せる時は欄の一番下（同時に出さない）", () => {
    assert.equal(review.match(/>\s*広告（架空）を最初に戻す\s*</g)?.length, 1, "ボタンの文字は1か所");
    assert.equal(review.match(/\{resetButton\}/g)?.length, 2);
    const off = review.indexOf("{!can.ok && (");
    const on = review.indexOf("{can.ok && (");
    assert.ok(off >= 0 && on > off);
    const offBlock = review.slice(off, review.indexOf("{noAi && ("));
    assert.match(offBlock, /ad-review-why[\s\S]*\{demoTag\} 広告を最初に戻すと、もう一度試せます[\s\S]*\{resetButton\}/);
    assert.match(review.slice(on), /^\{can\.ok && \(\s*<div className="reset-row">\s*\{resetButton\}/);
    // 押せる時の「最初に戻す」は欄の一番下（結果の後）
    assert.ok(review.indexOf('shown?.kind === "note"') < on);
  });

  test("押せるかの決まりとボタンの文字は今のまま（7日に1つまで）", () => {
    assert.match(review, /disabled=\{busy \|\| !can\.ok\}/);
    // 7日に1つ（直しA 8：時計は「翌日へ」で進めた日付。calendar.ts の demoInstant）
    assert.match(review, /const can = canPropose\(ads\.state, clockIso\(\), ads\.settings\);/);
    assert.match(review, /const clockIso = \(\) => demoInstant\(getShop\(\), new Date\(\), book\.state\.dayOffset\)\.toISOString\(\);/);
    for (const label of ["AI（Claude）", "決まった返事（AI なし）", "決まった返事で試す（AI なし）"]) assert.ok(review.includes(label), label);
  });
});

describe("3. 「効いたかの判定」の1行の説明", () => {
  test("題名のすぐ下に1行（日数は設定の checkAfterDays）", () => {
    assert.match(results, /<h2 id="ad-judge">効いたかの判定<\/h2>\s*<p className="section-desc">承認した案が効いたかを、承認の\{ads\.settings\.checkAfterDays\}日後に、前と後の数でプログラムが比べます<\/p>/);
  });
  test("判定が1つも無い時は「まだ判定はありません」", () => {
    assert.match(results, /\{judgements\.length === 0 && <p className="hint">まだ判定はありません。案を承認すると、\{ads\.settings\.checkAfterDays\}日後にここに出ます。<\/p>\}/);
  });
  test("今ある「デモ：判定日まで進めた」の札はそのまま", () => {
    assert.match(results, /\{j\.demo && <span className="tag text">デモ：判定日まで進めた<\/span>\}/);
  });
});

describe("4. デモの札（広告タブ）", () => {
  test("ホバー・読み上げの文は notices.ts の1つの名前", () => {
    assert.equal(DEMO_TAG_NOTE, "本物の店では出ません。試すための物です");
  });
  const tag = /<span className="tag text" title=\{DEMO_TAG_NOTE\}>\s*デモ<span className="sr-only">（\{DEMO_TAG_NOTE\}）<\/span>\s*<\/span>/;
  test("「広告（架空）を最初に戻す」に今の tag text の札（新しい部品は作らない）", () => {
    assert.match(review, new RegExp(`const demoTag = \\(\\s*${tag.source}`));
    // 押せる時の場所にも札
    assert.match(review, /<div className="reset-row">\s*\{resetButton\}\s*\{demoTag\}/);
  });
  test("「判定日まで進める（デモ）」の隣に札", () => {
    assert.match(results, new RegExp(`${tag.source}\\s*<button type="button" className="btn" onClick=\\{demo\\}>\\s*判定日まで進める（デモ）`));
  });
  test("広告の数そのものは「架空」の札のまま（デモの札は付けない）", () => {
    const weeks = report.slice(report.indexOf("export function AdsWeeks"), report.indexOf("export function AdsReport"));
    assert.match(weeks, /<span className="tag fictional">架空<\/span>/);
    assert.doesNotMatch(report, /DEMO_TAG_NOTE/);
  });
});
