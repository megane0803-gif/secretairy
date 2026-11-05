// 発信の精度の直し（お休みの日付・漢字の数の言葉）のテスト。Claude は呼ばない。今日は 2026-11-05（木）。
//   1. オーナーが材料に書いたお休みの日付を先に使う（全部読み切れなければ「読み取れませんでした」・空き枠も入れない）
//   2. 店の設定のお休みは、続いている日を「〜」でまとめる（上限はまとまりの数）
//   3. 書いたお休みが台帳・店の設定とぶつかれば「確かめてください」
//   4. 発信の門だけの漢数字の見方（三が日・一同・今年一年は通す。三回・二万円・十二月は当てる）
//   5. 【お休み】の前後に「から」「まで」「のあいだ」を付けたら門に当てて作り直し

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { calDay } from "../../calendar";
import { getCustomers, getPostMemos } from "../../data/seed";
import { NOT_NUMBER_WORDS } from "../../karte/gate";
import { resolveChatReservations, type ChatReservation, type Reservation } from "../../reservations";
import { getSeedRules } from "../../rules/store";
import { getMenus, getPostsAiSettings, getPostsSettings, getShop, type PostKind, type ShopSettings } from "../../settings";
import { CLOSED_UNREADABLE, OPENINGS_SKIPPED, readOwnerClosed, type OwnerClosed } from "../closed";
import { CLOSED_FROM_LABEL, fillPost, periodOf, postFacts } from "../facts";
import {
  BLOG_LINK_MARK,
  CLOSED_EDGE_PROBLEM,
  CLOSED_MARK,
  gatePost,
  numbersWritten,
  OPENINGS_MARK,
  POST_NOT_NUMBER_WORDS,
  POST_ONLY_NOT_NUMBER_WORDS,
  postNumbersWritten,
} from "../gate";
import type { PostsModel, PostsModelRequest, PostsTurn } from "../model";
import { postsSystem } from "../prompt";
import { runWrite } from "../write";

const settings = getPostsSettings();
const shop = getShop();
const words = settings.gateWords;
const notice = settings.kinds.find((k) => k.id === "notice")!;
const TODAY = "2026-11-05";
const NEW_YEAR = "12月31日（木）〜1月5日（火）";

/** 材料（お題・伝えたいこと）から、画面と同じ順で日付を出す */
function factsFor(materials: Record<string, string>, opts: { shop?: ShopSettings; all?: Reservation[]; on?: string; more?: Partial<typeof settings> } = {}) {
  const s = opts.shop ?? shop;
  const on = opts.on ?? TODAY;
  const text = notice.materials.map((f) => materials[f.id] ?? "");
  const period = periodOf(text.join(" "), on, settings.periods);
  const owner = readOwnerClosed(text.join("\n"), on);
  return postFacts(s, { ...settings, ...opts.more }, calDay(s, on), { date: on, time: "09:00" }, opts.all ?? [], period, owner);
}
const fill = (raw: string, f: ReturnType<typeof factsFor>, kind: PostKind = notice) => fillPost(raw, kind, f);
const datesOf = (o: OwnerClosed) => (o.kind === "dates" ? o.dates : o.kind);

describe("1. 材料に書いたお休みの日付を先に使う", () => {
  test("「12月31日から1月5日まで休みます」（お題「年末年始のお休み」）→ 期間1つ。店の定休日（12/29）は入らない", () => {
    const f = factsFor({ topic: "年末年始のお休み", points: "12月31日から1月5日まで休みます" });
    assert.deepEqual(f.closed, [NEW_YEAR]);
    assert.equal(f.closedFrom, "materials");
    assert.equal(f.unreadable, false);
    const t = fill(`年末年始は${CLOSED_MARK}はお休みをいただきます。`, f).text;
    assert.ok(t.includes(NEW_YEAR), t);
    assert.doesNotMatch(t, /12\/29|12月29日|のあいだ/);
  });

  test("ほかの書き方も同じ形で読む", () => {
    const cases: [string, string[]][] = [
      ["12/31〜1/5はお休み", [NEW_YEAR]],
      ["12月31日〜1月5日はお休み", [NEW_YEAR]],
      ["１２／３１〜１／５はお休み", [NEW_YEAR]],
      ["1月1日から3日までお休み", ["1月1日（金）〜1月3日（日）"]],
      ["12月30日と1月4日はお休み", ["12月30日（水）", "1月4日（月）"]],
      ["12月30日、1月4日はお休み", ["12月30日（水）", "1月4日（月）"]],
      ["12/31〜1/5は休み、1/6から営業します", [NEW_YEAR]],
    ];
    for (const [points, closed] of cases) {
      const f = factsFor({ topic: "お休みのお知らせ", points });
      assert.deepEqual(f.closed, closed, points);
      assert.ok(fill(`${CLOSED_MARK}はお休みします。`, f).text.startsWith(closed.join("、")), points);
    }
    // 営業の節（1/6）はお休みに入らない
    assert.deepEqual(datesOf(readOwnerClosed("12/31〜1/5は休み、1/6から営業します", TODAY)).slice(-1), ["2027-01-05"]);
  });

  test("「休」の文に日付が無ければ今までどおり（時期の言葉の中の、店の設定のお休み）", () => {
    const f = factsFor({ topic: "年末年始のお休み", points: "ゆっくりしてほしい" });
    assert.equal(f.closedFrom, "shop");
    assert.deepEqual(f.closed, ["12月29日（火）", "1月5日（火）"], "火曜定休（12/25〜1/7 の中）");
    assert.deepEqual(readOwnerClosed("年中、休日も…", TODAY), { kind: "none" });
  });

  test("カードの ✓ と日誌の「どこから入れたか」は、材料からと店の設定からで分ける", () => {
    assert.equal(CLOSED_FROM_LABEL.materials, "お休みの日付（材料から）");
    assert.equal(CLOSED_FROM_LABEL.shop, "お休みの日付（店の設定から）");
  });
});

