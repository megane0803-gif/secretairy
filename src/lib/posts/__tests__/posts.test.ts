// 発信の下書きのテスト。Claude は呼ばず、決まった返事（script.ts）や決まった文を返す物に置きかえる。
// 言葉の門（全角・半角・％）・作り直しは1回・2回目も当たったら保存しない・同じ文は二重に保存しない・日時と数字はプログラムが入れる。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import aiJson from "../../../../config/ai.json";
import { calDay } from "../../calendar";
import { getCustomers, getPostMemos } from "../../data/seed";
import { resolveChatReservations, type ChatReservation } from "../../reservations";
import { getSeedRules } from "../../rules/store";
import { getMenus, getPostsAiSettings, getPostsMaterialMaxChars, getPostsSettings, getShop, type PostKind } from "../../settings";
import { fillPost, postFacts } from "../facts";
import { BLOG_LINK_MARK, CLOSED_MARK, gatePost, gateWordsIn, numbersWritten, OPENINGS_MARK } from "../gate";
import type { PostsModel, PostsModelRequest, PostsTurn } from "../model";
import { postsSystem, postsUserText } from "../prompt";
import { scriptPostsModel } from "../script";
import { EMPTY_POSTS, parsePosts, savedByKind, withSavedPost } from "../state";
import { parsePostsRequest } from "../wire";
import type { PostDraft } from "../deskStore";
import { afterFailedRedo, handEdited, needsRedoConfirm, REDO_CONFIRM } from "../redo";
import { COULD_NOT_WRITE, runWrite } from "../write";

const settings = getPostsSettings();
const ai = getPostsAiSettings();
const shop = getShop();
const memos = getPostMemos();
const kindOf = (id: string): PostKind => settings.kinds.find((k) => k.id === id)!;
const notice = kindOf("notice");
const words = settings.gateWords;

/** 決まった文を順に返す物（呼ばれた回数と、受け取った会話を覚える） */
function fixedModel(texts: string[]): PostsModel & { calls: PostsModelRequest[] } {
  const calls: PostsModelRequest[] = [];
  return {
    calls,
    async turn(req): Promise<PostsTurn> {
      calls.push({ ...req, messages: [...req.messages] });
      return { text: texts[Math.min(calls.length - 1, texts.length - 1)], stop: "end" };
    },
  };
}

const input = (model: PostsModel, kind = notice) => ({
  kind,
  materials: { topic: "冬のヘアケアのお知らせ" },
  memos,
  rules: getSeedRules(),
  shopName: shop.name,
  gateWords: words,
  model,
  maxTokens: ai.maxReplyTokens,
  maxTries: ai.maxTries,
});

describe("設定", () => {
  test("種類は3つ（お客様への配信・ブログの下書き・SNS の投稿文）。画面の名前に「LINE」は入れない", () => {
    assert.deepEqual(
      settings.kinds.map((k) => k.label),
      ["お客様への配信", "ブログの下書き", "SNS の投稿文"],
    );
    for (const k of settings.kinds) assert.doesNotMatch(k.label, /LINE/i);
    assert.deepEqual(
      settings.kinds.map((k) => k.targetChars),
      [350, 900, 200],
    );
  });

  test("上限は config にある（返事の長さ・作らせる回数・材料の字数・受け取る大きさ・保存の数）", () => {
    const a = (aiJson as Record<string, any>).posts;
    for (const k of ["maxReplyTokens", "maxTries", "maxMaterialChars", "maxRequestChars"]) assert.ok(a[k] > 0, k);
    assert.equal(ai.maxTries, 2, "1回目＋作り直し1回");
    assert.equal(getPostsMaterialMaxChars(), a.maxMaterialChars);
    assert.ok(settings.maxSavedPerKind > 0);
  });

  test("お店のメモは架空の3つで、数字を持たない", () => {
    assert.equal(memos.length, 3);
    for (const m of memos) assert.deepEqual(numbersWritten(m.text), [], m.id);
  });
});

