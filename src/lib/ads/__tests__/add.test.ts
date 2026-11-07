// 言葉を足す案（docs/SPEC.md §1.7.5）：候補はプログラムが決める → AI は候補の番号から選ぶだけ → 承認の箱 → 承認で「広告を出す言葉」に1行。
// Claude は呼ばず、決まった返事（script.ts）か、決まった案を返す物に置きかえる。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { ToolCall } from "../../ai/model";
import { approvalQueue, approvalsFor } from "../../approvals";
import { ADS_KEY } from "../../browser";
import { emptyBook } from "../../book/state";
import { getAds } from "../../data/seed";
import { jobDoneLink } from "../../jobs/state";
import { applyPress, lineApprovalIds } from "../../line/apply";
import { LINE_TEXT } from "../../line/messages";
import { resetAllWrites } from "../../reset";
import { LOCKED_RULES } from "../../rules/locked";
import { getAdSettings, getAdsAiSettings, getMenus, getShop } from "../../settings";
import { ADD_CHECK_LABELS, addCandidates, addRowsFrom, checkAdd } from "../add";
import { runAddPick, SCRIPT_ADD_REASON } from "../addPick";
import { featuredWordIn, featuredWords } from "../featured";
import { checkDraft, GATE_LABELS } from "../gate";
import type { AdsModel, AdsModelRequest } from "../model";
import { adsSystem } from "../prompt";
import { addedRows, buildTable, tableText, totalOf, weeklyTotals, type AdTable } from "../report";
import { runReview } from "../review";
import { scriptAdsModel } from "../script";
import { serveAds } from "../serve";
import {
  addMarks,
  approveAd,
  approveAdd,
  canPropose,
  EMPTY_ADS,
  isEmptyAds,
  parseAds,
  pendingAd,
  pendingAdds,
  resetAds,
  tableOf,
  withAddSkipped,
  withAdSkipped,
  withReview,
  type AdsState,
} from "../state";
import { canMeet } from "../team/state";
import { dueToJudge, pendingRevert, waitingJudge } from "../verdict";
import { buildWeeklyReport } from "../weekly";
import { AD_ADD_TOOL, AD_TOOL_DEFS } from "../tools";
import type { AdsRequest } from "../wire";

const settings = getAdSettings();
const ai = getAdsAiSettings();
const shop = getShop();
const report = getAds();
const menus = getMenus();
const words = featuredWords(settings, menus);
const table = buildTable(report, settings);
const NOW = "2026-11-07T01:00:00.000Z";
const TODAY = "2026-11-07";
const DAY = 86_400_000;
const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

const term = (text: string) => table.searchTerms.find((r) => r.text === text)!;
const SHUKUMOU = term("縮毛矯正 くせ毛 ひどい");
const SPA = term("ヘッドスパ 眠れる");
const STUDENT = term("美容院 安い 学生");
const SELF = term("セルフ 縮毛矯正 やり方");

/** 止める・外すの回と足すの回で、決まった道具の呼び出しを返す（テスト用） */
function fixedModel(o: { review?: ToolCall[]; add: ToolCall[] }): AdsModel & { seen: AdsModelRequest[] } {
  const seen: AdsModelRequest[] = [];
  const base = scriptAdsModel(table);
  return {
    seen,
    async turn(req) {
      seen.push(structuredClone(req));
      if (req.tools.some((t) => t.name === AD_ADD_TOOL)) {
        const c = o.add;
        return { assistant: c.map((x) => ({ type: "tool_use" as const, id: x.id, name: x.name, input: x.input })), toolCalls: c, stop: c.length ? "tool" : "end" };
      }
      return base.turn(req);
    },
  };
}
const addCall = (no: unknown, reason = "売りのメニューで調べた方が予約につながっています。", id = `a-${String(no)}`): ToolCall => ({ id, name: AD_ADD_TOOL, input: { no, reason } });

const pick = (model: AdsModel | null, t: AdTable = table) =>
  runAddPick({ table: t, words, rules: LOCKED_RULES, settings, model, maxTokens: ai.maxReplyTokens, maxAdds: ai.maxAdds, maxCalls: ai.maxAddCalls });

