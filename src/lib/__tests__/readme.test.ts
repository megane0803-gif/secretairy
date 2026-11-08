// README を提出の形に読むテスト（直しN・直しN2）。外は呼ばない。
// 入口の塊（中央寄せ・本番を開く・デモ動画は決めた URL へのリンク・写真は押すと本番）・「ナレーションは合成音声です」の行・
// GitHub で消える・壊れる書き方（裸の URL のすぐ後ろの全角の文字）・
// 30秒で分かる要点・畳んだ節の形・デモ動画の素材の表・動画で見られると書く所・AI の窓口の回数の止め・ライセンス・
// データの置き場所の「実際の店で使う時」と「次に作る物」の一番上の行。

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

const ROOT = join(__dirname, "..", "..", "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const SITE = "https://secretairy.vercel.app";
/** デモ動画（YouTube）。オーナーが渡した URL だけを使い、作らない・短くしない・ほかに変えない */
const VIDEO = "https://youtu.be/Lw1JhyqQ7bQ";

/** 見出し（行の頭から）で区切った1つの節。次の同じ深さか浅い見出しの前まで */
function section(heading: string): string {
  const start = readme.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `見出しが無い：${heading}`);
  const depth = heading.match(/^#+/)![0].length;
  const rest = readme.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`\\n#{1,${depth}} `));
  return next < 0 ? rest : rest.slice(0, next);
}

