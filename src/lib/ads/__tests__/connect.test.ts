// 本物の検索広告へ渡す形（docs/SPEC.md §1.7.6）と、本物の広告の中で動かす見本のスクリプト（§1.7.7）。
// 本物の広告は呼ばない。見本のスクリプトは、作り物の広告の部品と外の窓口の部品を差し込んで動かす。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { emptyBook } from "../../book/state";
import { getAds } from "../../data/seed";
import { getAdSettings, getMenus, getShop } from "../../settings";
import { readSyncResult, realMarkedNos, RESULT_FORMAT, sampleResult, SYNC_FORMAT, syncItems, syncPayload, withSynced } from "../connect";
import { featuredWords } from "../featured";
import { approveRevert } from "../verdict";
import { approveAd, approveAdd, EMPTY_ADS, parseAds, tableOf, withAddSkipped, withReview, type AdsState } from "../state";
import { buildTable, ZERO } from "../report";

const settings = getAdSettings();
const shop = getShop();
const report = getAds();
const words = featuredWords(settings, getMenus());
const table = buildTable(report, settings);
const c = settings.connect;
const NOW = "2026-11-07T01:00:00.000Z";
const LATER = "2026-11-07T02:00:00.000Z";
const TODAY = "2026-11-07";

/** 止める（2番）・外す（10番）・足す（11番・14番）が承認待ちの状態を作り、決める */
function world(): { s: AdsState; ids: { stop: string; exclude: string; add11: string; add14: string } } {
  let s = withReview(
    EMPTY_ADS,
    {
      proposal: { id: "ad-1", action: "exclude", no: 10, text: "美容院 安い 学生", reason: "予約につながっていません。", checks: [] },
      adds: [
        { id: "ad-1-add1", no: 11, reason: "売りの言葉です。", checks: [] },
        { id: "ad-1-add2", no: 14, reason: "売りの言葉です。", checks: [] },
      ],
    },
    table,
    { nowIso: NOW, mode: "script" },
    settings,
  );
  s = approveAd(s, emptyBook(TODAY), "ad-1", { nowIso: NOW, today: TODAY, shop, settings }).ads;
  s = approveAdd(s, "ad-1-add1", { nowIso: NOW, table: tableOf(report, settings, s), words, settings }).ads;
  // 止める案（別の週の見直し。承認済み）
  s = {
    ...s,
    proposals: [
      ...s.proposals,
      { id: "ad-2", action: "stop", no: 3, text: "美容院 安い", reason: "予約につながっていません。", total: { clicks: 0, cost: 0, bookings: 0 }, checks: [], createdAt: LATER, state: "approved", decidedAt: LATER, fixed: false, mode: "ai" },
    ],
    applied: [...s.applied, { no: 3, action: "stop", at: LATER, proposalId: "ad-2" }],
  };
  return { s, ids: { stop: "ad-2", exclude: "ad-1", add11: "ad-1-add1", add14: "ad-1-add2" } };
}

