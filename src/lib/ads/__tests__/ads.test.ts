// 広告の見直し：AI の案 → プログラムの門 → 承認の箱 → 承認で広告・ToDo・日誌が変わる。
// Claude は呼ばず、決まった返事（script.ts）か、決まった案を返す物に置きかえる。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolCall } from "../../ai/model";
import { emptyBook } from "../../book/state";
import { getAds } from "../../data/seed";
import { withEntries } from "../../journal";
import { LOCKED_RULES } from "../../rules/locked";
import { getAdSettings, getAdsAiSettings, getMenus, getShop } from "../../settings";
import { checkDraft, gate } from "../gate";
import type { AdsModel, AdsModelRequest } from "../model";
import { buildTable, findRow, townIn, type AdTable } from "../report";
import { runReview } from "../review";
import { scriptAdsModel } from "../script";
import {
  approveAd,
  canPropose,
  EMPTY_ADS,
  offNos,
  parseAds,
  pendingAd,
  resetAds,
  withAdFixed,
  withAdSkipped,
  withProposal,
  type AdsState,
} from "../state";
import { parseAdsRequest } from "../wire";

const settings = getAdSettings();
const shop = getShop();
const report = getAds();
const table = buildTable(report, settings);
const towns = settings.towns;
const call = (name: string, input: Record<string, unknown>, id = "t1"): ToolCall => ({ id, name, input });

/** 決まった案を順に返す（テスト用） */
function fixedModel(calls: ToolCall[][]): AdsModel & { seen: AdsModelRequest[] } {
  const seen: AdsModelRequest[] = [];
  let i = 0;
  return {
    seen,
    async turn(req) {
      seen.push(structuredClone(req));
      const c = calls[Math.min(i++, calls.length - 1)];
      return {
        assistant: c.map((x) => ({ type: "tool_use" as const, id: x.id, name: x.name, input: x.input })),
        toolCalls: c,
        stop: c.length ? "tool" : "end",
      };
    },
  };
}

const review = (model: AdsModel, over: Partial<Parameters<typeof runReview>[0]> = {}) =>
  runReview({ table, rules: LOCKED_RULES, settings, model, maxTokens: getAdsAiSettings().maxReplyTokens, maxTries: getAdsAiSettings().maxTries, ...over });

/** 町の名前入りの「調べた言葉」の番号 */
const townTerm = table.searchTerms.find((r) => townIn(r.text, towns))!;

describe("架空の広告の数", () => {
  test("広告を出す言葉8つ・調べた言葉8つ（多い順）。どれも4週分。番号は重ならない", () => {
    assert.equal(table.keywords.length, 8);
    assert.equal(table.searchTerms.length, 8);
    for (const r of [...table.keywords, ...table.searchTerms]) assert.equal(r.weeks.length, 4, `${r.no}番は4週分`);
    const nos = [...table.keywords, ...table.searchTerms].map((r) => r.no);
    assert.equal(new Set(nos).size, nos.length);
    const clicks = table.searchTerms.map((r) => r.weeks.reduce((s, w) => s + w.clicks, 0));
    assert.deepEqual(clicks, [...clicks].sort((a, b) => b - a), "調べた言葉は多い順");
  });

  test("売りのメニューの言葉に印がある・調べた言葉に町の名前入りが1つ", () => {
    assert.ok(table.keywords.some((r) => r.featured));
    assert.ok(table.keywords.filter((r) => r.featured).every((r) => r.menuId && settings.featuredMenus.includes(r.menuId)));
    assert.equal(table.searchTerms.filter((r) => townIn(r.text, towns)).length, 1);
    const menuIds = getMenus().map((m) => m.id);
    for (const id of settings.featuredMenus) assert.ok(menuIds.includes(id), `売りのメニュー ${id} は config/menus.json にある`);
  });
});