describe("README：入口の塊（一番上・中央寄せ）", () => {
  const top = readme.slice(0, readme.indexOf("## 30秒で分かる要点"));

  test("一番上は中央寄せの題名で、読みはシークレタリー（前の読みは残さない）", () => {
    assert.ok(readme.startsWith('<h1 align="center">SecretAIry（シークレタリー）</h1>'));
    assert.doesNotMatch(readme, /セクレタイリー/);
  });

  test("題名のすぐ下に、だれが・何に困っている → 作品が何をする、の順の1段", () => {
    const pitch = top.slice(top.indexOf("</h1>"), top.indexOf("本番を開く"));
    const who = pitch.indexOf("1人で営業する美容室のオーナー");
    const trouble = pitch.indexOf("後回し");
    const what = pitch.indexOf("AI 秘書");
    assert.ok(who >= 0 && trouble > who && what > trouble, pitch);
  });

  test("本番を開くリンクの後に、「デモ動画」の文字で決めた URL を開くリンク（準備中の言い方は残さない）", () => {
    assert.ok(top.includes(`<a href="${SITE}"><b>本番を開く（${SITE}）</b></a>`));
    const link = top.indexOf(`<a href="${VIDEO}"><b>デモ動画</b></a>`);
    assert.ok(link > top.indexOf("本番を開く"), "デモ動画のリンクは本番を開くの後");
    assert.doesNotMatch(readme, /デモ動画[^\n]*準備中/, "デモ動画はもう準備中ではない");
    assert.doesNotMatch(readme, /提出の前にここにリンクを入れます/);
  });

  test("写真：docs/images の PNG・幅を決めて中央・押すと本番が開く・ファイルは小さい", () => {
    const m = top.match(/<p align="center">\s*<a href="([^"]+)"><img src="(docs\/images\/[^"]+\.png)" width="(\d+)" alt="[^"]+"><\/a>\s*<\/p>/);
    assert.ok(m, "写真をリンクで包み、中央に出す");
    assert.equal(m[1], SITE);
    assert.ok(Number(m[3]) >= 320 && Number(m[3]) <= 900, `幅 ${m[3]}`);
    assert.ok(statSync(join(ROOT, m[2])).size < 300 * 1024, "写真は小さく縮める");
  });

  test("デモ動画のリンクは1か所だけ（ほかの動画の URL を置かない）で、すぐ下の行が「ナレーションは合成音声です」", () => {
    assert.equal(readme.split(VIDEO).length - 1, 1);
    assert.deepEqual(readme.match(/https?:\/\/(?:www\.|m\.)?(?:youtu\.be|youtube\.com)\/[^\s"'<>)）]*/g), [VIDEO]);
    assert.match(readme, /<a href="https:\/\/youtu\.be\/Lw1JhyqQ7bQ"><b>デモ動画<\/b><\/a>(<br>)?\s*\n\s*(<sub>)?ナレーションは合成音声です/);
  });

  test("GitHub が消す物（style・iframe・script）と、見えない HTML のコメントを使わない", () => {
    assert.doesNotMatch(readme, /<style|<iframe|<script|<!--/i);
  });

  test("裸の URL のすぐ後ろに全角の文字を続けない（GitHub が続きまで URL と読み、リンクが壊れる。<…> で囲む）", () => {
    const outsideLinks = readme.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, "");
    const broken = outsideLinks.match(/https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+(?=[^\x00-\x7F])/g);
    assert.equal(broken, null, String(broken));
  });
});

describe("README：30秒で分かる要点と畳んだ節", () => {
  test("30秒で分かる要点は入口のすぐ下（だれが・何をする・決めるのは人・どこで試せるか）", () => {
    const sec = section("## 30秒で分かる要点");
    for (const w of ["だれが・何に困っている", "作品が何をする", "決めるのはいつも人", "どこで試せるか", SITE]) assert.ok(sec.includes(w), w);
    assert.ok(readme.indexOf("## 30秒で分かる要点") < readme.indexOf("## だれが・どんな場面で困るか"));
    // 細かい例は後半へ
    assert.ok(readme.indexOf("## 現場の決まりの例：店の中の都合はお客様に言わない") > readme.indexOf("## できること"));
  });

  test("<details> は全部 <summary> を持って閉じている", () => {
    const opens = readme.match(/^<details>$/gm)?.length ?? 0;
    assert.ok(opens > 0);
    assert.equal(readme.match(/^<\/details>$/gm)?.length, opens);
    assert.equal(readme.match(/^<details>\n<summary>[^<\n]+<\/summary>$/gm)?.length, opens);
  });

  test("言い切りの言葉を使わない", () => {
    assert.doesNotMatch(readme, /必ず|100%|すぐ反映/);
  });
});

describe("README：使った物と権利のデモ動画の表", () => {
  const sec = section("### デモ動画");

  test("5行（ナレーション・音楽・文字・動き・絵）", () => {
    const rows = sec.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| 使った所") && !l.startsWith("|---"));
    assert.deepEqual(
      rows.map((r) => r.split("|")[1].trim()),
      ["ナレーション（声）", "音楽（BGM）", "文字", "動き", "絵"],
    );
    for (const w of ["AivisSpeech", "1.1.0-dev（プレリリース版）", "LGPL-3.0", "「にせ」", "AivisHub", "6d11c6c2-f4a4-4435-887e-23dd60f8b8dd", "Aivis Common Model License（ACML）1.0", "使った声はこの1つだけ", "GarageBand", "ループは使っていない", "ヒラギノ角ゴシック・ヒラギノ明朝", "GSAP", "素材サイトの写真・絵・効果音は使っていない"])
      assert.ok(sec.includes(w), w);
  });

  test("AivisSpeech の版に日付を付けない", () => {
    // 版のすぐ後ろ（かっこの中も）に日付の数を書かない
    assert.match(sec, /AivisSpeech（版 1\.1\.0-dev（プレリリース版））/);
    assert.doesNotMatch(sec, /1\.1\.0-dev(（[^）]*)?\s*\d/);
  });

  test("表の下に「声と音楽は動画にだけ使い、アプリの中では使っていません」", () => {
    assert.match(sec, /\|\n\n声と音楽は動画にだけ使い、アプリの中では使っていません。/);
  });
});

describe("README：データの置き場所の「実際の店で使う時」", () => {
  const data = readme.slice(readme.indexOf("## データの置き場所"), readme.indexOf("## LINE とつなぐ"));
  const plan = data.slice(data.indexOf("### 実際の店で使う時"));

  test("データの置き場所の中にあり、予定の話だと分かる（作った物のように書かない）", () => {
    assert.ok(data.includes("### 実際の店で使う時"));
    assert.match(plan, /このデモでは作っていません/);
    assert.match(plan, /変える予定です/);
    for (const w of ["お客様の予約とオーナーの台帳を同じ場所に置く", "PC・スマホ・LINE のどこから見ても、同じ台帳", "台帳やカルテが消えません", "合言葉で鍵をかけて保存する形は選びません", "施術中の声は今どおりブラウザの外に出さず", "暗号化に使う鍵は今どおり環境変数だけ", "経理の freee の暗号化した鍵", "「確定は人のボタン」「健康や医療の判断はしない」の決まりは変えません"])
      assert.ok(plan.includes(w), w);
  });

  test("「次に作る物」の一番上の行と、おたがいに指し合う", () => {
    assert.ok(plan.includes("[「次に作る物」](#次に作る物)の一番上の行と同じ方針"));
    const next = section("## 次に作る物");
    const first = next.split("\n").find((l) => l.startsWith("- "))!;
    for (const w of ["サーバーに保存してオーナーがログイン", "店ごとに中身を分け", "控えを持つ", "今はデモとして、ブラウザごとに保存", "(#実際の店で使う時)"]) assert.ok(first.includes(w), w);
  });
});

describe("README：動画で見られると書く所は、動画に映っている物だけ", () => {
  const claims = readme.split(/[。\n]/).filter((x) => x.includes("動画で"));

  test("経理は、来た人の欄で未処理の明細を読み、1件を店用にして登録する様子（オーナーがつなぐ所・明細を入れる所は動画に無い）", () => {
    assert.ok(readme.includes("来た人の欄で、freee のテスト事業所の未処理の明細を読み、1件を店用にして登録する様子は、デモ動画で見られます。"));
    assert.doesNotMatch(readme, /明細を入れて、freee から読んだカードと銀行の明細が一覧に出て/);
  });

  test("動画に映っていない物（つなぐ所・明細を入れる所・元に戻る所・Google 広告の画面）を「動画で」と書かない", () => {
    assert.ok(claims.length >= 2, claims.join("\n"));
    for (const c of claims) assert.doesNotMatch(c, /つな|明細を入れ|元に戻|Google 広告の画面|準備中/, c);
  });
});

describe("README：AI の窓口の回数の止め", () => {
  test("本番で確かめた形で書き、「確かめていない」と書かない", () => {
    const guard = readme.split("\n").find((l) => l.startsWith("- AI の窓口（`/api/ai/`）："));
    assert.ok(guard, "だれでも呼べる窓口の守りの、AI の窓口の行");
    assert.doesNotMatch(guard, /確かめていません/);
    for (const w of ["2026-11-08 14:14", "1〜10回目は 404", "11回目と12回目は 429"]) assert.ok(guard.includes(w), w);
    const unchecked = section("### 確かめていない範囲");
    assert.doesNotMatch(unchecked, /AI の窓口の回数の上限/);
    assert.match(unchecked, /AI の窓口（`\/api\/ai\/`）の回数の止めは、本番で[^。]*効いているのを確かめました/);
  });

  test("Firewall の止めは AI の窓口の行にだけ書く（広告と経理の試しの窓口の行には書かない）", () => {
    const lines = readme.split("\n").filter((l) => l.includes("Firewall"));
    assert.ok(lines.length > 0);
    for (const l of lines) assert.doesNotMatch(l, /\/api\/ads\/|\/api\/freee\//, l);
  });
});

describe("README：ライセンス", () => {
  test("MIT で確定（仮の言い方を残さない）", () => {
    assert.equal(section("## ライセンス").trim(), "[MIT](LICENSE)。");
    assert.doesNotMatch(readme, /仮に置いています|後で変えることがあります/);
  });
});
