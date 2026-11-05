// 見た目（スマート・夜・和紙・ポップ。docs/SPEC.md §3.5）のテスト。
// - 見た目の名前の読み方（知らない値・壊れた値はスマート）は画面に依らない関数（look.ts）
// - 4つの見た目が土台の変数をみな持ち、4つ × OS の明るい／暗い（8通り）で決めた色になる
// - スマートは今の見た目そのまま（今の :root と、OS が暗い時の塊の値）。夜・和紙・ポップは OS に左右されない
// - 色の意味（だれの3色・台帳のメニューの色・良い／気をつける）は変えない。--who-ai などの値は変えない
// - 字と背景の差（目安 4.5:1）
// - 選ぶ所はページの一番下の閉じた折りたたみの中だけ（左の列には置かない）。覚えた物は「最初に戻す」で消さない

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TabFrame } from "../../components/TabFrame";
import { BROWSER_PREFIX, LOOK_KEY } from "../browser";
import { DEFAULT_LOOK, LOOK_BASE_VARS, LOOK_LABEL, LOOKS, lookRestoreScript, parseLook, type Look } from "../look";
import { resetAllWrites } from "../reset";
import { getTabSwitches } from "../settings";
import { TAB_IDS, TABS } from "../tabs";

const ROOT = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const css = read("src/app/globals.css");

// ---- CSS を読む小さな道具 ----

type Vars = Record<string, string>;

function decls(body: string): Vars {
  const out: Vars = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+|color-scheme):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

/** 一番外の :root { … }（OS が暗い時の塊の中の物は除く。行の頭から始まる物だけ） */
const baseRoot: Vars = Object.assign({}, ...[...css.matchAll(/(?:^|\n):root \{([^}]*)\}/g)].map((m) => decls(m[1])));
/** OS が暗い時の塊（@media (prefers-color-scheme: dark) { :root { … } }）をみな重ねた物 */
const darkMedia = [...css.matchAll(/@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/g)].map((m) => decls(m[1]));
const darkRoot: Vars = Object.assign({}, ...darkMedia);

function lookBlock(look: Exclude<Look, "smart">): Vars {
  const m = css.match(new RegExp(`(?:^|\\n):root\\[data-look="${look}"\\] \\{([^}]*)\\}`));
  assert.ok(m, `:root[data-look="${look}"] の塊がある`);
  return decls(m[1]);
}

/** 見た目と OS の明るい／暗いから、効く値を出す（CSS と同じ順：今の :root → OS が暗い時の塊 → 見た目の塊） */
function effective(look: Look, osDark: boolean): Vars {
  const v: Vars = { ...baseRoot, ...(osDark ? darkRoot : {}) };
  if (look !== "smart") Object.assign(v, lookBlock(look));
  // var(--x) を1段ずつほどく（--font-head: var(--font) や --who-ai-shown: var(--who-ai)）
  for (let i = 0; i < 3; i++) for (const k of Object.keys(v)) v[k] = v[k].replace(/var\((--[a-z0-9-]+)\)/g, (_, n: string) => v[n] ?? `var(${n})`);
  return v;
}

// ---- 字と背景の差（WCAG の相対輝度） ----