describe("言葉の門", () => {
  test("禁止語は8つ", () => {
    assert.deepEqual(words, ["今だけ", "急いで", "絶対", "必ず", "100%", "放置", "お得", "やらないと損"]);
  });

  test("半角・全角・「％」のどれでも当てる", () => {
    assert.deepEqual(gateWordsIn("満足度100%です", words), ["100%"]);
    assert.deepEqual(gateWordsIn("満足度１００％です", words), ["100%"], "全角の数字と％");
    assert.deepEqual(gateWordsIn("満足度100％です", words), ["100%"], "半角の数字と全角の％");
    assert.deepEqual(gateWordsIn("満足度１００%です", words), ["100%"], "全角の数字と半角の%");
    assert.deepEqual(gateWordsIn("満足度100 %です", words), ["100%"], "あいだの空白");
    assert.deepEqual(gateWordsIn("今だけ、お得です。急いで！", words), ["今だけ", "急いで", "お得"]);
    assert.deepEqual(gateWordsIn("絶対に必ず。放置するとやらないと損", words), ["絶対", "必ず", "放置", "やらないと損"]);
    assert.deepEqual(gateWordsIn("冬のヘッドスパのお知らせです", words), []);
  });

  test("日時・数字・リンクを書いたら当てる（印は書いてよい）", () => {
    assert.equal(gatePost("12月にお待ちしています", words).ok, false);
    assert.equal(gatePost("１２月にお待ちしています", words).ok, false, "全角の数字");
    assert.equal(gatePost("毎週火曜はお休みです", words).ok, false, "曜日");
    assert.equal(gatePost("くわしくは https://example.com へ", words).ok, false, "リンク");
    const ok = gatePost(`空きは${OPENINGS_MARK}、お休みは${CLOSED_MARK}。${BLOG_LINK_MARK}`, words);
    assert.ok(ok.ok, ok.problems.join("・"));
    assert.deepEqual(
      ok.checks.map((c) => c.ok),
      [true, true, true, true],
    );
  });
});

describe("作り直しは1回だけ", () => {
  test("1回目が門に当たったら、理由を渡して1回だけ作り直す", async () => {
    const m = fixedModel(["今だけのお知らせです", "冬のお知らせです"]);
    const r = await runWrite(input(m));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.tries, 2);
    assert.equal(m.calls.length, 2);
    const last = m.calls[1].messages;
    assert.equal(last.length, 3, "1回目の文と、理由を積んで頼む");
    assert.equal(last[1].role, "assistant");
    assert.match(last[2].content, /「今だけ」は使わない言葉です/);
    assert.equal(r.text, "冬のお知らせです");
  });

  test("2回とも当たったら下書きは返さず「作れませんでした」（3回目は頼まない）", async () => {
    const m = fixedModel(["お得なお知らせです", "１００％満足のお知らせです", "冬のお知らせです"]);
    const r = await runWrite(input(m));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(m.calls.length, 2, "作り直しは1回だけ");
    assert.equal(r.tries, 2);
    assert.ok(!("text" in r), "下書きは返さない");
    assert.match(r.problems.join(""), /100%/);
    assert.ok(r.steps.some((s) => s.text.includes(COULD_NOT_WRITE) && s.text.includes("保存していない")), "日誌に「作れませんでした」");
  });

  test("1回目で通れば作り直さない", async () => {
    const m = fixedModel(["冬のお知らせです"]);
    const r = await runWrite(input(m));
    assert.ok(r.ok);
    assert.equal(m.calls.length, 1);
  });

  test("決まった返事：1回目は「今だけ」で弾かれ、作り直しで通る（3つの種類どれも）", async () => {
    for (const k of settings.kinds) {
      const r = await runWrite(input(scriptPostsModel(k, { topic: "冬のヘッドスパ", points: "12月は混みます。ゆっくりしてほしい" }, memos), k));
      assert.ok(r.ok, k.id);
      if (!r.ok) continue;
      assert.equal(r.tries, 2, k.id);
      assert.deepEqual(gateWordsIn(r.text, words), [], k.id);
      assert.deepEqual(numbersWritten(r.text), [], `${k.id}：材料の数字は書かない`);
      assert.ok(r.steps.some((s) => s.text.includes("言葉の門で弾いた")));
    }
  });
});