/** 見直し1回（決まった返事）を、広告タブと同じ形で承認の箱に入れた状態 */
async function reviewed(s: AdsState = EMPTY_ADS, nowIso = NOW, mode: "script" | "ai" = "script", model?: AdsModel) {
  const t = tableOf(report, settings, s);
  const req: AdsRequest = { mode, table: t, rules: LOCKED_RULES };
  const res = await serveAds(req, { model: model ?? scriptAdsModel(t), menus, settings, ai });
  assert.ok(res.ok);
  const again = checkDraft(t, settings.towns, { tool: "x", action: res.proposal.action, no: res.proposal.no, reason: res.proposal.reason, extraKeys: [] });
  assert.ok(again.ok);
  const id = `ad-${Date.parse(nowIso)}`;
  const adds = addRowsFrom(t, words, res.adds?.picks, { baseId: id, maxAdds: ai.maxAdds, ...(again.proposal.action === "exclude" ? { skipNo: again.proposal.no } : {}) });
  const next = withReview(s, { proposal: { ...again.proposal, id, checks: again.checks }, adds: adds.rows }, t, { nowIso, mode }, settings);
  return { state: next, res, id, adds };
}

describe("売りの言葉（1か所の関数）", () => {
  test("売りのメニューの名前を設定から読む（今は「縮毛矯正」「ヘッドスパ」）", () => {
    assert.deepEqual(words, ["縮毛矯正", "ヘッドスパ"]);
  });
  test("空白（全角も）を除いて比べる", () => {
    assert.equal(featuredWordIn("縮毛　矯正 くせ毛", words), "縮毛矯正");
    assert.equal(featuredWordIn("ヘッド スパ 眠れる", words), "ヘッドスパ");
    assert.equal(featuredWordIn("美容院 安い 学生", words), null);
    assert.equal(featuredWordIn("", words), null);
    assert.equal(featuredWordIn("縮毛矯正", []), null);
  });
});

describe("足す候補の決まり（プログラム）", () => {
  test("最初の状態：「縮毛矯正 くせ毛 ひどい」（予約2件）と「ヘッドスパ 眠れる」（予約1件）が候補・予約の多い順", () => {
    assert.equal(totalOf(SHUKUMOU).bookings, 2);
    assert.equal(totalOf(SPA).bookings, 1);
    assert.deepEqual(addCandidates(table, words).map((c) => c.text), ["縮毛矯正 くせ毛 ひどい", "ヘッドスパ 眠れる"]);
  });

  test("「美容院 安い 学生」は売りの言葉なし・「セルフ 縮毛矯正 やり方」は予約0件で候補にならない", () => {
    const a = checkAdd(table, words, STUDENT.no);
    assert.equal(a.ok, false);
    assert.equal(a.checks.find((c) => c.id === "featured")?.ok, false);
    const b = checkAdd(table, words, SELF.no);
    assert.equal(b.ok, false);
    assert.equal(b.checks.find((c) => c.id === "featured")?.ok, true);
    assert.equal(b.checks.find((c) => c.id === "booked")?.ok, false);
  });

  test("全部に合う時の印は4つとも ✓（足す用の4つ）", () => {
    const r = checkAdd(table, words, SHUKUMOU.no);
    assert.ok(r.ok);
    assert.deepEqual(r.checks.map((c) => [c.label, c.ok]), Object.values(ADD_CHECK_LABELS).map((l) => [l, true]));
  });

  test("どれか1つ欠けたら候補にならない：表に無い・広告を出す言葉の番号・もう広告を出す言葉にある・外した・見送った・もう足した・承認待ち", () => {
    const only = (t: AdTable) => addCandidates(t, words).map((c) => c.no);
    assert.equal(checkAdd(table, words, 999).ok, false, "表に無い");
    assert.equal(checkAdd(table, words, 2).ok, false, "広告を出す言葉の番号は足さない");
    const sameAsKeyword: AdTable = { ...table, keywords: [...table.keywords, { ...table.keywords[0], no: 90, text: "縮毛矯正　くせ毛ひどい" }] };
    assert.ok(!only(sameAsKeyword).includes(SHUKUMOU.no), "もう広告を出す言葉にある（空白を除いて同じ）");
    for (const [what, t] of [
      ["外した", buildTable(report, settings, [SHUKUMOU.no])],
      ["見送った", buildTable(report, settings, [], [[SHUKUMOU.no, "skipped"]])],
      ["もう足した", buildTable(report, settings, [], [[SHUKUMOU.no, "added"]])],
      ["承認待ち", buildTable(report, settings, [], [[SHUKUMOU.no, "pending"]])],
    ] as const) {
      assert.deepEqual(only(t), [SPA.no], what);
      assert.equal(checkAdd(t, words, SHUKUMOU.no).checks.find((c) => c.id === "fresh")?.ok, false, what);
    }
    const noBooking: AdTable = { ...table, searchTerms: table.searchTerms.map((r) => (r.no === SPA.no ? { ...r, weeks: r.weeks.map((w) => ({ ...w, bookings: 0 })) } : r)) };
    assert.deepEqual(only(noBooking), [SHUKUMOU.no], "予約0件");
    assert.deepEqual(addCandidates(table, []), [], "売りの言葉が無ければ候補なし");
  });
});

