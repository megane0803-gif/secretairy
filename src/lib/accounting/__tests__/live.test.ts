// 経理の一覧：freee（テスト事業所）から読んだ明細と、アプリの中の架空の明細（カード・銀行）。Claude も freee も呼ばない。
// 確かめること：
// - 摘要に購入先の名前がちょうど1つ含まれる時だけ、その購入先のルールを使う（0件・2件以上は人が選ぶ）。ルールの形（merchantId）は変えない
// - 選んだ店用・私用と登録の状態は、freee の明細では freee の明細の番号（"t<id>"）で持ち、架空の明細の番号（item.no）と混ぜない
// - つないでいない時の一覧に、銀行の明細も出る（入金は見せるだけ）
// - 読めなかった時・鍵が切れた時に、架空の明細へ切り替えない
// - 読む期間：今日の90日前から、架空の明細の最後の日と今日の遅い方まで

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CardStatement } from "../../../app/accounting/CardStatement";
import { ACCOUNTING_KEY, FREEE_KEY } from "../../browser";
import { getAccounting } from "../../data/seed";
import { EMPTY_FREEE, withItem, withRunStart } from "../../freee/state";
import { BUSY_REASON } from "../../freee/run";
import { freeeMode, listErrorText, needsReconnect } from "../../freee/useFreee";
import { resetAllWrites } from "../../reset";
import { getAccountingSettings, getFreeeSettings } from "../../settings";
import { freeeRows, isSeedKey, isTxnKey, listRange, merchantOfText, seedRows, txnKey, withoutMarks, type ListedTxn } from "../rows";
import { manualItems } from "../sort";
import {
  EMPTY_ACCOUNTING,
  gateOf,
  liveUsesOf,
  parseAccounting,
  register,
  sortCurrent,
  withChoice,
  withLiveAutoNext,
  withLiveChoice,
  withRulesFromLive,
} from "../state";
import { phaseOf } from "../useStatement";
import { liveView, seedView } from "../view";

const seed = getAccounting();
const settings = getAccountingSettings();
const freee = getFreeeSettings();
const id = (name: string) => seed.merchants.find((m) => m.name === name)!.id;
const A = id("美容材料の通販A"); // ルール：店用
const D = id("服の通販D"); // ルール：私用
const MALL = id("通販モールE"); // ルール無し・前にも仕分けた
const txn = (p: Partial<ListedTxn> & { id: number }): ListedTxn => ({ account: "card", date: "2026-11-02", side: "expense", description: "", amount: 1000, ...p });