describe("2. 読み取れない時は推して入れない", () => {
  const bad = ["31日から5日まで休みます", "12/31〜1/3と1/6は休み", "休み明けの1月6日から営業します", "30日まで休まず営業します", "12/31〜1/5は休み（1/2を除く）"];
  for (const points of bad) {
    test(`「${points}」→（日付を読み取れませんでした）・定休日も空き枠も入らない`, () => {
      assert.deepEqual(readOwnerClosed(points, TODAY), { kind: "unreadable" });
      const f = factsFor({ topic: "年末年始のお休み", points });
      assert.equal(f.unreadable, true);
      assert.deepEqual(f.closed, [], "店の設定の定休日に戻さない");
      assert.deepEqual(f.openings, [], "空き枠も入れない");
      const t = fill(`空きは${OPENINGS_MARK}です。お休みは${CLOSED_MARK}です。`, f).text;
      assert.ok(t.includes(`お休みは${CLOSED_UNREADABLE}です`), t);
      assert.ok(t.includes(`空きは${OPENINGS_SKIPPED}です`), t);
      assert.doesNotMatch(t, /\d+\/\d+|月\d+日/);
      // 印が無い時に足す1行も同じ言葉
      const g = fill("お知らせです。", f).text;
      assert.ok(g.includes(`お休み：${CLOSED_UNREADABLE}`) && g.includes(`空きのある日時：${OPENINGS_SKIPPED}`), g);
    });
  }

  test("ほかにも：期間2つ・始まりだけ・終わりが前・長すぎる・日付のある「休」の文が2つ・漢数字の日付", () => {
    for (const s of [
      "12/24〜12/25と12/31〜1/3は休み",
      "12/31から休みます",
      "1/5までお休み",
      "12月1日から2月28日まで休みます",
      "12/31は休み。1/4も休み",
      "十二月三十一日から休みます",
      "2025年12月31日から1月5日まで休みます",
      "2月30日は休み",
    ])
      assert.deepEqual(readOwnerClosed(s, TODAY), { kind: "unreadable" }, s);
  });
});

describe("3. 年の決め方", () => {
  test("今日が 2026-12-31 でも「12月31日から1月5日まで」は 2026-12-31〜2027-01-05", () => {
    const d = datesOf(readOwnerClosed("12月31日から1月5日まで休みます", "2026-12-31"));
    assert.equal(d[0], "2026-12-31");
    assert.equal(d[d.length - 1], "2027-01-05");
    assert.equal(d.length, 6);
  });
  test("書いた年はそのまま（「2027年1月1日から3日まで」）。年が無い1日ずつは今日以降のいちばん近い日", () => {
    assert.deepEqual(datesOf(readOwnerClosed("2027年1月1日から3日まで休み", TODAY)), ["2027-01-01", "2027-01-02", "2027-01-03"]);
    assert.deepEqual(datesOf(readOwnerClosed("11月1日と11月20日は休み", TODAY)), ["2026-11-20", "2027-11-01"]);
    assert.deepEqual(datesOf(readOwnerClosed("1月1日から3日までお休み", TODAY)), ["2027-01-01", "2027-01-02", "2027-01-03"]);
  });
});