describe("止める・外すの見直しは今と同じ", () => {
  test("最初の状態（決まった返事）：1回目の9番は町の名前で弾き、作り直しで10番を外す。足す案があっても止める・外すの中身は同じ", async () => {
    const alone = await runReview({ table, rules: LOCKED_RULES, settings, model: scriptAdsModel(table), maxTokens: ai.maxReplyTokens, maxTries: ai.maxTries });
    const both = await serveAds({ mode: "script", table, rules: LOCKED_RULES }, { model: scriptAdsModel(table), menus, settings, ai });
    assert.ok(alone.ok && both.ok);
    assert.deepEqual({ ...both, adds: undefined }, { ...alone, adds: undefined });
    assert.equal(alone.proposal.action, "exclude");
    assert.equal(alone.proposal.no, 10);
    assert.equal(alone.tries, 2);
    assert.deepEqual(alone.checks.map((c) => c.label), [GATE_LABELS.exists, GATE_LABELS.noAdd, GATE_LABELS.town]);
  });

  test("止める・外すの回に渡す道具は2つだけ（足す道具は渡さない）・止める・外すの指示は足す案を出さない", async () => {
    const m = fixedModel({ add: [] });
    await serveAds({ mode: "ai", table, rules: LOCKED_RULES }, { model: m, menus, settings, ai });
    const reviewTurns = m.seen.filter((r) => !r.tools.some((t) => t.name === AD_ADD_TOOL));
    assert.ok(reviewTurns.length >= 1);
    for (const r of reviewTurns) {
      assert.deepEqual(r.tools.map((t) => t.name), AD_TOOL_DEFS.map((t) => t.name));
      assert.notEqual(r.parallel, true, "止める・外すは1回に1つ");
    }
    assert.match(adsSystem(LOCKED_RULES, settings, (id) => id), /止める・外すの案だけ/);
  });

  test("足す道具で止める・外すの門を通そうとしても、今までどおり「言葉を足していない」で弾く", () => {
    const r = checkDraft(table, settings.towns, { tool: AD_ADD_TOOL, action: null, no: SHUKUMOU.no, reason: "足したいです。", extraKeys: [] });
    assert.equal(r.ok, false);
    assert.equal(r.checks.find((c) => c.id === "noAdd")?.ok, false);
  });

  test("直す時は足す案を作らない", async () => {
    const r = await serveAds({ mode: "script", table, rules: LOCKED_RULES, fix: { text: "3番を止めて", current: { action: "exclude", no: 10 } } }, { model: scriptAdsModel(table), menus, settings, ai });
    assert.equal(r.adds, undefined);
  });
});