describe("保存（オーナーのボタン）", () => {
  const opts = (id: string) => ({ id, nowIso: "2026-11-04T05:00:00.000Z", gateWords: words, maxPerKind: settings.maxSavedPerKind });

  test("同じ文は二重に保存しない（前後の空白・全角半角のちがいも同じ文）", () => {
    const a = withSavedPost(EMPTY_POSTS, { kind: "notice", text: "冬のお知らせです。\n空きは11/5（木）です。", mode: "ai" }, opts("p1"));
    assert.ok(a.ok);
    if (!a.ok) return;
    const b = withSavedPost(a.state, { kind: "notice", text: "  冬のお知らせです。\n空きは１１/５（木）です。 ", mode: "ai" }, opts("p2"));
    assert.equal(b.ok, false);
    if (!b.ok) assert.equal(b.code, "dup");
    // 少しでも違えば保存できる
    const c = withSavedPost(a.state, { kind: "notice", text: "冬のお知らせです。", mode: "ai" }, opts("p3"));
    assert.ok(c.ok);
  });

  test("手で直した文に使わない言葉があれば保存しない", () => {
    const r = withSavedPost(EMPTY_POSTS, { kind: "sns", text: "今だけのご案内", mode: "ai" }, opts("p1"));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "words");
  });

  test("種類ごとに分けて新しい順。上限（config）を超えたら保存しない", () => {
    let s = EMPTY_POSTS;
    for (let i = 0; i < 3; i++) {
      const r = withSavedPost(s, { kind: i === 1 ? "blog" : "notice", text: `文その${"あいう"[i]}`, mode: "script" }, { ...opts(`p${i}`), nowIso: `2026-11-04T0${i}:00:00.000Z` });
      assert.ok(r.ok);
      if (r.ok) s = r.state;
    }
    const g = savedByKind(s, settings.kinds);
    assert.equal(g.notice.length, 2);
    assert.equal(g.blog.length, 1);
    assert.equal(g.sns.length, 0);
    assert.equal(g.notice[0].text, "文そのう", "新しい順");
    assert.deepEqual(parsePosts(JSON.stringify(s)), s, "ブラウザに残して読みなおせる");
    const full = withSavedPost(s, { kind: "notice", text: "べつの文", mode: "ai" }, { ...opts("px"), maxPerKind: 2 });
    assert.equal(full.ok, false);
    if (!full.ok) assert.equal(full.code, "full");
  });
});