describe("4. 店の設定のお休みは、続いている日をまとめる（上限はまとまりの数）", () => {
  const holidays = { ...shop, closedDates: ["2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03", "2027-01-04"] };
  test("12/31〜1/4 の休みの日＋1/5 の火曜定休 → 1つ。離れた 12/29（火）は「、」", () => {
    const f = factsFor({ topic: "年末年始のお知らせ" }, { shop: holidays });
    assert.equal(f.closedFrom, "shop");
    assert.deepEqual(f.closed, ["12月29日（火）", NEW_YEAR]);
    assert.ok(fill(`${CLOSED_MARK}はお休みします。`, f).text.startsWith(`12月29日（火）、${NEW_YEAR}は`));
  });
  test("上限 maxClosedDays は日の数ではなく、まとまりの数", () => {
    assert.deepEqual(factsFor({ topic: "年末年始のお知らせ" }, { shop: holidays, more: { maxClosedDays: 2 } }).closed.length, 2, "7日あってもまとまりは2つ");
    assert.deepEqual(factsFor({ topic: "年末年始のお知らせ" }, { shop: holidays, more: { maxClosedDays: 1 } }).closed, ["12月29日（火）"]);
  });
});

describe("5. ぶつかった時は「確かめてください」（保存は止めない）", () => {
  const c = getCustomers();
  const r = (id: string, date: string, start: string, i: number): ChatReservation => ({
    id,
    customerId: c[i].id,
    menuId: "cut",
    date,
    start,
    status: i === 0 ? "confirmed" : "hold",
    heldAt: "2026-11-01T00:00:00.000Z",
    expiresAt: "2026-11-02T00:00:00.000Z",
  });
  const all = resolveChatReservations(getMenus(), c, [r("n1", "2026-12-31", "10:00", 0), r("n2", "2026-12-31", "14:00", 1)]);

  test("お休みと書いた日に台帳の予約がある・店の設定では営業日 → 1行ずつ（名前は出さない）", () => {
    const f = factsFor({ topic: "年末年始のお休み", points: "12月31日から1月5日まで休みます" }, { all });
    assert.deepEqual(f.cautions, ["12月31日（木）に予約が2件あります", "12月31日（木）〜1月4日（月）は、店の設定では営業日です（予約サイト・予約チャットでは受けてしまいます）"]);
    for (const x of c) assert.ok(!f.cautions.join("").includes(x.surname), "お客様の名前は出さない");
  });

  test("店の設定でもお休みなら、営業日の注意は出さない", () => {
    const holidays = { ...shop, closedDates: ["2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03", "2027-01-04"] };
    assert.deepEqual(factsFor({ points: "12月31日から1月5日まで休みます" }, { shop: holidays }).cautions, []);
  });

  test("空き枠に書いたお休みの日が出ない。表示の上限より多いお休みの日でも、全部の日を空き枠から外す", () => {
    const more = { maxOpeningDays: 99, maxClosedDays: 1 };
    const f = factsFor({ topic: "年末年始のお休み", points: "12月31日から1月5日まで休みます" }, { more });
    assert.ok(f.openings.length > 0);
    for (const o of f.openings) assert.doesNotMatch(o, /^(12\/31|1\/[1-5])（/, o);
    assert.ok(f.openings.some((o) => o.startsWith("1/6（")), "お休みの次の営業日は出る");
    const g = factsFor({ topic: "年末年始のお休み", points: "12月26日、12月30日、1月4日はお休み" }, { more });
    assert.deepEqual(g.closed, ["12月26日（土）"], "表示はまとまり1つまで");
    for (const o of g.openings) assert.doesNotMatch(o, /^(12\/26|12\/30|1\/4)（/, o);
  });
});

describe("6. 発信だけの漢字の数の見方（postNumbersWritten）", () => {
  test("決まった言い方は通す", () => {
    for (const t of ["三が日はお休みします", "スタッフ一同", "今年一年ありがとうございました", "一人ひとりに", "十分に乾かす", "七五三"]) {
      assert.deepEqual(postNumbersWritten(t), [], t);
      assert.ok(gatePost(t, words).ok, t);
    }
  });
  test("数を数える言い方・2字以上の漢数字の並びは当てる", () => {
    for (const t of ["三回", "二万円", "十二月", "五日", "二十", "三日間だけ", "三つ", "二ヶ月", "三パーセント", "三 回", "二〇二六"]) {
      assert.ok(postNumbersWritten(t).length > 0, t);
      assert.equal(gatePost(t, words).ok, false, t);
    }
    assert.deepEqual(postNumbersWritten("三 回"), ["三 回"]);
  });
  test("算用数字（全角も）・曜日も当てる。決まった印だけ外し、ほかの【…】は中の数字も当てる", () => {
    assert.deepEqual(postNumbersWritten("12月にお待ちしています"), ["12"]);
    assert.deepEqual(postNumbersWritten("１２月"), ["12"]);
    assert.deepEqual(postNumbersWritten("毎週火曜はお休み"), ["火曜"]);
    assert.deepEqual(postNumbersWritten("【1月6日から営業再開】"), ["1", "6"]);
    assert.equal(gatePost("【1月6日から営業再開】します", words).ok, false);
    assert.deepEqual(postNumbersWritten(`${OPENINGS_MARK}${CLOSED_MARK}${BLOG_LINK_MARK}【ブログのリンク】`), []);
  });
});