describe("足す案の1回（AI は候補の番号から選ぶだけ）", () => {
  test("AI を呼ぶのは1回だけ・道具は足すの1つ・候補ごとに呼んでよい・指示の先頭は鍵つき", async () => {
    const m = fixedModel({ add: [addCall(SHUKUMOU.no)] });
    const r = await pick(m);
    assert.equal(m.seen.length, 1);
    assert.deepEqual(m.seen[0].tools.map((t) => t.name), [AD_ADD_TOOL]);
    assert.equal(m.seen[0].parallel, true);
    assert.ok(m.seen[0].system.startsWith("# いつも守ること（🔒 鍵つき"), m.seen[0].system.slice(0, 40));
    assert.deepEqual(r.picks.map((p) => p.no), [SHUKUMOU.no]);
    assert.match(String(m.seen[0].messages[0].content), /11番「縮毛矯正 くせ毛 ひどい」/);
  });

  test("候補に無い番号（売りでない・予約0件・表に無い）はプログラムが外し、「断った」と1行", async () => {
    const r = await pick(fixedModel({ add: [addCall(STUDENT.no), addCall(SELF.no), addCall(999), addCall(SPA.no)] }));
    assert.deepEqual(r.picks.map((p) => p.no), [SPA.no]);
    const refused = r.steps.filter((s) => s.text.startsWith("断った："));
    assert.equal(refused.length, 3);
    assert.ok(refused.every((s) => s.who === "プログラム"));
    assert.match(refused[0].text, new RegExp(`${STUDENT.no}番は足す候補にありません`));
  });

  test("1回に2件まで（3つ目は断る）・同じ番号は1つ・理由が門を通らない物は断る", async () => {
    const r = await pick(fixedModel({ add: [addCall(SHUKUMOU.no), addCall(SHUKUMOU.no, undefined, "dup"), addCall(SPA.no), addCall(SPA.no, undefined, "x")] }));
    assert.deepEqual(r.picks.map((p) => p.no), [SHUKUMOU.no, SPA.no]);
    const bad = await pick(fixedModel({ add: [addCall(SHUKUMOU.no, "予約が2件あります。")] }));
    assert.deepEqual(bad.picks, []);
    assert.match(bad.steps.map((s) => s.text).join("\n"), /言葉の門/);
  });

  test("決まった返事（AI なし）：同じ候補から予約の多い順に2件まで・AI は呼ばない", async () => {
    const r = await pick(null);
    assert.deepEqual(r.picks.map((p) => [p.no, p.reason]), [
      [SHUKUMOU.no, SCRIPT_ADD_REASON],
      [SPA.no, SCRIPT_ADD_REASON],
    ]);
    const viaServe = await serveAds({ mode: "script", table, rules: LOCKED_RULES }, { model: scriptAdsModel(table), menus, settings, ai });
    assert.deepEqual(viaServe.adds?.picks, r.picks);
  });

  test("候補が無ければ AI を呼ばない", async () => {
    const m = fixedModel({ add: [addCall(SHUKUMOU.no)] });
    const none = buildTable(report, settings, [], [[SHUKUMOU.no, "added"], [SPA.no, "skipped"]]);
    const r = await pick(m, none);
    assert.equal(m.seen.length, 0);
    assert.deepEqual(r.picks, []);
  });

  test("同じ見直しで外す案にした言葉は候補にしない・画面でもう一度確かめる（上限・門）", () => {
    assert.deepEqual(addCandidates(table, words, { skipNo: SHUKUMOU.no }).map((c) => c.no), [SPA.no]);
    const out = addRowsFrom(table, words, [
      { no: SHUKUMOU.no, text: "", reason: "ふつうの理由です。" },
      { no: STUDENT.no, text: "", reason: "ふつうの理由です。" },
      { no: SPA.no, text: "", reason: "ふつうの理由です。" },
    ], { baseId: "ad-x", maxAdds: 2, skipNo: SPA.no });
    assert.deepEqual(out.rows.map((r) => [r.id, r.no]), [["ad-x-add1", SHUKUMOU.no]]);
    assert.equal(out.refused.length, 2);
  });

  test("止める・外すの見直しが門を通らなくても、足す案は動く", async () => {
    // 止める・外すの回は、いつも表に無い番号を出す
    const m: AdsModel = {
      async turn(req) {
        const c: ToolCall[] = req.tools.some((t) => t.name === AD_ADD_TOOL) ? [addCall(SPA.no)] : [{ id: "s", name: "stop_keyword", input: { no: 999, reason: "止めたいです。" } }];
        return { assistant: c.map((x) => ({ type: "tool_use" as const, id: x.id, name: x.name, input: x.input })), toolCalls: c, stop: "tool" };
      },
    };
    const r = await serveAds({ mode: "ai", table, rules: LOCKED_RULES }, { model: m, menus, settings, ai });
    assert.equal(r.ok, false);
    assert.deepEqual(r.adds?.picks.map((p) => p.no), [SPA.no]);
    // 足す案の行だけでも、1回の見直しとして入る（7日に1回の数え方に入る）
    const rows = addRowsFrom(table, words, r.adds?.picks, { baseId: "ad-y", maxAdds: 2 });
    const s = withReview(EMPTY_ADS, { adds: rows.rows }, table, { nowIso: NOW, mode: "ai" }, settings);
    assert.equal(pendingAds(s).length, 1);
    assert.equal(canPropose(s, at(DAY), settings).ok, false);
  });
});