const rgb = (h: string) => {
  const s = h.replace("#", "");
  const full = s.length === 3 ? [...s].map((c) => c + c).join("") : s;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
};
const lum = (h: string) => {
  const [r, g, b] = rgb(h).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** color-mix(in srgb, a p%, b) */
const mix = (a: string, b: string, p: number) => {
  const [x, y] = [rgb(a), rgb(b)];
  return "#" + x.map((c, i) => Math.round((c * p + y[i] * (1 - p)) * 255).toString(16).padStart(2, "0")).join("");
};

const SMART_LIGHT = { bg: "#f7f5f2", surface: "#ffffff", text: "#222222", muted: "#6b6b6b", line: "#e4e0da", accent: "#b5654a", accentSoft: "#f6e6df", ok: "#2f7d4f", warn: "#b7791f" };
const SMART_DARK = { bg: "#1b1a19", surface: "#262422", text: "#f1eeea", muted: "#a8a29b", line: "#3a3633", accent: "#e08b6d", accentSoft: "#3b2a24", ok: "#6fcf97", warn: "#f2c063" };
const WHO_LIGHT = { ai: "#0f766e", human: "#b45309", outside: "#4338ca" };
const WHO_DARK = { ai: "#2dd4bf", human: "#fbbf24", outside: "#a5b4fc" };
const MENU_KEYS = ["sky", "purple", "pink", "green", "rose", "olive", "none"];
const OTHERS = ["night", "washi", "pop"] as const;
/** 決めた土台の色（背景・面・字・薄い字・線・差し色・差し色の薄い面・良い・気をつける） */
const LOOK_COLORS = {
  night: { bg: "#14171c", surface: "#1d2128", text: "#e4e1da", muted: "#a6a9ae", line: "#343a44", accent: "#e9a184", accentSoft: "#3a2d29", ok: "#6fcf97", warn: "#f2c063" },
  washi: { bg: "#f2ede1", surface: "#fbf8f0", text: "#2a2420", muted: "#655b52", line: "#d9cfbd", accent: "#9b3b2a", accentSoft: "#f0e0d5", ok: "#2c6a43", warn: "#8c5a10" },
  pop: { bg: "#fff7ef", surface: "#ffffff", text: "#1c1a2b", muted: "#57536b", line: "#ebdfd2", accent: "#c81e5b", accentSoft: "#fde3ec", ok: "#1d7a46", warn: "#9a5d06" },
};
const pick = (v: Vars) => ({ bg: v["--bg"], surface: v["--surface"], text: v["--text"], muted: v["--muted"], line: v["--line"], accent: v["--accent"], accentSoft: v["--accent-soft"], ok: v["--ok"], warn: v["--warn"] });

describe("1. 見た目の名前の読み方（画面に依らない関数）", () => {
  test("4つ。最初はスマート。名前はやさしい言葉", () => {
    assert.deepEqual([...LOOKS], ["smart", "night", "washi", "pop"]);
    assert.equal(DEFAULT_LOOK, "smart");
    assert.deepEqual(LOOK_LABEL, { smart: "スマート", night: "夜", washi: "和紙", pop: "ポップ" });
  });

  test("知っている名前はそのまま", () => {
    for (const l of LOOKS) assert.equal(parseLook(l), l);
  });

  test("知らない値・壊れた値・無い時はスマート", () => {
    for (const bad of [null, undefined, "", "NIGHT", " night", "night ", '"night"', "dark", "light", "{}", "smart,pop", 1, true, {}, ["pop"]])
      assert.equal(parseLook(bad), "smart", JSON.stringify(bad));
  });

  test("開いた瞬間に付ける script も同じ読み方（知っている名前だけ data-look を付ける。読めない時も落ちない）", () => {
    const key = BROWSER_PREFIX + LOOK_KEY;
    const run = (stored: string | null, throws = false) => {
      const dataset: Record<string, string> = {};
      const localStorage = {
        getItem: (k: string) => {
          if (throws) throw new Error("読めない");
          return k === key ? stored : null;
        },
      };
      new Function("localStorage", "document", lookRestoreScript(key))(localStorage, { documentElement: { dataset } });
      return dataset.look;
    };
    for (const v of ["smart", "night", "washi", "pop", null, "", "NIGHT", '"pop"', "dark"])
      assert.equal(run(v) ?? "smart", parseLook(v), String(v));
    assert.equal(run("night", true), undefined);
    // 名前はほかの置き場所とかぶらない
    assert.equal(key, "secretairy:look");
  });

  test("layout.tsx の head の小さな script で、最初の描画の前に付ける", () => {
    const layout = read("src/app/layout.tsx");
    assert.match(layout, /\$\{lookRestoreScript\(BROWSER_PREFIX \+ LOOK_KEY\)\}/);
    assert.match(layout, /<head>\s*<script dangerouslySetInnerHTML=\{\{ __html: restoreLayout \}\} \/>\s*<\/head>/);
  });

  test("「最初に戻す」では見た目を消さない", () => {
    const keys = resetAllWrites("2026-11-05").map((w) => w.key);
    assert.ok(!keys.includes(LOOK_KEY));
  });
});

describe("2. 4つの見た目が土台の変数をみな持つ", () => {
  test("スマートは今の :root に、夜・和紙・ポップはそれぞれの塊に、決めた土台の変数が全部ある", () => {
    for (const k of LOOK_BASE_VARS) assert.ok(k in baseRoot, `スマート ${k}`);
    for (const l of OTHERS) {
      const b = lookBlock(l);
      for (const k of LOOK_BASE_VARS) assert.ok(k in b, `${l} ${k}`);
    }
  });

  test("OS が暗い時の塊が変える物は、夜・和紙・ポップがみな上書きする（暗い色が混ざらない）。だれの3色は表示用の変数で上書き", () => {
    for (const l of OTHERS) {
      const b = lookBlock(l);
      for (const k of Object.keys(darkRoot)) {
        const shown = k.match(/^--who-(ai|human|outside)$/) ? `${k}-shown` : k;
        assert.ok(shown in b, `${l} ${shown}`);
      }
      assert.equal(b["color-scheme"], l === "night" ? "dark" : "light");
    }
  });

  test("だれの3色を使う所は、みな表示用の変数（--who-*-shown）を通す", () => {
    const direct = [...css.matchAll(/var\(--who-(ai|human|outside)\)/g)].length;
    assert.equal(direct, 3, "表示用の変数を作る所の3つだけ");
    assert.match(css, /:root \{\s*--who-ai-shown: var\(--who-ai\);\s*--who-human-shown: var\(--who-human\);\s*--who-outside-shown: var\(--who-outside\);\s*\}/);
    for (const a of ["ai", "human", "outside"]) assert.match(css, new RegExp(`\\.actor-${a} \\{ --who: var\\(--who-${a}-shown\\); \\}`));
  });
});

describe("3. 4つ × OS の明るい／暗い（8通り）で決めた色になる", () => {
  test("スマート：OS が明るい時は今の明るい色、暗い時は今の暗い色（今の見た目そのまま）", () => {
    const light = effective("smart", false);
    const dark = effective("smart", true);
    assert.deepEqual(pick(light), SMART_LIGHT);
    assert.deepEqual(pick(dark), SMART_DARK);
    // 置きかえた変数のスマートの値は、今まで直に書いていた値そのまま
    assert.equal(light["--on-accent"], "#fff");
    assert.equal(light["--font-head"], light["--font"]);
    assert.equal(light["--head-weight"], "700");
    assert.deepEqual(
      ["--radius", "--radius-md", "--radius-sm", "--radius-xs", "--radius-2xs", "--radius-3xs", "--radius-pill", "--shadow"].map((k) => light[k]),
      ["12px", "10px", "8px", "6px", "4px", "3px", "999px", "none"],
    );
    for (const [k, v] of Object.entries(WHO_LIGHT)) assert.equal(light[`--who-${k}-shown`], v);
    for (const [k, v] of Object.entries(WHO_DARK)) assert.equal(dark[`--who-${k}-shown`], v);
    assert.equal(dark["color-scheme"], undefined, "スマートには color-scheme を足さない（今のまま）");
  });

  for (const l of OTHERS) {
    test(`${LOOK_LABEL[l]}：OS が明るくても暗くても同じ色`, () => {
      // --who-ai などそのものは画面では直に使わない（表示用の --who-*-shown を通す。下の 2. で確かめる）
      const used = (v: Vars) => Object.fromEntries(Object.entries(v).filter(([k]) => !/^--who-(ai|human|outside)$/.test(k)));
      const light = effective(l, false);
      const dark = effective(l, true);
      assert.deepEqual(used(light), used(dark));
      assert.deepEqual(pick(light), LOOK_COLORS[l]);
    });
  }

  test("台帳のメニューの色は今の組のまま（夜 = 今の暗い組、和紙・ポップ = 今の明るい組）", () => {
    for (const l of OTHERS) {
      const v = effective(l, true);
      const want = l === "night" ? effective("smart", true) : effective("smart", false);
      for (const c of MENU_KEYS) assert.equal(v[`--menu-${c}`], want[`--menu-${c}`], `${l} ${c}`);
      assert.equal(v["--menu-soft-pct"], want["--menu-soft-pct"]);
    }
  });

  test("だれの3色は同じ色の仲間のまま（夜 = 今の暗い値、和紙・ポップ = 青緑・琥珀・藍の濃い所）。--who-ai などの値は変えない", () => {
    assert.deepEqual({ ai: baseRoot["--who-ai"], human: baseRoot["--who-human"], outside: baseRoot["--who-outside"] }, WHO_LIGHT);
    assert.deepEqual({ ai: darkRoot["--who-ai"], human: darkRoot["--who-human"], outside: darkRoot["--who-outside"] }, WHO_DARK);
    for (const l of OTHERS) {
      const b = lookBlock(l);
      for (const k of ["--who-ai", "--who-human", "--who-outside"]) assert.ok(!(k in b), `${l} は ${k} を書きかえない`);
    }
    const night = effective("night", false);
    for (const [k, v] of Object.entries(WHO_DARK)) assert.equal(night[`--who-${k}-shown`], v);
    // 和紙・ポップ：色合い（青緑・琥珀・藍）は同じで、明るさだけ合わせる
    const hue = (h: string) => {
      const [r, g, b] = rgb(h);
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      const x = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (x * 60 + 360) % 360;
    };
    for (const l of ["washi", "pop"] as const) {
      const v = effective(l, true);
      for (const [k, base] of Object.entries(WHO_LIGHT)) assert.ok(Math.abs(hue(v[`--who-${k}-shown`]) - hue(base)) < 8, `${l} ${k}`);
    }
  });
});

describe("4. 字と背景の差", () => {
  for (const l of LOOKS) {
    for (const osDark of [false, true]) {
      test(`${LOOK_LABEL[l]}（OS が${osDark ? "暗い" : "明るい"}）：ふつうの字・薄い字と背景・面は 4.5:1 以上。台帳の帯の字も`, () => {
        const v = effective(l, osDark);
        for (const fg of ["--text", "--muted"]) for (const bg of ["--bg", "--surface"]) assert.ok(ratio(v[fg], v[bg]) >= 4.5, `${fg} / ${bg} ${ratio(v[fg], v[bg]).toFixed(2)}`);
        const pct = parseFloat(v["--menu-soft-pct"]) / 100;
        for (const c of MENU_KEYS) {
          const band = mix(v[`--menu-${c}`], v["--surface"], pct);
          assert.ok(ratio(v["--text"], band) >= 4.5, `帯 ${c}`);
        }
      });
    }
  }

  for (const l of OTHERS) {
    test(`${LOOK_LABEL[l]}：札（AI・人・外・差し色・良い・気をつける）と差し色のボタンの字は 4.5:1 以上`, () => {
      const v = effective(l, false);
      for (const a of ["ai", "human", "outside"]) {
        const c = v[`--who-${a}-shown`];
        assert.ok(ratio(c, mix(c, v["--surface"], 0.12)) >= 4.5, `${a} の札`);
        assert.ok(ratio(c, mix(c, v["--bg"], 0.12)) >= 4.5, `${a} の札（背景の上）`);
      }
      for (const k of ["--accent", "--ok", "--warn", "--muted"]) assert.ok(ratio(v[k], v["--surface"]) >= 4.5, k);
      assert.ok(ratio(v["--accent"], v["--accent-soft"]) >= 4.5, "差し色の薄い面の上の差し色（今のタブ・AI の札）");
      assert.ok(ratio(v["--on-accent"], v["--accent"]) >= 4.5, "差し色のボタンの字");
    });
  }
});

describe("5. 色・角の丸み・見出しの字は変数で書く（直に書かない）", () => {
  test("globals.css：色は変数を決める所の外に直に書かない", () => {
    // 変数を決める塊（:root …）を外した残り
    const rest = css.replace(/(?:^|\n)(?:@media \(prefers-color-scheme: dark\) \{\s*)?:root(?:\[data-look="[a-z]+"\])? \{[^}]*\}(?:\s*\})?/g, "\n");
    assert.doesNotMatch(rest.replace(/\/\*[\s\S]*?\*\//g, ""), /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });

  test("globals.css：角の丸みは変数で。残すのは丸（50%）・0・絵の形（スマホの枠・細い線・細い棒）だけ", () => {
    const vals = [...css.matchAll(/border-radius: ([^;}]+)/g)].map((m) => m[1].trim());
    const allowed = new Set(["50%", "28px", "22px", "1px", "5px"]);
    for (const v of vals) {
      for (const t of v.split(/\s+(?![^(]*\))/)) assert.ok(t === "0" || t.startsWith("var(--radius") || allowed.has(t) || t === "2px", `${v}`);
    }
  });

  test("見出し（h1〜h4）の字と太さは変数", () => {
    assert.match(css, /h1, h2, h3, h4 \{ font-family: var\(--font-head\); font-weight: var\(--head-weight\); \}/);
  });

  test("外から字を読み込まない（OS に入っている字だけ）", () => {
    assert.doesNotMatch(css, /@import|@font-face|url\(/);
    assert.doesNotMatch(read("src/app/layout.tsx"), /next\/font|fonts\.googleapis/);
  });

  test("画面の部品（src/app・src/components）に色・角の丸み・字を直に書かない", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) return n === "__tests__" || n === "api" ? [] : files(p);
        return /\.tsx$/.test(n) ? [p] : [];
      });
    for (const p of [...files(join(ROOT, "src/app")), ...files(join(ROOT, "src/components"))]) {
      const src = readFileSync(p, "utf8");
      assert.doesNotMatch(src, /["'`]#[0-9a-fA-F]{3,8}["'`]|rgba?\(|borderRadius|fontFamily/, relative(ROOT, p));
    }
  });
});

describe("6. 選ぶ所は、ページの一番下の閉じた折りたたみの中だけ", () => {
  const render = (tab: (typeof TAB_IDS)[number]) =>
    renderToStaticMarkup(
      createElement(TabFrame, {
        tab,
        baseSwitches: getTabSwitches(),
        pending: createElement("a", { className: "pending" }, "p"),
        right: createElement("p", null, "RIGHT"),
        children: createElement("section", null, "BODY"),
      }),
    );

  for (const tab of TAB_IDS) {
    test(`${TABS[tab].label}：${TABS[tab].required ? "閉じた「見た目」" : "閉じた「このタブの表示」"}の中に4つのボタン。最初はスマートに ✓`, () => {
      const html = render(tab);
      const folds = [...html.matchAll(/<details class="([^"]*)"[^>]*>([\s\S]*?)<\/details>/g)];
      assert.equal(folds.length, 1, "折りたたみは1つ");
      const [whole, cls, inner] = folds[0];
      assert.ok(!/\bopen\b/.test(whole.slice(0, whole.indexOf(">"))), "最初は閉じたまま");
      assert.equal(cls, TABS[tab].required ? "fold tab-switch-fold look-fold" : "fold tab-switch-fold");
      assert.match(inner, new RegExp(`^<summary>${TABS[tab].required ? "見た目" : "このタブの表示"}</summary>`));
      assert.equal(inner.match(/<button type="button" class="look-btn/g)?.length, 4);
      assert.equal(inner.match(/aria-pressed="true"/g)?.length, 1);
      assert.match(inner, /class="look-btn on" aria-pressed="true"><span class="look-btn-name"><span class="look-btn-mark" aria-hidden="true">✓<\/span>スマート/);
      // ページの一番下（右の列より前の、真ん中の列の終わり）
      assert.ok(html.indexOf("BODY") < html.indexOf("<details"));
      assert.ok(html.indexOf("</details></main>") > 0);
    });
  }

  test("左の列（タブの一覧）には何も足さない", () => {
    assert.doesNotMatch(read("src/components/TabNav.tsx"), /LookPicker|look/i);
    const users = ["src/components/TabFrame.tsx"];
    const all = readdirSync(join(ROOT, "src/components")).map((n) => `src/components/${n}`).filter((p) => /<LookPicker\b/.test(read(p)));
    assert.deepEqual(all, users);
  });
});