describe("摘要の文字で購入先を決める（ちょうど1つの時だけ）", () => {
  test("購入先の名前がちょうど1つ含まれる時だけ、その購入先。0件・2件以上は決めない", () => {
    assert.equal(merchantOfText("美容材料の通販A SecretAIry:v1:1", seed.merchants), A);
    assert.equal(merchantOfText("ご利用 美容材料の通販A 店頭", seed.merchants), A, "前後に文字があってもよい");
    assert.equal(merchantOfText("コンビニ", seed.merchants), null, "0件");
    assert.equal(merchantOfText("美容材料の通販A と 服の通販D", seed.merchants), null, "2件以上");
    assert.equal(merchantOfText("美容材料の通", seed.merchants), null, "名前の一部だけでは決めない");
  });

  test("freee の明細：名前が1つならその購入先のルール（merchantId）で自動、0件・2件以上なら人が選ぶ。ルールの形は変えない", () => {
    const rows = freeeRows(
      [
        txn({ id: 101, description: "美容材料の通販A SecretAIry:v1:1" }),
        txn({ id: 102, description: "服の通販D" }),
        txn({ id: 103, description: "コンビニ" }),
        txn({ id: 104, description: "美容材料の通販A 服の通販D" }),
        txn({ id: 105, description: "通販モールE" }),
      ],
      seed.merchants,
      freee.markPrefix,
    );
    const v = liveView(seed, EMPTY_ACCOUNTING, EMPTY_FREEE, rows.map((r) => ({ id: r.txnId!, account: r.account, date: r.date, side: r.side, description: r.text, amount: r.amount })), freee.markPrefix);
    const auto = Object.fromEntries(v.sorted.auto.map((a) => [a.item.key, a.use]));
    assert.deepEqual(auto, { t101: "shop", t102: "private" });
    assert.deepEqual(v.sorted.fresh.map((r) => r.key).sort(), ["t103", "t104"], "決まらない行は人が選ぶ（初めての購入先の側）");
    assert.deepEqual(v.sorted.known.map((r) => r.key), ["t105"]);
    assert.equal(v.sorted.fresh.every((r) => r.merchantId === null), true);
    assert.deepEqual(Object.keys(seed.rules[0]).sort(), ["merchantId", "use"], "ルールは購入先の番号で持つまま");
    // 画面に出す摘要からは印を外す
    assert.equal(rows[0].text, "美容材料の通販A");
    assert.equal(withoutMarks("SecretAIry:v1:3", freee.markPrefix), "（摘要なし）");
  });

  test("登録で足した自動のルールも、freee の明細ではすぐ効く（購入先の番号で）", () => {
    let s = withLiveChoice(EMPTY_ACCOUNTING, "t201", "shop");
    s = withLiveChoice(s, "t202", "shop");
    s = withLiveAutoNext(s, MALL, true);
    const done = [
      { merchantId: MALL, use: "shop" as const },
      { merchantId: MALL, use: "shop" as const },
    ];
    const r = withRulesFromLive(seed, s, done, "2026-11-05T00:00:00.000Z");
    assert.deepEqual(r.added, [{ merchantId: MALL, use: "shop" }]);
    const v = liveView(seed, r.state, EMPTY_FREEE, [txn({ id: 203, description: "通販モールE" })], freee.markPrefix);
    assert.deepEqual(v.sorted.auto.map((a) => [a.item.key, a.use]), [["t203", "shop"]]);
    // 印が分かれていたら足さない
    assert.deepEqual(withRulesFromLive(seed, s, [done[0], { merchantId: MALL, use: "private" }], "x").added, []);
  });
});