function pendingAds(s: AdsState) {
  return pendingAdds(s);
}

describe("承認の箱（足す案）", () => {
  test("止める・外すの行の下に足すの行。数は承認の箱の行から（予約タブには出さない）", async () => {
    const { state } = await reviewed();
    const q = approvalQueue(emptyBook(TODAY), state, NOW);
    assert.ok(q.ad);
    assert.deepEqual(q.adAdds.map((p) => p.text), ["縮毛矯正 くせ毛 ひどい", "ヘッドスパ 眠れる"]);
    assert.equal(q.count, 3);
    assert.deepEqual(approvalsFor(q, "reservations").adAdds, []);
    assert.deepEqual(q.adAdds[0].checks.map((c) => c.label), Object.values(ADD_CHECK_LABELS), "足す用の4つ");
    assert.deepEqual(q.ad!.checks.map((c) => c.label), [GATE_LABELS.exists, GATE_LABELS.noAdd, GATE_LABELS.town], "止める・外すの印は今のまま");
  });

  test("承認で「広告を出す言葉」に足した印つきで1行（数は空・週ごとの合計は変わらない）。元の調べた言葉に「もう足した」", async () => {
    const { state } = await reviewed();
    const p = pendingAdds(state)[0];
    const before = tableOf(report, settings, state);
    const out = approveAdd(state, p.id, { nowIso: NOW, table: before, words, settings });
    assert.ok(out.ok);
    const after = tableOf(report, settings, out.ads);
    assert.deepEqual(addedRows(after).map((r) => r.text), ["縮毛矯正 くせ毛 ひどい"]);
    assert.equal(after.keywords.length, before.keywords.length, "広告を出す言葉の数の表には入れない");
    assert.deepEqual(weeklyTotals(after.keywords), weeklyTotals(before.keywords), "週ごとの合計は変わらない");
    assert.equal(after.searchTerms.find((r) => r.no === p.no)?.addMark, "added");
    assert.match(tableText(after, settings.towns), /「縮毛矯正 くせ毛 ひどい」［足した・数はまだ無い］/);
    assert.match(tableText(after, settings.towns), /11番「縮毛矯正 くせ毛 ひどい」［もう足した］/);
    assert.match(out.journal[0].text, /効いたかの判定は次に作る物/);
    assert.equal(out.journal[0].who, "オーナー");
    // 同じ言葉を2回足さない
    const twice = approveAdd(out.ads, p.id, { nowIso: NOW, table: after, words, settings });
    assert.equal(twice.ok, false);
    assert.equal(twice.ads, out.ads);
  });

  test("足した言葉は止める案の対象にしない・外す案にもしない", async () => {
    const { state } = await reviewed();
    const p = pendingAdds(state)[0];
    const out = approveAdd(state, p.id, { nowIso: NOW, table: tableOf(report, settings, state), words, settings });
    const t = tableOf(report, settings, out.ads);
    const stop = checkDraft(t, settings.towns, { tool: "stop_keyword", action: "stop", no: p.no, reason: "止めたいです。", extraKeys: [] });
    assert.equal(stop.ok, false);
    const ex = checkDraft(t, settings.towns, { tool: "exclude_term", action: "exclude", no: p.no, reason: "外したいです。", extraKeys: [] });
    assert.equal(ex.ok, false);
    assert.match(ex.problems.join(), /足した言葉なので外しません/);
  });

  test("見送りで、次の見直しから候補にならない", async () => {
    const { state } = await reviewed();
    const [a, b] = pendingAdds(state);
    let s = withAddSkipped(state, a.id, NOW);
    s = withAddSkipped(s, b.id, NOW);
    s = withAdSkipped(s, pendingAd(s)!.id, NOW);
    assert.deepEqual(addMarks(s).sort(), [[a.no, "skipped"], [b.no, "skipped"]].sort());
    assert.deepEqual(addCandidates(tableOf(report, settings, s), words), []);
    const next = await reviewed(s, at(8 * DAY));
    assert.deepEqual(next.res.adds?.picks, []);
  });

  test("承認の時にもう一度確かめる：同じ言葉を外した後は足さない", async () => {
    const { state } = await reviewed();
    const p = pendingAdds(state)[0];
    const excluded: AdsState = { ...state, applied: [...state.applied, { no: p.no, action: "exclude", at: NOW, proposalId: "other" }] };
    const out = approveAdd(excluded, p.id, { nowIso: NOW, table: tableOf(report, settings, excluded), words, settings });
    assert.equal(out.ok, false);
    assert.equal(out.ads, excluded);
    assert.match(out.journal[0].text, /^足さなかった/);
  });
});