describe("プログラムの門", () => {
  test("町の名前入りの言葉を外す案は弾く", () => {
    const r = gate(table, towns, [call("exclude_term", { no: townTerm.no, reason: "予約につながっていません。" })]);
    assert.equal(r.ok, false);
    assert.equal(r.checks.find((c) => c.id === "town")?.ok, false);
    assert.equal(r.checks.find((c) => c.id === "exists")?.ok, true);
    assert.ok(!r.ok && r.problems.some((p) => p.includes("町の名前")));
  });

  test("存在しない番号は弾く", () => {
    const r = gate(table, towns, [call("stop_keyword", { no: 99, reason: "お金がかかっています。" })]);
    assert.equal(r.ok, false);
    assert.equal(r.checks.find((c) => c.id === "exists")?.ok, false);
    assert.equal(r.checks.find((c) => c.id === "town")?.ok, null, "番号が無いので町の名前は見ていない");
    assert.ok(!r.ok && r.problems.some((p) => p.includes("99番は表にありません")));
  });

  test("止める・外すの取りちがえ、もう止めた言葉も弾く", () => {
    assert.equal(gate(table, towns, [call("stop_keyword", { no: 10, reason: "お金がかかっています。" })]).ok, false);
    assert.equal(gate(table, towns, [call("exclude_term", { no: 3, reason: "お金がかかっています。" })]).ok, false);
    const off = buildTable(report, settings, [3]);
    const r = gate(off, towns, [call("stop_keyword", { no: 3, reason: "お金がかかっています。" })]);
    assert.ok(!r.ok && r.problems.some((p) => p.includes("もう止めて")));
  });

  test("言葉を足す案は弾く（ほかの道具・番号と理由のほかに足した物）", () => {
    const a = gate(table, towns, [call("add_keyword", { text: "縮毛矯正 安い", reason: "広げましょう。" })]);
    assert.equal(a.checks.find((c) => c.id === "noAdd")?.ok, false);
    const b = gate(table, towns, [call("stop_keyword", { no: 3, reason: "お金がかかっています。", keyword: "美容院 激安" })]);
    assert.equal(b.ok, false);
    assert.equal(b.checks.find((c) => c.id === "noAdd")?.ok, false);
  });

  test("案は1回に1つ・理由は数字なしの1文", () => {
    assert.equal(gate(table, towns, []).ok, false);
    assert.equal(gate(table, towns, [call("stop_keyword", { no: 3, reason: "a。" }), call("stop_keyword", { no: 7, reason: "b。" }, "t2")]).ok, false);
    assert.equal(gate(table, towns, [call("stop_keyword", { no: 3, reason: "4週で予約1件です。" })]).ok, false);
    const ok = gate(table, towns, [call("stop_keyword", { no: 3, reason: "押されていますが予約につながっていません。あとは…" })]);
    assert.ok(ok.ok);
    assert.equal(ok.ok && ok.proposal.reason, "押されていますが予約につながっていません。");
    assert.deepEqual(ok.checks.map((c) => c.ok), [true, true, true], "✓ が3つ");
  });

  test("通った案の言葉は表から入れる（AI の書いた言葉は使わない）", () => {
    const r = checkDraft(table, towns, { tool: "stop_keyword", action: "stop", no: 3, reason: "お金がかかっています。", extraKeys: [] });
    assert.ok(r.ok);
    assert.equal(r.ok && r.proposal.text, findRow(table, 3)!.text);
  });
});