describe("渡す中身", () => {
  test("承認済みで未反映の物だけ（承認待ちの足す案は入れない）・種類と合い方（足す＝フレーズ一致・外す＝完全一致）", () => {
    const { s } = world();
    const { payload } = syncPayload(s, words, c, NOW);
    assert.equal(payload.format, SYNC_FORMAT);
    assert.equal(payload.version, 1);
    assert.equal(payload.createdAt, NOW);
    assert.equal(payload.campaign, c.campaign);
    assert.equal(payload.adGroup, c.adGroup);
    assert.deepEqual(
      payload.items.map((i) => [i.id, i.kind, i.text, i.match ?? null]),
      [
        ["ad-1", "exclude", "美容院 安い 学生", "exact"],
        ["ad-1-add1", "add", "縮毛矯正 くせ毛 ひどい", "phrase"],
        ["ad-2", "stop", "美容院 安い", null],
      ],
    );
    assert.ok(payload.items.every((i) => i.approvedAt));
  });

  test("見送った・反映済み・戻した案は入れない", () => {
    const { s: s0 } = world();
    let s = withAddSkipped(s0, "ad-1-add2", NOW);
    s = withSynced(s, [{ id: "ad-1", kind: "exclude" }], LATER);
    // 止めた言葉を戻した（効いたかの判定の戻す案を承認した）つもり
    s = { ...s, judgements: [{ id: "j1", proposalId: "ad-2", no: 3, text: "美容院 安い", action: "stop", approvedAt: LATER, due: TODAY, judgedAt: NOW, demo: false, mode: "ai", weeks: 3, before: ZERO, after: ZERO, word: ZERO, verdict: "revert", why: "予約が減りました。", revert: { state: "pending" } }] };
    s = approveRevert(s, "j1", NOW, settings.channel).ads;
    assert.deepEqual(syncItems(s, words).items.map((i) => i.id), ["ad-1-add1"]);
  });

  test("足す案は書き出す時にも売りの言葉をもう一度確かめる", () => {
    const { s } = world();
    const r = syncItems(s, ["パーマ"]);
    assert.ok(!r.items.some((i) => i.kind === "add"));
    assert.match(r.notes.join(), /売りの言葉が入っていない/);
  });

  test("鍵・合言葉・本物の広告の番号は入らない（決まった欄だけ）", () => {
    const { s } = world();
    const { payload } = syncPayload(s, words, c, NOW);
    assert.deepEqual(Object.keys(payload).sort(), ["adGroup", "campaign", "createdAt", "format", "items", "version"]);
    for (const i of payload.items) for (const k of Object.keys(i)) assert.ok(["id", "kind", "text", "match", "approvedAt"].includes(k), k);
    const json = JSON.stringify(payload);
    // 「secretairy-ads-sync」の形の名前のほかに、鍵・合言葉・本物の広告の番号（123-456-7890 の形）が無い
    assert.doesNotMatch(json.replaceAll(SYNC_FORMAT, ""), /token|secret|pass|apikey|api_key|customerId|\d{3}-\d{3}-\d{4}/i);
    const cfg = readFileSync("config/ads.json", "utf8");
    assert.doesNotMatch(cfg, /\d{3}-\d{3}-\d{4}|token|secret|passcode/i, "設定にも本物の番号・鍵を入れない");
  });

  test("数の上限（maxItems）をこえた分は次に回す", () => {
    const { s } = world();
    const r = syncPayload(s, words, { ...c, maxItems: 1 }, NOW);
    assert.equal(r.payload.items.length, 1);
    assert.match(r.notes.join(), /残り2件/);
  });
});