describe("承認待ちは1つ・案は7日に1つ（1回の見直しの行をまとめて1回）", () => {
  test("どれか1行でも承認待ちなら、次の見直しは頼めない", async () => {
    const { state } = await reviewed();
    assert.equal(canPropose(state, NOW, settings).ok, false);
    // 止める・外すを決めても、足すの行が残っていれば頼めない
    let s = withAdSkipped(state, pendingAd(state)!.id, NOW);
    assert.equal(pendingAd(s), null);
    const r = canPropose(s, at(8 * DAY), settings);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, /もう案があります/);
    for (const p of pendingAdds(s)) s = withAddSkipped(s, p.id, NOW);
    assert.equal(canPropose(s, at(8 * DAY), settings).ok, true, "全部決めて7日たてば頼める");
  });

  test("同じ見直しの3行は1回と数える：次に頼めるのは作ってから7日後（3回分ずれない）", async () => {
    const { state } = await reviewed();
    let s = withAdSkipped(state, pendingAd(state)!.id, NOW);
    for (const p of pendingAdds(s)) s = withAddSkipped(s, p.id, NOW);
    const r = canPropose(s, at(DAY), settings);
    assert.equal(r.ok, false);
    assert.equal(r.ok ? "" : r.nextAt, at(settings.oncePerDays * DAY));
    // 上限の間は、新しい行をどれも入れない
    const blocked = withReview(s, { adds: [{ id: "z", no: SHUKUMOU.no, reason: "理由です。", checks: [] }] }, table, { nowIso: at(DAY), mode: "script" }, settings);
    assert.equal(blocked, s);
  });
});