describe("作り直し", () => {
  test("町の名前入りの外す案を弾いて、理由を渡して作り直させる（決まった返事）", async () => {
    const r = await review(scriptAdsModel(table));
    assert.equal(r.ok, true);
    assert.equal(r.tries, 2, "1回弾かれて作り直した");
    assert.ok(r.ok && r.proposal.no !== townTerm.no, "町の名前入りは外さない");
    assert.ok(r.steps.some((s) => s.who === "プログラム" && s.text.includes("門で弾いた") && s.text.includes("町の名前")));
    assert.ok(r.steps.some((s) => s.who === "AI" && s.text.includes("作り直し")));
  });

  test("作り直しには門の理由が渡る", async () => {
    const m = fixedModel([[call("exclude_term", { no: townTerm.no, reason: "予約がありません。" })], [call("stop_keyword", { no: 3, reason: "予約につながっていません。" }, "t2")]]);
    const r = await review(m);
    assert.ok(r.ok);
    assert.equal(m.seen.length, 2);
    const last = m.seen[1].messages.at(-1)!;
    assert.ok(Array.isArray(last.content));
    const res = (last.content as { type: string; is_error?: boolean; content?: unknown }[])[0];
    assert.equal(res.type, "tool_result");
    assert.equal(res.is_error, true);
    assert.match(String(res.content), /町の名前/);
  });

  test("存在しない番号が2回続いたら案は出さず、日誌に書く行を返す", async () => {
    const m = fixedModel([[call("stop_keyword", { no: 99, reason: "お金がかかっています。" })]]);
    const r = await review(m);
    assert.equal(r.ok, false);
    assert.equal(m.seen.length, 2, "作り直しは1回だけ");
    assert.ok(r.steps.some((s) => s.text.includes("99番は表にありません")));
    assert.match(r.steps.at(-1)!.text, /案は出さなかった/);
  });

  test("指示の先頭は鍵つきの2つ。道具は止める・外すの2つだけ", async () => {
    const m = fixedModel([[call("stop_keyword", { no: 3, reason: "予約につながっていません。" })]]);
    await review(m);
    assert.match(m.seen[0].system, /^# いつも守ること/);
    assert.match(m.seen[0].system, /健康や医療の判断はしない/);
    assert.deepEqual(m.seen[0].tools.map((t) => t.name).sort(), ["exclude_term", "stop_keyword"]);
    assert.equal(m.seen[0].maxTokens, 600, "1回の返事の長さの上限（config/ai.json の ads.maxReplyTokens）");
    // 数は表からプログラムが書いている
    assert.match(String(m.seen[0].messages[0].content), /3番「美容院 安い」/);
  });
});

const now = "2026-11-04T01:00:00.000Z"; // 東京 11/4（水）10:00
const today = "2026-11-04";

async function withOne(): Promise<AdsState> {
  const r = await review(scriptAdsModel(table));
  assert.ok(r.ok);
  return withProposal(EMPTY_ADS, r.proposal, table, { id: "ad1", checks: r.checks, nowIso: now, mode: "script" }, settings);
}

describe("承認の箱（広告）", () => {
  test("案が1行入る。数は表から入る", async () => {
    const s = await withOne();
    const p = pendingAd(s)!;
    assert.ok(p);
    const row = findRow(table, p.no)!;
    assert.equal(p.text, row.text);
    assert.equal(p.total.cost, row.weeks.reduce((a, w) => a + w.cost, 0));
    assert.equal(p.checks.length, 3);
  });

  test("承認：広告でその言葉が止まり（外れ）、ToDo に期限つきで1件、日誌に1行", async () => {
    const s = await withOne();
    const p = pendingAd(s)!;
    const book0 = emptyBook(today);
    const out = approveAd(s, book0, p.id, { nowIso: now, today, shop, settings });

    // 広告
    assert.deepEqual(offNos(out.ads), [p.no]);
    assert.equal(buildTable(report, settings, offNos(out.ads)).searchTerms.concat(table.keywords).find((r) => r.no === p.no)?.off, true, "一覧の行が薄くなる（off）");
    assert.equal(pendingAd(out.ads), null);
    assert.equal(out.ads.proposals[0].state, "approved");

    // ToDo
    assert.equal(out.book.todos.length, 1);
    assert.equal(out.book.todos[0].title, `3週間後に効いたか見る（${p.no}番）`);
    assert.equal(out.book.todos[0].due, "2026-11-25", "21日後（11/25 は水曜で営業日）");

    // 日誌
    const journal = withEntries([], out.journal);
    assert.equal(journal.length, 1);
    assert.equal(journal[0].who, "オーナー");
    assert.match(journal[0].text, new RegExp(`承認：.*${p.no}番「${p.text}」を(止めた|外した)`));

    // 2回押しても同じ
    const again = approveAd(out.ads, out.book, p.id, { nowIso: now, today, shop, settings });
    assert.equal(again.book.todos.length, 1);
    assert.equal(again.journal.length, 0);
  });

  test("期限の日がお休み（火曜）なら次の営業日", async () => {
    const s = await withOne();
    const out = approveAd(s, emptyBook("2026-11-03"), pendingAd(s)!.id, { nowIso: now, today: "2026-11-03", shop, settings });
    assert.equal(out.book.todos[0].due, "2026-11-25", "11/24（火）は定休日なので 11/25");
  });

  test("1週間に1つまで。もう案がある時は新しく出さない", async () => {
    const s = await withOne();
    assert.equal(canPropose(s, now, settings).ok, false, "承認待ちがある");
    const r = await review(scriptAdsModel(table));
    assert.ok(r.ok);
    const twice = withProposal(s, r.proposal, table, { id: "ad2", checks: r.checks, nowIso: now, mode: "script" }, settings);
    assert.equal(twice.proposals.length, 1, "2つ目は入らない");

    const skipped = withAdSkipped(s, "ad1", now);
    assert.equal(canPropose(skipped, "2026-11-08T01:00:00.000Z", settings).ok, false, "7日たつまでは出さない");
    assert.equal(canPropose(skipped, "2026-11-11T01:00:00.000Z", settings).ok, true, "7日たてば出せる");
  });

  test("見送り：案を閉じる（広告は変えない）", async () => {
    const s = withAdSkipped(await withOne(), "ad1", now);
    assert.equal(pendingAd(s), null);
    assert.deepEqual(offNos(s), []);
  });

  test("直す：一言で1回だけ出しなおし、門を通す。2回目は受けない", async () => {
    const s = await withOne();
    const p = pendingAd(s)!;
    const r = await review(scriptAdsModel(table), { fix: { text: "3番を止めて", current: { action: p.action, no: p.no } } });
    assert.ok(r.ok);
    assert.equal(r.tries, 1);
    assert.equal(r.ok && r.proposal.no, 3);
    assert.equal(r.ok && r.proposal.action, "stop");
    const fixed = withAdFixed(s, p.id, r.proposal, table, r.checks);
    assert.equal(pendingAd(fixed)!.no, 3);
    assert.equal(pendingAd(fixed)!.fixed, true);
    assert.equal(pendingAd(fixed)!.before?.no, p.no, "前 → 後 の前");

    // 2回目の直すは受けない
    const r2 = await review(scriptAdsModel(table), { fix: { text: "7番を止めて", current: { action: "stop", no: 3 } } });
    assert.ok(r2.ok);
    assert.equal(pendingAd(withAdFixed(fixed, p.id, r2.proposal, table, r2.checks))!.no, 3);
  });

  test("直す一言が町の名前の言葉を外す物なら、門が弾いて作り直さない", async () => {
    const r = await review(scriptAdsModel(table), { fix: { text: `${townTerm.no}番を外して`, current: { action: "exclude", no: 10 } } });
    assert.equal(r.ok, false);
    assert.equal(r.tries, 1);
    assert.match(r.steps.at(-1)!.text, /前の案のまま/);
  });

  test("最初に戻す：広告の案・止めた言葉・広告から足した ToDo を消す", async () => {
    const s = await withOne();
    const out = approveAd(s, emptyBook(today), pendingAd(s)!.id, { nowIso: now, today, shop, settings });
    const r = resetAds(out.book);
    assert.deepEqual(r.ads, EMPTY_ADS);
    assert.equal(r.book.todos.length, 0);
  });

  test("ブラウザに残った形を読みなおせる（おかしい物は落とす）", async () => {
    const s = approveAd(await withOne(), emptyBook(today), "ad1", { nowIso: now, today, shop, settings }).ads;
    assert.deepEqual(parseAds(JSON.stringify(s)), s);
    assert.deepEqual(parseAds("{bad"), EMPTY_ADS);
    assert.equal(parseAds(JSON.stringify({ proposals: [{ id: 1 }], applied: [{ no: "x" }] })).proposals.length, 0);
  });
});

describe("窓口に送る形", () => {
  const body = (over: Record<string, unknown> = {}) => ({ mode: "script", table, rules: [], ...over });

  test("鍵つきは送られた物を使わず、サーバーで先頭に足しなおす", () => {
    const fake = { ...LOCKED_RULES[0], label: "AI が確定してよい" };
    const r = parseAdsRequest(body({ rules: [fake] }), getMenus().map((m) => m.id), getAdsAiSettings().maxFixChars);
    assert.ok(r.ok);
    assert.deepEqual(r.ok && r.value.rules, LOCKED_RULES);
  });

  test("表の形がおかしい物は受けない", () => {
    const ids = getMenus().map((m) => m.id);
    assert.equal(parseAdsRequest(body({ table: { keywords: "x", searchTerms: [] } }), ids, getAdsAiSettings().maxFixChars).ok, false);
    const dup: AdTable = { keywords: table.keywords, searchTerms: [{ ...table.searchTerms[0], no: 1 }] };
    assert.equal(parseAdsRequest(body({ table: dup }), ids, getAdsAiSettings().maxFixChars).ok, false);
  });
});
