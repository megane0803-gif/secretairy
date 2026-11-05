// 公開 URL を本物の AI で使い倒して見つかった直しのテスト（A 画面・B 予約チャット・C カルテ・D 発信・E 架空の数・F ToDo）。
// Claude は呼ばず、決まった返事か決まった文を返す物に置きかえる。画面は描かずに、決まり（関数・ソース・設定）で確かめる。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import recordingJson from "../../../config/recording.json";
import { fullWidthQuestion } from "../ai/agent";
import type { ModelRequest, ModelTurn, ReplyModel } from "../ai/model";
import { alsoBooking, asksPrice, menusInText, priceAnswer, unknownItems, yen } from "../ai/prices";
import { ASK_SHOP_REPLY } from "../ai/replies";
import { reserveSystem } from "../ai/reservePrompt";
import { scriptModel } from "../ai/script";
import { orderNear } from "../ai/slots";
import { runTool } from "../ai/tools";
import { at, chat, ctxAt, menus } from "../ai/__tests__/helpers";
import { approvalQueue, approvalsFor } from "../approvals";
import { EMPTY_ADS, type AdsState } from "../ads/state";
import { emptyBook, withHold, type BookState } from "../book/state";
import { calDay } from "../calendar";
import { getAccounting, getAds, getCustomers, getPostMemos } from "../data/seed";
import { KARTE_GATE_WORDS } from "../rules/locked";
import { runKarte } from "../karte/run";
import { lineKey, nextWishes, sameContent, tidySections } from "../karte/tidy";
import type { KarteWriter } from "../karte/writer";
import { scriptKarteWriter } from "../karte/writer";
import { periodOf, postFacts } from "../posts/facts";
import { gatePost, numbersWritten, OPENINGS_MARK } from "../posts/gate";
import type { PostsModel, PostsModelRequest, PostsTurn } from "../posts/model";
import { postsSystem } from "../posts/prompt";
import { bodyChars, maxCharsOf, runWrite } from "../posts/write";
import { resolveChatReservations, type ChatReservation } from "../reservations";
import { getRules, getSeedRules } from "../rules/store";
import { getAiSettings, getKarteHeadings, getPostsAiSettings, getPostsSettings, getShop } from "../settings";
import { memoDue } from "../todo/due";
import { todoGroup, todoItems, withMemoTodo } from "../todo/items";

const ROOT = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const shop = getShop();
const headings = getKarteHeadings();

// ---------------------------------------------------------------- A. 見る人が困る所

