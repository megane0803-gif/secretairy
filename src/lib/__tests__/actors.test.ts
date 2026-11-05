// だれがした事かの色のテスト（AI がした事 = 青緑・人がした事 = 琥珀・外の相手 = 藍）。
// - 色は3つの変数（--who-ai / --who-human / --who-outside）で決め、暗い画面でも決める
// - 使うのは予約の台帳・AI の手順・日誌の札だけ（ほかのタブの色は変えない）
// - 色だけに頼らず、札には必ず「AI」「人」「外」の文字

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JournalWhoTag } from "../../components/JournalList";
import { ActorTag } from "../../components/parts";
import { ACTOR_LABEL, journalActor, reservationActor, type Actor } from "../actors";

const ROOT = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "__tests__" ? [] : files(p);
    return /\.(tsx?|css)$/.test(n) ? [p] : [];
  });
}

describe("1. だれがした事か（src/lib/actors.ts）", () => {
  test("文字は「AI」「人」「外」の3つ", () => {
    assert.deepEqual(ACTOR_LABEL, { ai: "AI", human: "人", outside: "外" });
  });

  test("台帳：仮押さえ = AI・承認で確定 = 人・最初からの確定（店が受けて確定した予約）= 人・予約サイト（架空）から = 外", () => {
    assert.equal(reservationActor({ status: "hold", source: "chat" }), "ai");
    assert.equal(reservationActor({ status: "hold", source: "seed" }), "ai");
    assert.equal(reservationActor({ status: "confirmed", source: "chat" }), "human");
    assert.equal(reservationActor({ status: "confirmed", source: "seed" }), "human");
    assert.equal(reservationActor({ status: "confirmed", source: "site" }), "outside");
  });

  test("日誌：AI = AI・オーナー = 人・LINE = 外・予約サイト = 外・プログラムはどれでもない", () => {
    assert.equal(journalActor("AI"), "ai");
    assert.equal(journalActor("オーナー"), "human");
    assert.equal(journalActor("LINE"), "outside");
    assert.equal(journalActor("予約サイト"), "outside");
    assert.equal(journalActor("プログラム"), null);
  });
});

describe("2. 札は色だけに頼らず文字を出す", () => {
  test("ActorTag はどれも文字を出し、意味をホバーで", () => {
    for (const a of ["ai", "human", "outside"] as Actor[]) {
      const h = html(createElement(ActorTag, { actor: a }));
      assert.ok(h.includes(`<b class="actor-mark">${ACTOR_LABEL[a]}</b>`), a);
      assert.match(h, new RegExp(`class="tag actor actor-${a}"`));
      assert.match(h, /title="(AI がした事|人がした事|外の相手)"/);
    }
  });

  test("日誌の札：「AI」「人 オーナー」「外 LINE」、プログラムは今までどおりの灰色の札", () => {
    assert.match(html(createElement(JournalWhoTag, { who: "AI" })), /actor-ai"[^>]*><b class="actor-mark">AI<\/b><\/span>$/);
    assert.match(html(createElement(JournalWhoTag, { who: "オーナー" })), /actor-human"[^>]*><b class="actor-mark">人<\/b> オーナー<\/span>$/);
    assert.match(html(createElement(JournalWhoTag, { who: "LINE" })), /actor-outside"[^>]*><b class="actor-mark">外<\/b> LINE<\/span>$/);
    assert.match(html(createElement(JournalWhoTag, { who: "予約サイト" })), /actor-outside"[^>]*><b class="actor-mark">外<\/b> 予約サイト<\/span>$/);
    assert.equal(html(createElement(JournalWhoTag, { who: "プログラム" })), '<span class="tag who who-program">プログラム</span>');
  });
});

describe("3. 色は3つの変数で、使う所は台帳・AI の手順・日誌だけ", () => {
  const css = read("src/app/globals.css");

  test("明るい画面と暗い画面の両方で3つの変数を決める（青緑・琥珀・藍）", () => {
    const block = css.slice(css.indexOf("/* ---- だれがした事か（3つの色）"));
    assert.match(block, /:root \{\s*--who-ai: #0f766e;\s*--who-human: #b45309;\s*--who-outside: #4338ca;/);
    assert.match(block, /@media \(prefers-color-scheme: dark\) \{\s*:root \{\s*--who-ai: #[0-9a-f]{6};\s*--who-human: #[0-9a-f]{6};\s*--who-outside: #[0-9a-f]{6};/);
  });

  test("ActorTag・actor- の札・--who- の色を使うのは、台帳・時間割・AI の手順・日誌（と部品）だけ", () => {
    const allowed = new Set([
      "src/app/reservations/Ledger.tsx",
      "src/app/reservations/TimetableGrid.tsx",
      "src/components/AiSteps.tsx",
      "src/components/JournalList.tsx",
      // 広告の案の「AI のチーム」の会議の声（AI の役 = 青緑。§1.7.4・§3.4）
      "src/components/AdTeam.tsx",
      "src/components/parts.tsx",
      "src/lib/actors.ts",
      "src/lib/book/timetable.ts",
      "src/app/globals.css",
    ]);
    const used = files(join(ROOT, "src"))
      .filter((p) => /ActorTag|actor-(ai|human|outside)|--who-|reservationActor|journalActor/.test(readFileSync(p, "utf8")))
      .map((p) => relative(ROOT, p));
    for (const p of used) assert.ok(allowed.has(p), `${p} では使わない（ほかのタブの色は変えない）`);
  });

  test("ほかのタブで使う今までの札（who-ai・tag.hold・tag.ok）の色は変えていない", () => {
    assert.match(css, /\.tag\.who-ai \{ background: var\(--accent-soft\); color: var\(--accent\); \}/);
    assert.match(css, /\.tag\.hold \{ background: transparent; color: var\(--warn\); border: 1px dashed var\(--warn\); \}/);
    assert.match(css, /\.tag\.ok \{ background: transparent; color: var\(--ok\); border: 1px solid var\(--ok\); \}/);
  });
});