describe("結果の読み込み", () => {
  const resultOf = (rows: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ format: RESULT_FORMAT, version: 1, campaign: c.campaign, results: rows, ...extra });

  test("反映した物だけ印・できなかった物は理由を知らせて印なし", () => {
    const { s } = world();
    const r = readSyncResult(
      resultOf([
        { id: "ad-1", kind: "exclude", text: "美容院 安い 学生", status: "done" },
        { id: "ad-1-add1", kind: "add", text: "縮毛矯正 くせ毛 ひどい", status: "failed", reason: "広告グループが2つあります" },
      ]),
      s,
      words,
      c,
    );
    assert.ok(r.ok);
    assert.deepEqual(r.marks, [{ id: "ad-1", kind: "exclude" }]);
    assert.match(r.notes.join(), /反映できませんでした（広告グループが2つあります）/);
    const next = withSynced(s, r.marks, LATER);
    assert.equal(next.proposals.find((p) => p.id === "ad-1")?.realAt, LATER);
    assert.equal(next.adds?.find((p) => p.id === "ad-1-add1")?.realAt, undefined);
    assert.deepEqual([...realMarkedNos(next)], [10]);
    // 印も読み直して落ちない
    assert.deepEqual(parseAds(JSON.stringify(next)), next);
  });

  test("番号違い（承認待ち）・種類違い・言葉違い・知らない番号は印なしで知らせ", () => {
    const { s } = world();
    const r = readSyncResult(
      resultOf([
        { id: "ad-1-add2", kind: "add", text: "ヘッドスパ 眠れる", status: "done" },
        { id: "ad-1", kind: "stop", text: "美容院 安い 学生", status: "done" },
        { id: "ad-2", kind: "stop", text: "美容院", status: "done" },
        { id: "ad-999", kind: "stop", text: "美容院 安い", status: "done" },
      ]),
      s,
      words,
      c,
    );
    assert.ok(r.ok);
    assert.deepEqual(r.marks, []);
    assert.equal(r.notes.length, 4);
    assert.match(r.notes[0], /番号が合いません/);
    assert.match(r.notes[1], /種類や言葉が渡した中身と違う/);
    assert.match(r.notes[2], /種類や言葉が渡した中身と違う/);
    assert.match(r.notes[3], /知らない番号/);
  });

  test("形の違う文字・大きすぎる文字は何も変えずに1行", () => {
    const { s } = world();
    for (const raw of [
      "",
      "これは JSON ではない",
      JSON.stringify({ format: "other", version: 1, results: [] }),
      JSON.stringify({ format: RESULT_FORMAT, version: 2, results: [] }),
      resultOf([{ id: "ad-1", kind: "remove", text: "x", status: "done" }]),
      resultOf([{ id: "ad-1", kind: "exclude", text: "美容院 安い 学生", status: "ok" }]),
      resultOf([{ id: 1, kind: "exclude", text: "x", status: "done" }]),
      resultOf([], { campaign: "ほかのキャンペーン" }),
      "x".repeat(c.maxPasteChars + 1),
      resultOf(Array.from({ length: c.maxItems + 1 }, (_, i) => ({ id: `x${i}`, kind: "stop", text: "a", status: "done" }))),
    ]) {
      const r = readSyncResult(raw, s, words, c);
      assert.equal(r.ok, false, raw.slice(0, 40));
      assert.ok(!r.ok && r.note.length > 0 && !r.note.includes("\n"));
    }
  });

  test("同じ結果を2回読み込んでも、印は1回だけ", () => {
    const { s } = world();
    const raw = resultOf([{ id: "ad-1", kind: "exclude", text: "美容院 安い 学生", status: "done" }]);
    const r1 = readSyncResult(raw, s, words, c);
    assert.ok(r1.ok);
    const s1 = withSynced(s, r1.marks, NOW);
    const r2 = readSyncResult(raw, s1, words, c);
    assert.ok(r2.ok);
    assert.deepEqual(r2.marks, []);
    assert.match(r2.notes.join(), /もう反映済み/);
    const s2 = withSynced(s1, [{ id: "ad-1", kind: "exclude" }], LATER);
    assert.equal(s2.proposals.find((p) => p.id === "ad-1")?.realAt, NOW, "前の印のまま");
    // 反映済みになった案は、次の渡す中身に入らない
    assert.ok(!syncItems(s1, words).items.some((i) => i.id === "ad-1"));
  });

  test("見本の結果（デモ）は渡す中身の全部を「反映した」にする", () => {
    const { s } = world();
    const { payload } = syncPayload(s, words, c, NOW);
    const r = readSyncResult(JSON.stringify(sampleResult(payload)), s, words, c);
    assert.ok(r.ok);
    assert.deepEqual(r.marks.map((m) => m.id), payload.items.map((i) => i.id));
  });

  test("画面は「くわしく」の中に小さく置く（本物の広告の名前は画面に出さない）", () => {
    const page = readFileSync("src/app/ads/page.tsx", "utf8");
    const fold = page.slice(page.indexOf("<Fold"), page.indexOf("</Fold>"));
    assert.match(fold, /<AdsConnect \/>/);
    const ui = readFileSync("src/app/ads/AdsConnect.tsx", "utf8");
    assert.match(ui, /本物の広告に渡す形を見る（今はつないでいません）/);
    for (const f of ["src/app/ads/AdsConnect.tsx", "src/app/ads/page.tsx", "src/app/ads/AdsReport.tsx", "src/components/AdAddRow.tsx", "config/ads.json"])
      assert.doesNotMatch(readFileSync(f, "utf8"), /Google|グーグル/, f);
  });
});