describe("手で直した下書きは作り直しで消さない", () => {
  const draft = (text: string, made: string): PostDraft => ({
    kind: "notice",
    text,
    made,
    checks: [],
    inserted: [],
    tries: 1,
    cut: false,
    mode: "script",
    topic: "冬のヘアケアのお知らせ",
  });

  test("直したかどうかは text と made を比べて決める", () => {
    assert.equal(handEdited(null), false);
    assert.equal(handEdited(draft("冬のお知らせです", "冬のお知らせです")), false);
    assert.equal(handEdited(draft("冬のお知らせです。寒いですね", "冬のお知らせです")), true);
  });

  test("手で直した下書きがある時だけ「戻る／作り直す」を聞く", () => {
    assert.equal(REDO_CONFIRM, "作り直すと今の下書きが置き換わります");
    assert.equal(needsRedoConfirm(null), false, "下書きが無ければ聞かずに作る");
    assert.equal(needsRedoConfirm(draft("同じ", "同じ")), false, "直していなければ聞かずに作る");
    assert.equal(needsRedoConfirm(draft("直した", "作った")), true);
  });

  test("作り直しが門で2回とも弾かれても、手で直した下書きは残す（直していなければ今までどおり消す）", async () => {
    const m = fixedModel(["お得なお知らせです", "今だけのお知らせです"]);
    const r = await runWrite(input(m));
    assert.equal(r.ok, false);
    if (r.ok) return;
    const failed = { kind: "notice", problems: r.problems, checks: r.checks };

    const edited = draft("冬のお知らせです。手で一言足しました", "冬のお知らせです");
    const kept = afterFailedRedo(edited, failed);
    assert.equal(kept.draft, edited, "手で直した下書きは消さない");
    assert.equal(kept.draft?.text, "冬のお知らせです。手で一言足しました");
    assert.deepEqual(kept.failed, failed, "作れなかった理由もいっしょに出す");

    const plain = afterFailedRedo(draft("冬のお知らせです", "冬のお知らせです"), failed);
    assert.equal(plain.draft, null, "直していない下書きは今までどおり消える");
    assert.equal(afterFailedRedo(null, failed).draft, null);
  });
});

describe("日時と数字はプログラムが入れる", () => {
  const menus = getMenus();
  const c = getCustomers();
  const today = calDay(shop, "2026-11-04"); // 水曜
  const r = (id: string, date: string, start: string, menuId: string, i: number): ChatReservation => ({
    id,
    customerId: c[i].id,
    menuId,
    date,
    start,
    status: "confirmed",
    heldAt: "2026-11-01T00:00:00.000Z",
    expiresAt: "2026-11-02T00:00:00.000Z",
  });
  const all = resolveChatReservations(menus, c, [
    // 今日の18時から閉店まで3席とも埋まっている
    r("a1", "2026-11-04", "18:00", "perm", 0),
    r("a2", "2026-11-04", "18:00", "perm", 1),
    r("a3", "2026-11-04", "18:00", "perm", 2),
    // 明日の10時から13時まで3席とも埋まっている
    r("b1", "2026-11-05", "10:00", "straight", 3),
    r("b2", "2026-11-05", "10:00", "straight", 4),
    r("b3", "2026-11-05", "10:00", "straight", 5),
  ]);
  const facts = postFacts(shop, settings, today, { date: "2026-11-04", time: "18:00" }, all);

  test("空き枠は台帳と席の数から、お休みは店の設定から（日ごとに1行・上限は config）", () => {
    assert.deepEqual(facts.openings, ["11/5（木）13:00〜20:00", "11/6（金）10:00〜20:00", "11/7（土）10:00〜20:00"]);
    assert.equal(facts.openings.length, settings.maxOpeningDays);
    assert.deepEqual(facts.closed, ["11月10日（火）", "11月17日（火）"], "火曜定休（14日の中）。お休みの形は月日");
  });

  test("AI の印を置きかえる。要るのに印が無ければ足す（SNS はタグの前）", () => {
    const f = fillPost(`冬のお知らせです。\n\n空きは${OPENINGS_MARK}です。お休みは${CLOSED_MARK}です。\n\n【ブログのリンク】`, notice, facts);
    assert.match(f.text, /空きは11\/5（木）13:00〜20:00、11\/6（金）10:00〜20:00、11\/7（土）10:00〜20:00です/);
    assert.match(f.text, /お休みは11月10日（火）、11月17日（火）です/);
    assert.ok(f.text.includes(BLOG_LINK_MARK), "ブログのリンクは決まった印にそろえる");
    assert.doesNotMatch(f.text, /【空き枠】|【お休み】/);
    assert.deepEqual(f.inserted.sort(), ["blogLink", "closed", "openings"]);

    // 印が無い（AI が書かなかった）とき：配信は空き枠・お休み・リンクの印を足す
    const g = fillPost("冬のお知らせです。", notice, facts);
    assert.match(g.text, /空きのある日時：11\/5（木）/);
    assert.match(g.text, /お休み：11月10日（火）/);
    assert.ok(g.text.endsWith(BLOG_LINK_MARK));

    // SNS：タグは終わりのまま、その前に入れる。お休みは入れない種類
    const sns = kindOf("sns");
    const h = fillPost("冬のヘッドスパ。\n\n#美容室 #ヘアケア", sns, facts);
    const lines = h.text.split("\n").filter(Boolean);
    assert.equal(lines[lines.length - 1], "#美容室 #ヘアケア");
    assert.match(h.text, /空きのある日時：11\/5（木）13:00〜20:00/);
    assert.doesNotMatch(h.text, /お休み：/);

    // ブログはどれも足さない（印があれば置きかえる）
    assert.equal(fillPost("冬の髪\n\n## はじめに\nこんにちは。", kindOf("blog"), facts).text, "冬の髪\n\n## はじめに\nこんにちは。");
  });

  test("AI には日時を見せない（指示・材料・お店のメモに日付が無い）。AI が書いた数字は門で弾く", async () => {
    const system = postsSystem(getSeedRules(), notice, shop.name, words);
    const user = postsUserText(notice, { topic: "冬のヘアケア" }, memos);
    for (const d of [...facts.openings, ...facts.closed]) {
      assert.ok(!system.includes(d) && !user.includes(d), d);
    }
    for (const m of memos) assert.ok(user.includes(m.text), "お店のメモは全部渡す");
    assert.match(system, /日時と数字は書かない/);
    assert.ok(system.includes(OPENINGS_MARK) && system.includes(CLOSED_MARK) && system.includes(BLOG_LINK_MARK));
    assert.match(system, /お客様の顔が分かる写真は載せない/, "タブ：発信 の文のルールも渡す");
    assert.match(system, /健康や医療の判断はしない/, "鍵つきが先頭");

    const m = fixedModel(["11/5（木）に空きがあります", "11/5（木）に空きがあります"]);
    const res = await runWrite(input(m));
    assert.equal(res.ok, false, "AI が日時を書いたら2回とも弾いて作れない");
  });
});