describe("鍵を混ぜない：freee の明細は wallet_txn の id（t<id>）・架空の明細は item.no", () => {
  test("鍵の形", () => {
    assert.equal(txnKey(12), "t12");
    assert.ok(isTxnKey("t12") && !isTxnKey("12") && !isTxnKey("t") && !isTxnKey("t0"));
    assert.ok(isSeedKey("12") && !isSeedKey("t12"));
    assert.ok(seedRows(seed).every((r) => isSeedKey(r.key) && r.key === String(r.no) && r.txnId === null));
  });

  test("freee の明細の番号が架空の明細の番号と同じ数でも、選びは混ざらない", () => {
    // 架空の明細の人が選ぶ1行目（番号 n）と、freee の明細の番号 n
    const first = manualItems(sortCurrent(seed))[0];
    let s = withChoice(seed, EMPTY_ACCOUNTING, first.no, "private");
    const v0 = liveView(seed, s, EMPTY_FREEE, [txn({ id: first.no, description: "コンビニ" })], freee.markPrefix);
    assert.equal(v0.choices[txnKey(first.no)], undefined, "架空の明細の選びは freee の明細に効かない");
    s = withLiveChoice(s, txnKey(first.no), "shop");
    assert.equal(s.choices[String(first.no)], "private", "freee の明細の選びは架空の明細に効かない");
    assert.equal(s.live.choices[txnKey(first.no)], "shop");
    assert.equal(seedView(seed, s).choices[String(first.no)], "private");
    // 数だけの鍵は freee の側に入れない
    assert.equal(withLiveChoice(s, String(first.no), "shop"), s);
    // ブラウザに残す形：live は t<id> だけ読む
    const back = parseAccounting(JSON.stringify({ ...s, live: { choices: { t5: "shop", "5": "private", tx: "shop" }, autoNext: ["m-e"] } }));
    assert.deepEqual(back.live.choices, { t5: "shop" });
    assert.deepEqual(back.choices, s.choices);
    // 架空の明細の登録は、freee の選びを見ない
    const reg = register(seed, s, { nowIso: "2026-11-05T00:00:00.000Z", service: settings.service });
    assert.equal(reg.ok, false, "架空の明細はまだ選び終わっていない");
  });

  test("登録の状態も freee の明細の番号で持つ。送り始めたら、その明細の選びだけ固定する（新しく読んだ明細は選べる）", () => {
    const list = [txn({ id: 301, description: "コンビニ" }), txn({ id: 302, description: "コンビニ" })];
    const s = withLiveChoice(withLiveChoice(EMPTY_ACCOUNTING, "t301", "private"), "t302", "shop");
    let rec = withRunStart(EMPTY_FREEE, { t301: "private" }, "2026-11-05T00:00:00.000Z");
    rec = withItem(rec, "t301", { state: "registered", dealIds: [9] }, "2026-11-05T00:00:01.000Z");
    const v = liveView(seed, withLiveChoice(s, "t301", "shop"), rec, list, freee.markPrefix);
    assert.equal(v.choices.t301, "private", "固定した選び");
    assert.deepEqual(v.targets.map((t) => t.key), ["t302"], "登録した明細は送らない");
    assert.equal(v.gate.remaining, 0);
    assert.deepEqual(liveUsesOf(v.sorted, s), { t301: "private", t302: "shop" });
  });

  test("「最初に戻す」で消える範囲は今と同じ（経理の記録はまるごと消え、freee の記録は「結果が分からない」と待つ期限だけ残る）", () => {
    const rec = withItem(withRunStart(EMPTY_FREEE, { t9: "shop" }, "x"), "t9", { state: "unknown" }, "2026-11-05T00:00:00.000Z");
    const w = resetAllWrites("2026-11-05", null, JSON.stringify({ ...rec, linked: true }), Date.parse("2026-11-05T01:00:00.000Z"));
    assert.equal(w.find((x) => x.key === ACCOUNTING_KEY)!.value, null);
    const kept = JSON.parse(w.find((x) => x.key === FREEE_KEY)!.value!);
    assert.deepEqual(Object.keys(kept.items), ["t9"]);
    assert.equal(kept.uses, null);
  });
});

describe("つないでいない時（審査員の画面も）：アプリの中のカードと銀行の明細", () => {
  test("一覧にカード20件と銀行8件。入金は見せるだけ（仕分けにも門にも登録にも入れない）", () => {
    const v = seedView(seed, EMPTY_ACCOUNTING);
    assert.equal(v.rows.filter((r) => r.account === "card").length, 20);
    assert.equal(v.rows.filter((r) => r.account === "bank").length, 8);
    assert.equal(v.incomes.length, 4);
    assert.ok(v.incomes.every((r) => r.account === "bank"));
    const sortedKeys = [...v.sorted.auto.map((a) => a.item.key), ...manualItems(v.sorted).map((r) => r.key)];
    assert.ok(v.incomes.every((r) => !sortedKeys.includes(r.key)));
    assert.equal(gateOf(seed, EMPTY_ACCOUNTING).remaining, manualItems(v.sorted).length);
    assert.ok(manualItems(v.sorted).some((r) => r.account === "bank"), "銀行の出金も人が選ぶ");
  });

  test("画面（つないでいない描画）：銀行の明細・入金の1行・つないでいない時の説明が出る。freee から読んだ説明は出さない", () => {
    const html = renderToStaticMarkup(createElement(CardStatement));
    assert.ok(html.includes("カードと銀行の明細"));
    assert.ok(html.includes(settings.statementNote));
    assert.ok(!html.includes(freee.statementNote));
    assert.ok(html.includes(settings.incomeNote));
    for (const i of seed.statement.items.filter((x) => x.account === "bank")) {
      const name = seed.merchants.find((m) => m.id === i.merchantId)!.name;
      assert.ok(html.includes(name), name);
    }
    assert.ok(html.includes(">銀行<"));
    assert.ok(html.includes("入金（見るだけ）"));
  });

  test("文の形：つないでいない時・つないでいる時・入金の1行（設定に置く）", () => {
    assert.equal(settings.statementNote, "アプリの中に入っている見本のカードと銀行の明細です。freee とつなぐと、freee のまだ処理していない明細を読んで出します");
    assert.equal(freee.statementNote, "freee（テスト事業所）から読んだ、まだ処理していない明細（カード・銀行）");
    assert.equal(freee.incomeNote, "売上の入金は、freee のルールで売上にしています。ここからは送りません");
    assert.equal(freee.bankName, "SecretAIry 口座");
  });
});