describe("足す案は ToDo・判定・戻す案・報告・LINE・会議に入らない", () => {
  test("足すの承認では ToDo を作らず、効いたかの判定と戻す案の対象にしない", async () => {
    const { state } = await reviewed();
    let s = withAdSkipped(state, pendingAd(state)!.id, NOW);
    const p = pendingAdds(s)[0];
    s = approveAdd(s, p.id, { nowIso: NOW, table: tableOf(report, settings, s), words, settings }).ads;
    const book = emptyBook(TODAY);
    assert.equal(s.applied.length, 0, "止めた・外した言葉（判定の元）には入れない");
    assert.deepEqual(waitingJudge(s, book, shop, settings), []);
    assert.deepEqual(dueToJudge(s, book, { shop, today: "2027-01-31", settings }), []);
    assert.equal(pendingRevert(s), null);
    // approveAdd は台帳（ToDo）を受け取らない＝ ToDo を足せない形
    assert.equal(approveAdd.length, 3);
  });

  test("毎週の見直しの報告は止める・外すの案だけを見る（足す案は載せない）", async () => {
    const { state, res, id } = await reviewed();
    assert.ok(res.ok);
    const r = buildWeeklyReport({ id: "rp", nowIso: NOW, today: TODAY, table, shop, settings, mode: "script", proposal: { ...res.proposal, id } });
    assert.doesNotMatch(JSON.stringify(r), /縮毛矯正 くせ毛 ひどい|ヘッドスパ 眠れる/);
    assert.equal(pendingAdds(state).length, 2);
  });

  test("LINE に足すの行を送らない・LINE のボタンは足すの行を拾わない", async () => {
    const { state } = await reviewed();
    const ids = lineApprovalIds([], state);
    assert.deepEqual(ids, [pendingAd(state)!.id]);
    const onlyAdds = withAdSkipped(state, pendingAd(state)!.id, NOW);
    assert.deepEqual(lineApprovalIds([], onlyAdds), []);
    const book = emptyBook(TODAY);
    for (const how of ["approve", "skip"] as const) {
      const out = applyPress({ id: "e", at: NOW, kind: "press", approvalId: pendingAdds(onlyAdds)[0].id, target: "ad", how }, book, onlyAdds, {
        shop,
        menus,
        customers: [],
        nowIso: NOW,
        today: TODAY,
        adSettings: settings,
      });
      assert.equal(out.ads, onlyAdds, "何も変えない");
      assert.equal(out.reply, LINE_TEXT.decidedAd);
    }
    const src = readFileSync("src/components/LineBridge.tsx", "utf8");
    assert.equal((src.match(/lineApprovalIds\(/g) ?? []).length, 2, "送る行を選ぶ所は2つとも lineApprovalIds");
  });

  test("AI のチームの会議は足すの行に付けない", async () => {
    const { state } = await reviewed();
    const onlyAdds = withAdSkipped(state, pendingAd(state)!.id, NOW);
    assert.equal(canMeet(pendingAd(onlyAdds)), false);
    const row = readFileSync("src/components/AdAddRow.tsx", "utf8");
    assert.doesNotMatch(row, /AdTeam/);
  });
});

describe("ブラウザに残す形", () => {
  test("足すの行・足す用の印・足した行・反映済みの印を読み直しても落ちない", async () => {
    const { state } = await reviewed();
    const p = pendingAdds(state)[0];
    let s = approveAdd(state, p.id, { nowIso: NOW, table: tableOf(report, settings, state), words, settings }).ads;
    s = withAddSkipped(s, pendingAdds(s)[0].id, NOW);
    s = approveAd(s, emptyBook(TODAY), pendingAd(s)!.id, { nowIso: NOW, today: TODAY, shop, settings }).ads;
    s = { ...s, proposals: s.proposals.map((x) => ({ ...x, realAt: NOW })), adds: s.adds!.map((x) => ({ ...x, realAt: NOW })) };
    const back = parseAds(JSON.stringify(s));
    assert.deepEqual(back, s);
    assert.equal(back.adds?.length, 2);
    assert.equal(back.added?.length, 1);
    assert.ok(back.adds![0].checks.length === 4);
    assert.equal(isEmptyAds(back), false);
    // 形のおかしい足すの行・印は落とす
    const bad = parseAds(JSON.stringify({ ...s, adds: [{ id: 1 }, { ...s.adds![0], checks: [{ id: "nope", label: "x", ok: true }] }], added: [{ no: "x" }] }));
    assert.equal(bad.adds?.length, 1);
    assert.deepEqual(bad.adds![0].checks, []);
    assert.equal(bad.added, undefined);
  });

  test("足すの行だけでもブラウザから消さない・「最初に戻す」で全部消える", async () => {
    const { state } = await reviewed();
    const onlyAdds: AdsState = { v: 1, proposals: [], applied: [], adds: state.adds };
    assert.equal(isEmptyAds(onlyAdds), false);
    assert.deepEqual(resetAds(emptyBook(TODAY)).ads, EMPTY_ADS);
    assert.equal(resetAllWrites(TODAY).find((x) => x.key === ADS_KEY)?.value, null);
    for (const f of ["src/lib/ads/useAds.ts", "src/lib/jobs/browserStore.ts"]) assert.match(readFileSync(f, "utf8"), /isEmptyAds\(next\)/, f);
  });

  test("ホームの「AI の仕事」の結果「承認待ち3件」も承認の箱へのリンク", () => {
    assert.deepEqual(jobDoneLink({ result: "承認待ち3件", tab: "ads" }), { kind: "approvals" });
    assert.deepEqual(jobDoneLink({ result: "案は出ませんでした（門を通らず）", tab: "ads" }), { kind: "tab", tab: "ads" });
  });
});