describe("窓口（/api/ai/posts）", () => {
  test("決まった返事で：門を通った下書き（日時なし）を返す。何も残さない", async () => {
    const { POST } = await import("../../../app/api/ai/posts/route");
    const body = { mode: "script", kind: "sns", materials: { topic: "冬のヘッドスパ" }, memos, rules: [] };
    const res = await POST(new Request("http://x/api/ai/posts", { method: "POST", body: JSON.stringify(body) }));
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(j.tries, 2);
    assert.deepEqual(numbersWritten(j.text), []);
  });

  test("大きすぎる物・材料の字数を超えた物・お題の無い物は受けない", async () => {
    const { POST } = await import("../../../app/api/ai/posts/route");
    const big = JSON.stringify({ mode: "script", kind: "sns", materials: { topic: "あ".repeat(ai.maxRequestChars + 1) }, memos, rules: [] });
    assert.equal((await POST(new Request("http://x/api/ai/posts", { method: "POST", body: big }))).status, 413);
    const ids = getMenus().map((m) => m.id);
    const long = parsePostsRequest({ mode: "script", kind: "notice", materials: { topic: "あ".repeat(ai.maxMaterialChars + 1) }, memos, rules: [] }, settings.kinds, ai.maxMaterialChars, ids);
    assert.equal(long.ok, false);
    const none = parsePostsRequest({ mode: "script", kind: "notice", materials: { points: "ゆっくり" }, memos, rules: [] }, settings.kinds, ai.maxMaterialChars, ids);
    assert.equal(none.ok, false);
    const bad = parsePostsRequest({ mode: "script", kind: "line", materials: { topic: "x" }, memos, rules: [] }, settings.kinds, ai.maxMaterialChars, ids);
    assert.equal(bad.ok, false, "知らない種類");
  });
});