describe("7. ほかのタブは変わらない", () => {
  test("numbersWritten は今までどおり漢数字を全部当てる", () => {
    assert.deepEqual(numbersWritten("スタッフ一同"), ["一"]);
    assert.deepEqual(numbersWritten("今年一年"), ["一"]);
    assert.deepEqual(numbersWritten("三が日"), ["三"]);
  });
  test("POST_NOT_NUMBER_WORDS の中身は変わらない（発信の足しは別の表）", () => {
    assert.deepEqual(POST_NOT_NUMBER_WORDS, [
      ...NOT_NUMBER_WORDS,
      "一度", "一番", "一息", "一言", "一歩", "一休み", "一人ひとり", "一人一人", "お一人", "一つひとつ", "一つ一つ", "一部", "一面", "一新",
      "一層", "一段と", "一時的", "一生懸命", "一石二鳥", "一期一会", "十人十色", "千差万別", "万全", "万が一", "十分に", "十分な", "十分です",
      "七五三", "三日坊主", "百貨店",
      "一方", "一手", "一致", "一定", "一体", "一切", "一見", "一律", "一環", "一帯", "一向",
    ]);
    for (const w of POST_ONLY_NOT_NUMBER_WORDS) assert.ok(!POST_NOT_NUMBER_WORDS.includes(w), w);
  });
});

describe("8. 【お休み】の前後に期間の言葉を付けない", () => {
  test("門に当てる（すぐ後ろの から・まで・の間・のあいだ・の期間、すぐ前の から）。「【お休み】は」は通す", () => {
    for (const t of [`${CLOSED_MARK}のあいだお休みします`, `${CLOSED_MARK}までお休みします`, `から${CLOSED_MARK}`, `${CLOSED_MARK}の間`, `${CLOSED_MARK}の期間`, `${CLOSED_MARK}から`]) {
      const g = gatePost(t, words);
      assert.equal(g.ok, false, t);
      assert.ok(g.problems.includes(CLOSED_EDGE_PROBLEM), t);
      assert.equal(g.checks.find((c) => c.id === "closedEdges")?.ok, false);
    }
    assert.ok(gatePost(`${CLOSED_MARK}はお休みをいただきます`, words).ok);
    assert.equal(CLOSED_EDGE_PROBLEM, "【お休み】の前後に『から』『まで』『のあいだ』を付けないでください（期間はお店のほうで入れます）");
  });

  test("当たったら理由を渡して1回だけ作り直す", async () => {
    const calls: PostsModelRequest[] = [];
    const texts = [`年末年始は${CLOSED_MARK}のあいだお休みします。`, `年末年始は${CLOSED_MARK}はお休みをいただきます。`];
    const model: PostsModel = {
      async turn(req): Promise<PostsTurn> {
        calls.push({ ...req, messages: [...req.messages] });
        return { text: texts[calls.length - 1], stop: "end" };
      },
    };
    const ai = getPostsAiSettings();
    const res = await runWrite({ kind: notice, materials: { topic: "年末年始のお休み" }, memos: getPostMemos(), rules: getSeedRules(), shopName: shop.name, gateWords: words, model, maxTokens: ai.maxReplyTokens, maxTries: ai.maxTries });
    assert.ok(res.ok);
    assert.equal(res.tries, 2);
    assert.ok(String(calls[1].messages[calls[1].messages.length - 1].content).includes(CLOSED_EDGE_PROBLEM));
  });

  test("指示文にも書く（期間がまるごと入る・漢字の決まった言い方はよい・数を数える言い方は書かない・印は決まった物だけ）", () => {
    const system = postsSystem(getSeedRules(), notice, shop.name, words);
    assert.match(system, /算用数字（全角も）・日付・時刻・曜日・値段・回数は書かない/);
    assert.match(system, /三が日・一同・今年一年・一人ひとり/);
    assert.match(system, /三回・二万円・十二月・五日/);
    assert.match(system, /【お休み】には期間がまるごと入る。印の前後に「から」「まで」「のあいだ」を付けない/);
    assert.match(system, /【…】は決まった印/);
  });
});