describe("読めなかった時・鍵が切れた時は、架空の明細に切り替えない", () => {
  test("freee の側を決める：つながっている・つながった印・送り始めた記録。本番以外（off）は架空の明細", () => {
    assert.equal(freeeMode("none", EMPTY_FREEE), false, "cookie が無い画面（審査員）");
    assert.equal(freeeMode("loading", EMPTY_FREEE), false, "聞いている間も、印が無ければ架空の明細のまま（ちらつかない）");
    assert.equal(freeeMode("connected", EMPTY_FREEE), true);
    assert.equal(freeeMode("expired", { ...EMPTY_FREEE, linked: true }), true, "鍵が切れても freee の側のまま");
    assert.equal(freeeMode("none", { ...EMPTY_FREEE, linked: true }), true, "cookie が消えた後も");
    assert.equal(freeeMode("none", withRunStart(EMPTY_FREEE, { t1: "shop" }, "x")), true, "送り始めた記録がある");
    assert.equal(freeeMode("off", { ...EMPTY_FREEE, linked: true }), false);
  });

  test("一覧の段：読めなかった時は理由（架空の明細の行は出さない）・読んでいる間は「読んでいます」", () => {
    assert.deepEqual(phaseOf(false, "none", { phase: "idle" }), { phase: "seed" });
    assert.deepEqual(phaseOf(true, "connected", { phase: "error", reason: "freee の鍵が切れました", reconnect: true }), { phase: "error", reason: "freee の鍵が切れました", reconnect: true });
    assert.equal(phaseOf(true, "expired", { phase: "idle" }).phase, "error");
    assert.equal(phaseOf(true, "none", { phase: "idle" }).phase, "error");
    assert.equal(phaseOf(true, "connected", { phase: "loading" }).phase, "loading");
    assert.equal(phaseOf(true, "loading", { phase: "idle" }).phase, "loading");
    assert.equal(
      listErrorText("freee の鍵が切れました。もう一度 freee とつないでください", true),
      "freee から読めませんでした（freee の鍵が切れました）。もう一度 freee とつないでください",
      "同じ文を2回出さない",
    );
    // つなぎ直しを言うのは、鍵が切れた・読めなかった時。カードの口座が無い・ほかのタブでやりとりしている時は言わない
    assert.equal(needsReconnect("freee の鍵が切れました。もう一度 freee とつないでください", freee.cardName), true);
    assert.equal(needsReconnect("freee から返事がありません（freee には何も書いていません）", freee.cardName), true);
    assert.equal(needsReconnect(`「${freee.cardName}」という名前の口座がありません`, freee.cardName), false);
    assert.equal(needsReconnect(BUSY_REASON, freee.cardName), false);
    // freee の側では、読めた一覧が空でも架空の明細は入れない
    const v = liveView(seed, EMPTY_ACCOUNTING, EMPTY_FREEE, [], freee.markPrefix);
    assert.equal(v.rows.length, 0);
    assert.equal(v.mode, "freee");
  });
});

describe("読む期間", () => {
  test("今日の90日前から、架空の明細の最後の日と今日の遅い方まで", () => {
    assert.equal(freee.listDays, 90);
    assert.deepEqual(listRange("2026-11-07", seed.statement.to, 90), { from: "2026-08-09", to: "2026-11-10" });
    assert.deepEqual(listRange("2026-11-10", seed.statement.to, 90), { from: "2026-08-12", to: "2026-11-10" });
    assert.deepEqual(listRange("2027-01-05", seed.statement.to, 90), { from: "2026-10-07", to: "2027-01-05" });
    assert.ok(seed.statement.items.every((i) => i.date <= seed.statement.to), "架空の明細（銀行の8件も）は期間の中");
  });
});