describe("A1. スマホで予約タブを開くと、予約チャットがページの上（承認待ちと見出しのすぐ下）", () => {
  test("予約タブは rightFirstOnPhone で包み、TabFrame はその時だけ right-first-sp の札を付ける", () => {
    assert.match(read("src/app/reservations/page.tsx"), /<TabPage[\s\S]*?rightFirstOnPhone[\s\S]*?right=\{/);
    const frame = read("src/components/TabFrame.tsx");
    assert.match(frame, /rightFirstOnPhone \? "page right-first-sp" : "page"/);
    // 経理タブも、スマホで freee の欄（右の列）をページの上に出すので同じ口を使う（UI4）
    assert.match(read("src/app/accounting/page.tsx"), /<TabPage tab="accounting"[\s\S]*?rightFirstOnPhone>/);
    // ほかのタブは今のまま（札を付けない）
    for (const tab of ["home", "karte", "ads", "posts", "rules", "todo"])
      assert.doesNotMatch(read(`src/app/${tab}/page.tsx`), /rightFirstOnPhone/, tab);
  });

  test("CSS：スマホ（1024px より狭い）だけ、承認待ち → 見出し → 右の列（予約チャット）→ ページの中身 の順", () => {
    const css = read("src/app/globals.css");
    const block = css.match(/@media \(max-width: 1023\.98px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    assert.match(block, /\.page\.right-first-sp > \.page-main \{ display: contents; \}/);
    const order = (sel: string) => Number(block.match(new RegExp(`${sel.replace(/[.>]/g, (c) => `\\${c}`)} \\{[^}]*order: (-?\\d+)`))?.[1]);
    const pending = order(".page.right-first-sp > .page-main > .pending");
    const head = order(".page.right-first-sp > .page-main > .page-head");
    const right = order(".page.right-first-sp > .page-right");
    assert.ok(pending < head && head < right && right < 0, `${pending} < ${head} < ${right} < 0（中身は 0）`);
  });
});

describe("A2. 予約タブの「承認待ち」は予約の行だけ（ホームの箱は全部のまま）", () => {
  const nowIso = "2026-11-04T02:00:00.000Z";
  const book: BookState = withHold(emptyBook("2026-11-04"), {
    id: "h1",
    customerId: "c04",
    menuId: "cut",
    date: "2026-11-06",
    start: "15:00",
    heldAt: "2026-11-04T01:00:00.000Z",
    expiresAt: "2026-11-05T01:00:00.000Z",
    reason: "お客様が候補から選びました",
  });
  const ads: AdsState = {
    ...EMPTY_ADS,
    proposals: [
      {
        id: "ad1",
        createdAt: nowIso,
        action: "stop",
        no: 3,
        text: "架空の言葉",
        reason: "予約につながっていません。",
        state: "pending",
        checks: [],
        total: { clicks: 1, cost: 1, bookings: 0 } as AdsState["proposals"][number]["total"],
        fixed: false,
        mode: "script",
      },
    ],
  };

  test("同じ行（approvals.ts）から、予約タブは予約の行だけ・ホームは広告の案も", () => {
    const q = approvalQueue(book, ads, nowIso);
    assert.equal(q.reservations.length, 1, "仮押さえの行");
    assert.ok(q.ad, "広告の案の行");
    assert.equal(q.count, 2, "上の帯の数は全部のまま");
    const res = approvalsFor(q, "reservations");
    assert.equal(res.ad, null, "予約タブには広告の案を出さない");
    assert.equal(res.count, 1);
    assert.deepEqual(approvalsFor(q, "all"), { reservations: q.reservations, ad: q.ad, count: 2 });
  });

  test("予約タブは only=\"reservations\" で、その時は広告の案の行（AdApprovalRows）を描かない", () => {
    assert.match(read("src/app/reservations/page.tsx"), /<ApprovalBox data=\{data\} compact only="reservations" \/>/);
    const box = read("src/components/ApprovalBox.tsx");
    assert.match(box, /approvalsFor\(useApprovals\(\), only\)/);
    assert.match(box, /\{only !== "reservations" && <AdApprovalRows/);
    assert.match(read("src/app/home/page.tsx"), /<ApprovalBox data=\{data\} \/>/, "ホームは全部");
  });
});

describe("A3. 作りかけの札は画面に出さず、仕様書の「まだ」だけに残す", () => {
  test("ホーム・カルテ・発信のページに「…はまだです」が無い", () => {
    for (const tab of ["home", "karte", "posts"]) {
      const src = read(`src/app/${tab}/page.tsx`);
      assert.doesNotMatch(src, /<NotYet|はまだです/, tab);
    }
  });

  test("仕様書の §9.3「まだ」には作っていない物だけが残る（作った物は本文へ）", () => {
    const spec = read("docs/SPEC.md");
    const notYet = spec.slice(spec.indexOf("### 9.3"));
    assert.match(notYet, /発信：段落ごとの言い換え案。使うお店のメモを選ぶ欄/);
    // 1.4 で作った：朝の要点の AI の一言・カルテのお客様一覧・カルテを人が直す
    assert.doesNotMatch(notYet, /^- 朝の要点の AI の一言（文章）。$/m);
    assert.doesNotMatch(notYet, /カルテ：お客様の一覧/);
    assert.doesNotMatch(notYet, /カルテ：「手で直す」/);
    const body = spec.slice(0, spec.indexOf("### 9.3"));
    assert.match(body, /\*\*AI の一言\*\*/);
    assert.match(body, /### 1\.5\.2 カルテを人が直す/);
    assert.match(body, /### 1\.5\.3 お客様一覧/);
  });
});

describe("A4. 表示スイッチの札（「いつも出す（必須）」「出している」）は出さない", () => {
  const frame = read("src/components/TabFrame.tsx");
  test("札の言葉が無い", () => {
    assert.doesNotMatch(frame, /いつも出す（必須）|"出している"|"隠している"/);
  });
  test("見出しの横にスイッチを置かず、ページの終わりの畳んだ所（このタブの表示）に。必須のタブには出さない", () => {
    const head = frame.match(/<div className="page-head">([\s\S]*?)<\/div>/)?.[1] ?? "";
    assert.doesNotMatch(head, /toggle/, "見出しの横には出さない");
    assert.match(frame, /\{!def\.required && \(\s*<details className="fold tab-switch-fold">\s*<summary>このタブの表示<\/summary>\s*<div>\{toggle\}<\/div>/);
    // 隠したタブの「出していません」には、今までどおりスイッチを出す（出しなおせるように）
    assert.match(frame, /このタブは出していません[\s\S]*?\{toggle\}/);
  });
});

// ---------------------------------------------------------------- B. 予約チャット

/** 呼ばれたら落ちる物（AI を呼ばないことを確かめる） */
const neverModel: ReplyModel = {
  async turn() {
    throw new Error("AI は呼ばない");
  },
};

/** 決まった文を返すだけの物 */
function sayModel(text: string): ReplyModel & { calls: number } {
  const m = {
    calls: 0,
    async turn(_req: ModelRequest, onText: (d: string) => void): Promise<ModelTurn> {
      m.calls += 1;
      onText(text);
      return { assistant: [{ type: "text", text }], toolCalls: [], stop: "end" };
    },
  };
  return m;
}

describe("B5. 代わりの候補は、元の希望の時刻に近い所から（火曜の午後 → 水曜の朝ではなく水曜の午後）", () => {
  // 2026-11-09（月）09:00 に開いた。火曜（11/10）は定休日
  const ctx = ctxAt(at("2026-11-09", "09:00"));

  test("orderNear：近い順。同じ近さなら希望より後の時刻を先に。near が無ければ今のまま", () => {
    assert.deepEqual(orderNear(["10:00", "13:00", "14:00", "15:00", "16:00"], "15:00"), ["15:00", "16:00", "14:00", "13:00", "10:00"]);
    assert.deepEqual(orderNear(["10:00", "11:00"], undefined), ["10:00", "11:00"]);
  });

  test("ルールを確かめる：火曜15時のカット → 代わりは水曜の15時のそば（朝の10時からではない）", () => {
    const out = runTool(ctx, "check_rules", { menu_id: "cut", date: "2026-11-10", start: "15:00" });
    assert.ok(out.candidates && out.candidates.length > 0);
    for (const c of out.candidates!) {
      assert.equal(c.date, "2026-11-11", "次の営業日");
      assert.ok(Math.abs(toMin(c.start) - toMin("15:00")) <= 120, `${c.start} は15時のそば`);
    }
    assert.equal(out.candidates![0].start, "15:00", "同じ時刻があればそれから");
  });

  test("空きを調べる：火曜の午後（after 13:00）→ 水曜の午後から", () => {
    const out = runTool(ctx, "find_openings", { menu_id: "cut", date: "2026-11-10", after: "13:00" });
    assert.ok(out.candidates && out.candidates.length > 0);
    assert.equal(out.candidates![0].date, "2026-11-11");
    for (const c of out.candidates!) assert.ok(c.start >= "12:00", `${c.start} は午後のそば`);
  });

  test("日も時刻も言わない「空いてる？」は今のまま（今から先・開店から順）", () => {
    const out = runTool(ctx, "find_openings", { menu_id: "cut" });
    const starts = out.candidates!.map((c) => `${c.date} ${c.start}`);
    assert.deepEqual(starts, [...starts].sort(), "時刻の順");
  });
});

describe("B6. 料金は設定のメニューの値段をプログラムが返す（AI に書かせない）", () => {
  const cut = menus.find((m) => m.id === "cut")!;
  const color = menus.find((m) => m.id === "color")!;
  const cutColor = menus.find((m) => m.id === "cut_color")!;
  const headspa = menus.find((m) => m.id === "headspa")!;

  test("料金の言葉を見分ける（予約だけの文では答えない）", () => {
    assert.ok(asksPrice("カットはいくらですか？"));
    assert.ok(asksPrice("縮毛矯正の料金を教えてください"));
    assert.ok(!asksPrice("明日の15時は空いてますか"));
    assert.equal(priceAnswer(menus, "明日の15時は空いてますか"), null);
  });

  test("設定にあるメニュー → その値段（設定から）。2つなら、いっしょの時の値段も", () => {
    assert.equal(priceAnswer(menus, "カットはいくらですか？")!.text, `カットは ${yen(cut.price)}です。`);
    const two = priceAnswer(menus, "カットとカラーだと、値段はいくらになりますか")!;
    assert.match(two.text, new RegExp(`カットは ${yen(cut.price)}、カラーは ${yen(color.price)}です。`));
    assert.match(two.text, new RegExp(`いっしょだとカット＋カラーで ${yen(cutColor.price)}です。`), "設定の組み合わせ");
    const sum = priceAnswer(menus, "カットとヘッドスパの料金は？")!;
    assert.match(sum.text, new RegExp(`いっしょだと ${yen(cut.price + headspa.price)}です。`), "設定に無い組み合わせは足した値段");
    assert.equal(priceAnswer(menus, "カット＋カラーの料金")!.text, `カット＋カラーは ${yen(cutColor.price)}です。`);
  });

  test("メニューを言わない → 設定のメニューを全部", () => {
    const all = priceAnswer(menus, "料金を教えてください")!;
    for (const m of menus) assert.ok(all.text.includes(`${m.name} ${yen(m.price)}`), m.name);
    assert.equal(all.askShop, false);
  });

  test("設定に無い物だけ「お店に確かめてご連絡します」（値段は作らない）", () => {
    const t = priceAnswer(menus, "トリートメントはいくらですか？")!;
    assert.equal(t.text, ASK_SHOP_REPLY);
    assert.equal(t.askShop, true);
    assert.match(t.step, /トリートメント/);
    const mix = priceAnswer(menus, "カットとトリートメントの料金は？")!;
    assert.equal(mix.text, `カットは ${yen(cut.price)}です。それ以外は、${ASK_SHOP_REPLY}`);
    assert.deepEqual(unknownItems(menusInText(menus, "カットの値段を教えて").rest), [], "料金の話でよく出る言葉は数えない");
    assert.doesNotMatch(t.text, /\d/, "設定に無い物の値段は書かない");
  });

  test("相談の流れ：料金だけなら AI は呼ばずにプログラムが返す（AI の手順にも1行）", async () => {
    const ctx = ctxAt(at("2026-11-09", "09:00"));
    const r = await chat(ctx, [{ role: "user", text: "ヘッドスパっておいくらですか？" }], neverModel);
    assert.equal(r.text, `ヘッドスパは ${yen(headspa.price)}です。`);
    assert.ok(r.steps.some((s) => s.kind === "price" && s.text.includes("店の設定")));
    assert.deepEqual(r.candidates, []);
    assert.ok(!r.events.some((e) => e.t === "todo"));
  });

  test("相談の流れ：設定に無い物は「お店に確かめてご連絡します」と ToDo（いつもと同じ所）", async () => {
    const ctx = ctxAt(at("2026-11-09", "09:00"));
    const r = await chat(ctx, [{ role: "user", text: "トリートメントの料金はいくらですか？" }], neverModel);
    assert.equal(r.text, ASK_SHOP_REPLY);
    const todo = r.events.find((e) => e.t === "todo");
    assert.ok(todo && todo.t === "todo" && todo.todo.title.includes("トリートメントの料金"));
  });

  test("予約の話もいっしょなら、料金を先に返してから AI が続ける（AI には値段を書かないと伝える）", async () => {
    const ctx = ctxAt(at("2026-11-09", "09:00"));
    assert.ok(alsoBooking("カットの値段と、明日の15時は空いてますか"));
    const seen: string[] = [];
    const base = scriptModel(ctx);
    const model: ReplyModel = {
      turn(req, onText) {
        seen.push(req.system);
        return base.turn(req, onText);
      },
    };
    const r = await chat(ctx, [{ role: "user", text: "カットの値段と、明日の15時は空いてますか" }], model);
    assert.ok(r.text.startsWith(`カットは ${yen(cut.price)}です。\n`));
    assert.ok(seen.length > 0, "AI（決まった返事）も呼ぶ");
    assert.match(seen[0], /料金はプログラムがもう答えた/);
  });

  test("候補を選ぶ言葉と料金をいっしょに言われたら、料金を返したあと仮押さえまで進む（レビューの指摘）", async () => {
    const ctx = ctxAt(at("2026-11-04", "10:00"));
    assert.ok(alsoBooking("1つ目でお願いします。カットの料金はいくらですか"));
    const first = await chat(ctx, [{ role: "user", text: "11/6の15時にカット" }]);
    assert.ok(first.candidates && first.candidates.length >= 1);
    const r = await chat({ ...ctx, shown: first.candidates! }, [
      { role: "user", text: "11/6の15時にカット" },
      { role: "assistant", text: first.text },
      { role: "user", text: "1つ目でお願いします。カットの料金はいくらですか" },
    ]);
    assert.ok(r.text.startsWith(`カットは ${yen(cut.price)}です。`));
    assert.equal(r.holds.length, 1, "仮押さえする");
  });

  test("AI への指示に「料金・値段は書かない」", () => {
    assert.match(reserveSystem(ctxAt(at("2026-11-09", "09:00")), []), /料金・値段は書かない/);
  });
});

describe("B7. 日本語の返事の「?」は全角の「？」", () => {
  test("fullWidthQuestion：半角の ? は全角に。英数字にはさまれた物はそのまま", () => {
    assert.equal(fullWidthQuestion("ご都合はいかがですか?"), "ご都合はいかがですか？");
    assert.equal(fullWidthQuestion("どちらにしますか?1つ目?"), "どちらにしますか？1つ目？");
    assert.equal(fullWidthQuestion("a?b"), "a?b");
  });

  test("AI の文も、プログラムの決まった文も、お客様に流す前にそろえる", async () => {
    const ctx = ctxAt(at("2026-11-09", "09:00"));
    const r = await chat(ctx, [{ role: "user", text: "こんにちは" }], sayModel("ご希望の日はありますか?"));
    assert.equal(r.text, "ご希望の日はありますか？");
    assert.doesNotMatch(r.text, /\?/);
  });
});

// ---------------------------------------------------------------- C. カルテ

const fixedWriter = (text: string): KarteWriter => ({ write: async () => ({ text, stop: "end" }) });
const run = (memo: string, writer: KarteWriter) =>
  runKarte({ memo, mode: "ai", writer, headings, rules: getRules(), maxTokens: getAiSettings().karte.maxReplyTokens });

describe("C8. 次の来店についての希望は、お客様のご希望と次回提案の両方に（メモの言葉のまま）", () => {
  const memo = "カラーです。根元が伸びてた。次は暗めのカラーをやりたいって言ってた。";

  test("お客様のご希望の見出しに役目の札（request）。次回提案は今のまま（next）", () => {
    assert.equal(headings.find((h) => h.role === "request")?.label, "お客様のご希望");
    assert.equal(headings.find((h) => h.role === "next")?.label, "次回提案");
  });

  test("メモから、次の来店の希望の文を読む（前の「えーと」と終わりの「って言ってた」だけ外す）", () => {
    assert.deepEqual(nextWishes(memo), ["次は暗めのカラーをやりたい"]);
    assert.deepEqual(nextWishes("えーと、次回はパーマにしたいとのこと。"), ["次回はパーマにしたい"]);
    assert.deepEqual(nextWishes("次は2か月後くらいに、前髪だけ切りに来るかもって。"), [], "希望ではない（予定）");
  });

  test("AI がご希望にだけ書いても、次回提案にも入れる", async () => {
    const d = await run(memo, fixedWriter("■ 来店時の状態\n・根元が伸びていた\n■ お客様のご希望\n・次は暗めのカラーをやりたい\n■ 次回提案"));
    assert.deepEqual(d.sections.request, ["次は暗めのカラーをやりたい"]);
    assert.deepEqual(d.sections.next, ["次は暗めのカラーをやりたい"]);
  });

  test("AI が次回提案に同じような行をもう書いていれば、重ねて足さない", async () => {
    const d = await run(memo, fixedWriter("■ お客様のご希望\n・次は暗めのカラーをやりたい\n■ 次回提案\n・暗めのカラー"));
    assert.deepEqual(d.sections.next, ["暗めのカラー"]);
  });

  test("決まった返事（AI なし）でも同じ", async () => {
    const d = await run(memo, scriptKarteWriter([], headings));
    // 決まった返事はメモの文をそのまま見出しに分ける（「って言ってた」も残る）。どちらの見出しにもメモの言葉で入る
    assert.ok(d.sections.request.some((l) => l.includes("次は暗めのカラーをやりたい")), d.sections.request.join("／"));
    assert.ok(d.sections.next.some((l) => l.includes("次は暗めのカラーをやりたい")), d.sections.next.join("／"));
    assert.equal(d.sections.next.filter((l) => l.includes("暗めのカラー")).length, 1, "重ねない");
  });
});

describe("C9. 同じ内容を2つの見出しや2行に重ねない", () => {
  test("同じ中身の見分け：形をそろえて同じ・短い方がそのまま入る（数がちがえば別）", () => {
    assert.ok(sameContent("大丈夫です", "大丈夫です。"));
    assert.ok(sameContent("頭皮が赤かった", "シャンプーの時、頭皮が赤かった"));
    assert.ok(!sameContent("全体を3センチ切った", "全体を5センチ切った"));
    assert.ok(!sameContent("前髪", "前髪だけのカット"), "短すぎる物は重なりと見ない");
    assert.ok(!sameContent("三センチ切った", "十三センチ切った"), "漢数字の数がちがえば別（レビューの指摘）");
    assert.ok(sameContent("三センチ切った", "全体を三センチ切った"));
    assert.equal(lineKey("「大丈夫」です。"), "大丈夫です");
  });

  test("「頭皮が赤かった」が来店時の状態と注意点の両方 → 注意点だけ（手がかりの言葉が当たる方）。「大丈夫です」の2行 → 1行", async () => {
    assert.ok(KARTE_GATE_WORDS.includes("大丈夫"), "メモにあるので門は通る");
    const memo = "カラーです。シャンプーの時に頭皮が赤かった。本人は大丈夫ですって言ってた。";
    const d = await run(
      memo,
      fixedWriter(
        "■ 来店時の状態\n・頭皮が赤かった\n■ 施術内容\n・カラー\n■ 注意点・申し送り\n・シャンプーの時に頭皮が赤かった\n・お客様の言葉：大丈夫です\n・大丈夫です。",
      ),
    );
    assert.deepEqual(d.sections.condition, [], "来店時の状態からは外す");
    assert.deepEqual(d.sections.notes, ["シャンプーの時に頭皮が赤かった", "お客様の言葉：大丈夫です"]);
  });

  test("手がかりの言葉が当たらなければ、先の見出しに残す。ちがう中身は消さない", () => {
    const s = tidySections(
      { condition: ["毛先がパサついていた"], request: [], treatment: ["全体を3センチ"], chemicals: [], finish: ["毛先がパサついていた"], next: [], notes: [], talk: ["全体を5センチ"] },
      "",
      headings,
    );
    assert.deepEqual(s.sections.condition, ["毛先がパサついていた"]);
    assert.deepEqual(s.sections.finish, []);
    assert.deepEqual(s.sections.treatment, ["全体を3センチ"]);
    assert.deepEqual(s.sections.talk, ["全体を5センチ"], "数がちがうので別の中身");
    assert.equal(s.merged.length, 1);
  });

  test("AI への指示にも「重ねて書かない」", async () => {
    const { karteSystem } = await import("../karte/prompt");
    assert.match(karteSystem(headings, getRules()), /同じことを2つの見出しや2行に重ねて書かない/);
  });
});

describe("C10. 録音からメモを作るの、モデルの大きさの表示", () => {
  test("WebGPU のモデル（large-v3-turbo）は約1,500MB（設定と仕様書）", () => {
    assert.equal(recordingJson.models.webgpu.approxMB, 1500);
    assert.match(read("docs/SPEC.md"), /whisper-large-v3-turbo（エンコーダ fp16・デコーダ q4。約1,500MB）/);
  });
});

// ---------------------------------------------------------------- D. 発信

const postsSettings = getPostsSettings();

describe("D11. 空き枠は本当に空いている時間だけ。お題に時期があれば、その時期の日から", () => {
  const today = calDay(shop, "2026-11-04");
  const r = (id: string, date: string, start: string, menuId: string, n: number): ChatReservation => ({
    id,
    customerId: `c0${(n % 9) + 1}`,
    menuId,
    date,
    start,
    status: "confirmed",
    heldAt: "2026-11-01T00:00:00.000Z",
    expiresAt: "2026-11-02T00:00:00.000Z",
  });
  // 11/5 は 13:00〜14:00 にカットが1件（同じ時間に受ける人数は1人なので、その時間は空きと言わない）
  const all = resolveChatReservations(menus, getCustomers(), [r("x1", "2026-11-05", "13:00", "cut", 0)]);

  test("予約の入った時間は空き枠に入れない（10:00〜20:00 と1日まるごとにしない）", () => {
    const f = postFacts(shop, postsSettings, today, { date: "2026-11-04", time: "19:45" }, all);
    assert.equal(f.openings[0], "11/5（木）10:00〜13:00・14:00〜20:00");
    assert.equal(f.openings[1], "11/6（金）10:00〜20:00", "だれの予約も無い日は1日");
  });

  test("時期の言葉を読む（設定の periods・N月・来週）。読めなければ null", () => {
    assert.deepEqual(periodOf("年末のご予約のお知らせ", "2026-11-04", postsSettings.periods), { label: "年末", from: "2026-12-20", to: "2026-12-31" });
    assert.deepEqual(periodOf("年末年始のお休み", "2026-11-04", postsSettings.periods), { label: "年末年始", from: "2026-12-25", to: "2027-01-07" });
    assert.deepEqual(periodOf("12月のヘッドスパ", "2026-11-04", postsSettings.periods), { label: "12月", from: "2026-12-01", to: "2026-12-31" });
    assert.deepEqual(periodOf("来週のお知らせ", "2026-11-04"), { label: "来週", from: "2026-11-09", to: "2026-11-15" });
    assert.equal(periodOf("冬のヘアケアのお知らせ", "2026-11-04", postsSettings.periods), null);
  });

  test("「年末」なら、空き枠とお休みを年末の日から出す", () => {
    const period = periodOf("年末のご予約", "2026-11-04", postsSettings.periods);
    const f = postFacts(shop, postsSettings, today, { date: "2026-11-04", time: "19:00" }, all, period);
    assert.equal(f.openings.length, postsSettings.maxOpeningDays);
    assert.match(f.openings[0], /^12\/20（日）/);
    for (const o of f.openings) assert.match(o, /^12\/2\d/);
    assert.deepEqual(f.closed, ["12月22日（火）", "12月29日（火）"], "その時期の定休日（お休みの形は月日）");
  });
});

/** 決まった文を順に返す物 */
function fixedPosts(texts: string[]): PostsModel & { calls: PostsModelRequest[] } {
  const calls: PostsModelRequest[] = [];
  return {
    calls,
    async turn(req): Promise<PostsTurn> {
      calls.push({ ...req, messages: [...req.messages] });
      return { text: texts[Math.min(calls.length - 1, texts.length - 1)], stop: "end" };
    },
  };
}

describe("D12. 長さを目安に近づける（配信は350字前後）", () => {
  const notice = postsSettings.kinds.find((k) => k.id === "notice")!;
  const ai = getPostsAiSettings();
  const input = (model: PostsModel) => ({
    kind: notice,
    materials: { topic: "冬のヘアケアのお知らせ" },
    memos: getPostMemos(),
    rules: getSeedRules(),
    shopName: shop.name,
    gateWords: postsSettings.gateWords,
    model,
    maxTokens: ai.maxReplyTokens,
    maxTries: ai.maxTries,
    lengthSlack: postsSettings.lengthSlack,
  });
  const long = "冬のお知らせです。".repeat(60); // 540字
  const short = "冬のお知らせです。".repeat(38); // 342字

  test("長さの上限は 目安 ×（1 + lengthSlack）。印は数えない。指示にも書く", () => {
    assert.equal(typeof postsSettings.lengthSlack, "number");
    const max = maxCharsOf(notice, postsSettings.lengthSlack)!;
    assert.equal(max, Math.round(notice.targetChars * (1 + postsSettings.lengthSlack!)));
    assert.equal(bodyChars(`あいう${OPENINGS_MARK}え お`), 5);
    assert.match(postsSystem(getSeedRules(), notice, shop.name, postsSettings.gateWords, undefined, max), new RegExp(`長くても${max}字まで`));
  });

  test("長すぎたら、1回だけ短く作り直してもらう", async () => {
    const m = fixedPosts([long, short]);
    const r = await runWrite(input(m));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.text, short);
    assert.equal(m.calls.length, 2);
    assert.match(m.calls[1].messages[2].content, /長すぎます/);
    assert.ok(r.steps.some((s) => s.text.includes("長すぎた")));
  });

  test("作り直しも長ければ、そのまま使う（長さだけでは「作れませんでした」にしない）。3回目は頼まない", async () => {
    const m = fixedPosts([long, long + "。", short]);
    const r = await runWrite(input(m));
    assert.ok(r.ok);
    assert.equal(m.calls.length, 2);
  });

  test("短くした作り直しが門に当たったら、前の（門を通った）下書きを使う", async () => {
    const m = fixedPosts([long, "今だけのお知らせです"]);
    const r = await runWrite(input(m));
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.text, long);
  });

  test("lengthSlack が無ければ長さは見ない（今のまま）", async () => {
    const m = fixedPosts([long]);
    const r = await runWrite({ ...input(m), lengthSlack: undefined });
    assert.ok(r.ok);
    assert.equal(m.calls.length, 1);
  });
});

describe("D13. 発信の数字の門で、漢数字も見る（「一度」「一緒」のような数ではない言葉は外す）", () => {
  const words = postsSettings.gateWords;
  test("漢数字の日時・数を当てる", () => {
    assert.deepEqual(numbersWritten("三日間だけのお知らせ"), ["三"]);
    assert.ok(numbersWritten("十二月にお待ちしています").includes("十二"));
    assert.equal(gatePost("冬休みは二十五日からです", words).ok, false);
  });

  test("数ではない言葉（一度・一緒・一番・十分に など）は数えない", () => {
    assert.deepEqual(numbersWritten("一度ためしてみてください。ご家族と一緒にどうぞ。一番人気です。十分に乾かしましょう。"), []);
    assert.ok(gatePost("ぜひ一度、ご一緒にどうぞ", words).ok);
  });

  test("お店のメモにも漢数字の数は無い（決まった返事が門に当たらない）", () => {
    for (const m of getPostMemos()) assert.deepEqual(numbersWritten(m.text), [], m.id);
  });
});

// ---------------------------------------------------------------- E. 架空の数どうしのずれ

describe("E14. 広告の4週の予約は、経理の来店に比べて多すぎない", () => {
  const ads = getAds();
  const sum = (rows: typeof ads.keywords, k: "clicks" | "cost" | "bookings") => rows.reduce((s, r) => s + r.weeks.reduce((a, w) => a + w[k], 0), 0);
  const visits = getAccounting().sales.days.reduce((s, d) => s + d.visits, 0);

  test("広告を出す言葉の4週の予約は10〜15件くらい（10月の来店の2割より少ない）", () => {
    const b = sum(ads.keywords, "bookings");
    assert.ok(b >= 10 && b <= 15, `予約 ${b}件`);
    assert.ok(b < visits * 0.2, `来店 ${visits}人に対して ${b}件`);
  });

  test("ほかの数も自然に：押された回数あたり予約は1〜5%・調べた言葉の予約は広告を出す言葉の内訳（より少ない）", () => {
    const clicks = sum(ads.keywords, "clicks");
    const b = sum(ads.keywords, "bookings");
    assert.ok(b / clicks >= 0.01 && b / clicks <= 0.05, `${b}/${clicks}`);
    assert.ok(sum(ads.searchTerms, "bookings") <= b);
    assert.ok(sum(ads.searchTerms, "clicks") <= clicks);
    for (const r of [...ads.keywords, ...ads.searchTerms]) for (const w of r.weeks) assert.ok(w.bookings <= w.clicks, `${r.no}番`);
  });
});

// ---------------------------------------------------------------- F. ToDo の期限

describe("F15. 投げたメモの「金曜までに」のような期限は、プログラムが期限にする", () => {
  // 2026-11-04 は水曜
  const today = "2026-11-04";
  test("曜日・明日・今週・日付・月末", () => {
    assert.equal(memoDue("金曜までにタオルを頼む", today), "2026-11-06");
    assert.equal(memoDue("水曜までに", today), today, "今日がその曜日なら今日");
    assert.equal(memoDue("月曜日までに電話", today), "2026-11-09", "次の月曜");
    assert.equal(memoDue("来週の金曜までに見積もり", today), "2026-11-13");
    assert.equal(memoDue("今日中に返事", today), today);
    assert.equal(memoDue("明日までに発注", today), "2026-11-05");
    assert.equal(memoDue("明後日までに", today), "2026-11-06");
    assert.equal(memoDue("今週中に片付け", today), "2026-11-08");
    assert.equal(memoDue("来週中に", today), "2026-11-15");
    assert.equal(memoDue("11/20までに振込", today), "2026-11-20");
    assert.equal(memoDue("１１月２０日までに", today), "2026-11-20", "全角も");
    assert.equal(memoDue("3/1までに", today), "2027-03-01", "過ぎた日付は来年");
    assert.equal(memoDue("3日までに", today), "2026-12-03", "過ぎた日は来月");
    assert.equal(memoDue("月末までに締める", today), "2026-11-30");
    // 長い言い方を短い言い方と読みちがえない（レビューの指摘）
    assert.equal(memoDue("再来週中に発注", today), "2026-11-22");
    assert.equal(memoDue("来月末までに発注", today), "2026-12-31");
    assert.equal(memoDue("来月中に", today), "2026-12-31");
    assert.equal(memoDue("来月10日までに", today), "2026-12-10");
  });

  test("読めない時・期限ではない言い方は今のまま（期限なし）", () => {
    assert.equal(memoDue("タオルの替えが少なくなってきた", today), null);
    assert.equal(memoDue("金曜に業者さんが来る", today), null, "「まで」が無い");
    assert.equal(memoDue("次の仕入れでまとめて頼む", today), null);
  });

  test("足した ToDo に期限が付き、「期限あり」に並ぶ（期限なしのメモは今のまま「投げたメモ」）", () => {
    const now = "2026-11-04T01:00:00.000Z";
    const a = withMemoTodo(emptyBook(today), [], { title: "タオルを頼む", memo: "金曜までにタオルを頼む", due: memoDue("金曜までにタオルを頼む", today) }, now, shop);
    assert.equal(a.todo?.due, "2026-11-06");
    const item = todoItems([], a.state, shop).find((t) => t.id === a.todo!.id)!;
    assert.equal(todoGroup(item, today), "week");
    const b = withMemoTodo(a.state, [], { title: "仕入れ", memo: "次の仕入れでまとめて頼む", due: memoDue("次の仕入れでまとめて頼む", today) }, now, shop);
    assert.equal(b.todo?.due, undefined);
    assert.equal(todoGroup(todoItems([], b.state, shop).find((t) => t.id === b.todo!.id)!, today), "memo");
  });

  test("画面（メモを投げる）と AI の仕事のメモは、どちらも memoDue を通して足す", () => {
    assert.match(read("src/components/MemoThrow.tsx"), /due: memoDue\(memo, todos\.today\)/);
    assert.match(read("src/lib/jobs/run.ts"), /due: memoDue\(memo, view\.clock\.today\.date\)/);
  });
});

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
