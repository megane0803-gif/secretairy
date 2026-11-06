// 広告の「効いたかの判定」と「毎週の見直しの報告」：判定の3つの分かれ方・数はプログラムが入れる・報告の4行・
// 戻す案は承認の箱に入る・最初に戻すで戻る。Claude は呼ばない（決まった返事・決まった文を返す物に置きかえる）。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { approvalQueue, approvalsFor } from "../../approvals";
import { ADS_KEY } from "../../browser";
import { emptyBook, type BookState } from "../../book/state";
import { addDays, calDay } from "../../calendar";
import { getAds } from "../../data/seed";
import type { AdReport } from "../../data/types";
import { resetAllWrites } from "../../reset";
import { LOCKED_RULES } from "../../rules/locked";
import { getAdSettings, getAdsAiSettings, getAdsNoteAiSettings, getShop } from "../../settings";
import { adsNoteUserText, parseAdsNoteFacts, runAdsNote, type AdsNoteWriter } from "../note";
import { judgementFacts, nextNoteTarget, reportFacts } from "../noteClient";
import { buildTable, totalOf, weeklyTotals, addWeek, ZERO, type AdTable } from "../report";
import { runReview } from "../review";
import { scriptAdsModel } from "../script";
import { approveAd, EMPTY_ADS, offNos, parseAds, resetAds, withAdSkipped, withProposal, type AdsState } from "../state";
import {
  afterTotals,
  approveRevert,
  beforeTotals,
  compareWeeks,
  dueToJudge,
  judgeNumbers,
  pendingRevert,
  skipRevert,
  waitingJudge,
  withJudged,
} from "../verdict";
import { buildWeeklyReport, KEPT_WHY, reportLines, withNote, withReport } from "../weekly";
import { gateAdSentence } from "../words";
import { EMPTY_ACCOUNTING } from "../../accounting/state";
import { getBookData } from "../../book/data";
import { EMPTY_JOBS } from "../../jobs/state";
import { runJob, type JobEnv } from "../../jobs/run";
import { getRules } from "../../rules/store";
import { getJobsSettings } from "../../settings";
import { pendingAd } from "../state";

const settings = getAdSettings();
const shop = getShop();
const report = getAds();
const table = buildTable(report, settings);

/** 最初の営業日（判定日などが定休日に当たっても動くように、開いている日から始める） */
function openDay(from = "2026-11-04"): string {
  let d = from;
  for (let i = 0; i < 14 && !calDay(shop, d).open; i++) d = addDays(d, 1);
  return d;
}
const TODAY = openDay();
const NOW = `${TODAY}T01:00:00.000Z`;

const find = (no: number) => [...table.keywords, ...table.searchTerms].find((r) => r.no === no)!;

/** 番号 no の案を承認の箱に入れて、人が承認した所まで（approveAd は画面の承認ボタンと同じ変え方） */
function approved(no: number, ads: AdsState = EMPTY_ADS, book: BookState = emptyBook(TODAY), id = `ad-${no}`, t: AdTable = table) {
  const row = find(no);
  const p = { action: row.kind === "keyword" ? ("stop" as const) : ("exclude" as const), no, text: row.text, reason: "押されてお金はかかっていますが、予約につながっていません。" };
  const withP = withProposal(ads, p, t, { id, checks: [], nowIso: NOW, mode: "ai" }, { oncePerDays: 0 });
  const out = approveAd(withP, book, id, { nowIso: NOW, today: TODAY, shop, settings });
  return { ads: out.ads, book: out.book, proposal: p };
}

/** 判定日まで進めたことにして判定する（「判定日まで進める（デモ）」と同じ） */
function judgeAll(ads: AdsState, book: BookState, r: AdReport = report) {
  const items = waitingJudge(ads, book, shop, settings);
  return withJudged(ads, book, r, items, { nowIso: `${addDays(TODAY, 30)}T01:00:00.000Z`, demo: true, settings });
}

describe("効いたかの判定：3つの分かれ方（プログラム）", () => {
  test("お金が減って予約が減っていない → 効いた（10番を外した）", () => {
    const a = approved(10);
    const out = judgeAll(a.ads, a.book);
    assert.equal(out.made.length, 1);
    const j = out.made[0];
    assert.equal(j.verdict, "worked");
    assert.ok(j.after.cost < j.before.cost && j.after.bookings >= j.before.bookings);
    assert.equal(j.revert, undefined, "効いた時は戻す案を出さない");
  });

  test("予約が減った → 戻す案（5番を止めた）", () => {
    const a = approved(5);
    const j = judgeAll(a.ads, a.book).made[0];
    assert.equal(j.verdict, "revert");
    assert.ok(j.after.bookings < j.before.bookings);
    assert.equal(j.revert?.state, "pending");
  });

  test("数が少なくて分からない → まだ分からない（押された回数の少ない 15番）", () => {
    const a = approved(15);
    const j = judgeAll(a.ads, a.book).made[0];
    assert.equal(j.verdict, "unknown");
    assert.ok(j.word.clicks < settings.judge.minWordClicks);
    assert.equal(j.revert, undefined);
  });

  test("決まり：後の数が無い・予約が少ない・お金が減っていない → まだ分からない。数が少ない時は予約が減っても戻す案にしない", () => {
    const rule = settings.judge;
    const big = { clicks: 100, cost: 5000, bookings: 9 };
    assert.equal(judgeNumbers({ before: big, after: null, word: big, action: "stop" }, rule).verdict, "unknown");
    assert.equal(judgeNumbers({ before: { ...big, bookings: 2 }, after: { ...big, bookings: 1 }, word: big, action: "stop" }, rule).verdict, "unknown");
    assert.equal(judgeNumbers({ before: big, after: { ...big, cost: 5000 }, word: big, action: "stop" }, rule).verdict, "unknown");
    assert.equal(judgeNumbers({ before: big, after: { ...big, bookings: 3 }, word: { ...big, clicks: rule.minWordClicks - 1 }, action: "stop" }, rule).verdict, "unknown");
    assert.equal(judgeNumbers({ before: big, after: { ...big, bookings: 8 }, word: big, action: "exclude" }, rule).verdict, "revert");
    assert.equal(judgeNumbers({ before: big, after: { ...big, cost: 4000 }, word: big, action: "exclude" }, rule).verdict, "worked");
  });

  test("後の数（架空）は、外せる・止められる言葉みんなにある（町の名前の言葉は外さないので無い）。週の数は判定日までの週", () => {
    const n = compareWeeks(settings);
    assert.equal(n, 3);
    for (const r of [...table.keywords, ...table.searchTerms]) {
      const town = settings.towns.some((t) => r.text.includes(t));
      assert.equal(afterTotals(report, r.no, n) !== null, !town, `${r.no}番`);
    }
  });
});

describe("判定日・ToDo・日誌", () => {
  test("判定日（ToDo の期限）より前は判定しない。判定日が来たら判定し、ToDo の判定日の行を済みにする", () => {
    const a = approved(3);
    const todo = a.book.todos.find((t) => t.id === "td-ad-ad-3")!;
    assert.ok(todo && todo.due && !todo.done);
    assert.equal(dueToJudge(a.ads, a.book, { shop, today: addDays(todo.due!, -1), settings }).length, 0, "判定日の前の日はまだ");
    const due = dueToJudge(a.ads, a.book, { shop, today: todo.due!, settings });
    assert.equal(due.length, 1);
    const out = withJudged(a.ads, a.book, report, due, { nowIso: NOW, demo: false, settings });
    assert.equal(out.made[0].due, todo.due);
    assert.equal(out.made[0].demo, false);
    assert.equal(out.book.todos.find((t) => t.id === todo.id)?.done, true, "判定日の行を済みに");
    assert.ok(out.journal.some((l) => l.who === "プログラム" && l.text.startsWith("判定：") && l.text.includes("3番")), "日誌に判定");
    assert.ok(out.journal.some((l) => l.text.includes(`ToDo「${todo.title}」を済みにした`)));
    // 2回は判定しない
    const again = withJudged(out.ads, out.book, report, waitingJudge(out.ads, out.book, shop, settings), { nowIso: NOW, demo: false, settings });
    assert.equal(again.made.length, 0);
    assert.equal(again.ads, out.ads);
  });

  test("判定そのものは止めた言葉を変えない（戻すのは人の承認だけ）", () => {
    const a = approved(5);
    const out = judgeAll(a.ads, a.book);
    assert.deepEqual(offNos(out.ads), [5]);
  });
});

describe("数はプログラムが入れる", () => {
  test("判定の前と後の数は、最初の状態（seed/ads.json）の表から出した数そのまま", () => {
    const a = approved(10);
    const j = judgeAll(a.ads, a.book).made[0];
    const n = compareWeeks(settings);
    const before = report.keywords.flatMap((k) => k.weeks.slice(-n)).reduce(addWeek, ZERO);
    assert.deepEqual(j.before, before);
    assert.deepEqual(j.before, beforeTotals(report, n));
    assert.deepEqual(j.after, report.after!.find((x) => x.no === 10)!.weeks.reduce(addWeek, ZERO));
  });

  test("報告の「見た数字」は、表の広告を出す言葉の4週の合計（押された523回・28,080円・予約12件）", () => {
    const r = buildWeeklyReport({ id: "rp1", nowIso: NOW, today: TODAY, table, shop, settings, mode: "ai" });
    assert.deepEqual(r.seen, weeklyTotals(table.keywords).reduce(addWeek, ZERO));
    assert.deepEqual(r.seen, { clicks: 523, cost: 28080, bookings: 12 });
    assert.equal(r.weeks, 4);
    assert.equal(r.to, addDays(TODAY, -1));
    assert.equal(r.from, addDays(TODAY, -28));
  });

  test("AI の案の理由に数字があれば、報告には載せない（言葉の門）。だれかを責める言葉・英字も載せない", () => {
    assert.equal(gateAdSentence("押されてお金はかかっていますが、予約につながっていません。", settings.gateWords).ok, true);
    assert.equal(gateAdSentence("先月は3件しか予約がありません。", settings.gateWords).ok, false);
    assert.equal(gateAdSentence("三件しか予約がありません。", settings.gateWords).ok, false, "漢数字も");
    assert.equal(gateAdSentence("前の設定が失敗でした。", settings.gateWords).ok, false, "責める言い方");
    assert.equal(gateAdSentence("Search広告より安く済みます。", settings.gateWords).ok, false, "サービスの名前（英字）");
    const r = buildWeeklyReport({
      id: "rp2",
      nowIso: NOW,
      today: TODAY,
      table,
      shop,
      settings,
      mode: "ai",
      proposal: { id: "ad-x", action: "stop", no: 3, text: find(3).text, reason: "業者のせいで予約がありません。" },
    });
    assert.equal(r.proposal?.reason, undefined);
    assert.ok(r.proposal?.reasonHidden);
  });

  test("一言のまとめ（Haiku）：送る事実に数字が無い。数字・使わない言葉の入った一言は出さない。通った一言だけ出す", async () => {
    const a = approved(10);
    const j = judgeAll(a.ads, a.book).made[0];
    const facts = judgementFacts(j);
    assert.doesNotMatch(JSON.stringify(facts), /\d/);
    assert.doesNotMatch(adsNoteUserText(facts), /\d/);
    const lim = { maxTokens: getAdsNoteAiSettings().maxReplyTokens, maxNoteChars: getAdsNoteAiSettings().maxNoteChars, gateWords: settings.gateWords };
    const say = (text: string): AdsNoteWriter => ({ async write() { return { text, stop: "end" }; } });
    assert.equal((await runAdsNote(facts, say("お金が２割減りました。"), lim)).ok, false, "数字は出さない");
    assert.equal((await runAdsNote(facts, say("必ず続けましょう。"), lim)).ok, false, "言い切りは出さない");
    const ok = await runAdsNote(facts, say("この調子で、次の見直しも同じ所を見てみましょう。"), lim);
    assert.deepEqual(ok, { ok: true, note: "この調子で、次の見直しも同じ所を見てみましょう。" });
    const refused: AdsNoteWriter = { async write() { return { text: "", stop: "refusal" }; } };
    assert.equal((await runAdsNote(facts, refused, lim)).ok, false);
    // 窓口が受ける形
    assert.equal(parseAdsNoteFacts({ facts }).ok, true);
    assert.equal(parseAdsNoteFacts({ facts: { kind: "x" } }).ok, false);
  });

  test("一言は AI で作った案の物だけに1回だけ頼む（決まった返事の物・承認待ちの報告には頼まない）", () => {
    const a = approved(10);
    const out = judgeAll(a.ads, a.book);
    const t = nextNoteTarget(out.ads);
    assert.equal(t?.kind, "judgement");
    const tried = withNote(out.ads, "judgement", t!.item.id, null);
    assert.equal(nextNoteTarget(tried), null);
    const withN = withNote(tried, "judgement", t!.item.id, "続けて様子を見ましょう。");
    assert.equal(withN.judgements?.[0].note, "続けて様子を見ましょう。");
    // 承認待ちの報告には頼まない
    const p = { action: "stop" as const, no: 3, text: find(3).text, reason: "予約につながっていません。" };
    let s = withProposal(EMPTY_ADS, p, table, { id: "ad-p", checks: [], nowIso: NOW, mode: "ai" }, settings);
    s = withReport(s, buildWeeklyReport({ id: "rp-p", nowIso: NOW, today: TODAY, table, shop, settings, mode: "ai", proposal: { ...p, id: "ad-p" } }), settings);
    assert.equal(nextNoteTarget(s), null);
    assert.equal(reportFacts(s.reports![0], s).kind, "report");
    s = withAdSkipped(s, "ad-p", NOW);
    assert.equal(nextNoteTarget(s)?.kind, "report");
    const script = { ...s, reports: s.reports!.map((r) => ({ ...r, mode: "script" as const })) };
    assert.equal(nextNoteTarget(script), null);
  });
});

describe("毎週の見直しの報告：4行", () => {
  test("決まった返事の見直し：9番（町の名前）は門で弾かれて「止めなかった言葉」に理由つきで出る。4行がそろう", async () => {
    const res = await runReview({ table, rules: LOCKED_RULES, settings, model: scriptAdsModel(table), maxTokens: 600, maxTries: getAdsAiSettings().maxTries });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(res.rejected?.map((x) => x.no), [9]);
    const id = "ad-s";
    let s = withProposal(EMPTY_ADS, res.proposal, table, { id, checks: res.checks, nowIso: NOW, mode: "script" }, settings);
    const r = buildWeeklyReport({ id: "rp-s", nowIso: NOW, today: TODAY, table, shop, settings, mode: "script", proposal: { ...res.proposal, id }, rejected: res.rejected });
    s = withReport(s, r, settings);
    assert.equal(r.kept[0].no, 9);
    assert.equal(r.kept[0].why, KEPT_WHY.town);
    assert.ok(r.kept.length <= settings.report.maxKeptWords);
    assert.ok(!r.kept.some((k) => k.no === res.proposal.no), "止めた言葉は ③ に出さない");
    assert.ok(r.kept.every((k) => totalOf(find(k.no)).bookings === 0 || k.no === 9));

    const book = emptyBook(TODAY);
    let lines = reportLines(r, s, book, shop, settings);
    assert.match(lines.seen, /押された 523回・お金 28,080円・予約 12件/);
    assert.match(lines.changed, /^承認待ち：/);
    assert.equal(lines.changedReason, `理由（AI）：${res.proposal.reason}`);
    assert.ok(lines.kept.length >= 2);
    assert.match(lines.kept[0], /9番「もちの木町 美容室」：町の名前の言葉は/);
    assert.match(lines.next, new RegExp(`^次の見直し：${calDay(shop, r.next).label.replace(/[()（）]/g, ".")}から$`));

    // 承認すると ② は「外した」、④ に判定日
    const out = approveAd(s, book, id, { nowIso: NOW, today: TODAY, shop, settings });
    lines = reportLines(r, out.ads, out.book, shop, settings);
    assert.match(lines.changed, new RegExp(`^外した：${res.proposal.no}番`));
    const due = out.book.todos.find((t) => t.id === `td-ad-${id}`)!.due!;
    assert.ok(lines.next.endsWith(`効いたかの判定：${calDay(shop, due).label}`));

    // 見送りなら ② は「なし」
    lines = reportLines(r, withAdSkipped(s, id, NOW), book, shop, settings);
    assert.match(lines.changed, /^なし（.*見送った）$/);
  });

  test("案が出なかった見直しも1枚残す（② はなし）。報告は新しい順で、前の週の物も残る（listCount 枚まで）", () => {
    let s = EMPTY_ADS;
    for (let i = 0; i < settings.report.listCount + 2; i++)
      s = withReport(s, buildWeeklyReport({ id: `rp-${i}`, nowIso: NOW, today: addDays(TODAY, i * 7), table, shop, settings, mode: "ai", failed: "案は出ませんでした" }), settings);
    assert.equal(s.reports?.length, settings.report.listCount);
    assert.equal(s.reports?.[0].id, `rp-${settings.report.listCount + 1}`, "新しい順");
    const lines = reportLines(s.reports![0], s, emptyBook(TODAY), shop, settings);
    assert.equal(lines.changed, "なし（案は出ませんでした）");
    assert.equal(withReport(s, s.reports![0], settings), s, "同じ報告は2回入れない");
  });
});

describe("AI の仕事の「広告の見直し」も報告を1枚残す", () => {
  test("決まった返事で動かすと、承認の箱に1行・報告に1枚（AI の仕事からの札）", async () => {
    let ads: AdsState = EMPTY_ADS;
    let book = emptyBook(TODAY);
    const env: JobEnv = {
      data: getBookData(),
      rules: getRules(),
      mode: "script",
      store: {
        book: () => book,
        setBook: (f) => void (book = f(book)),
        ads: () => ads,
        setAds: (f) => void (ads = f(ads)),
        accounting: () => EMPTY_ACCOUNTING,
        jobs: () => EMPTY_JOBS,
        setJobs: () => {},
      },
      ask: {
        reserve: async () => [],
        todo: async () => ({ ok: false, code: "no-ai", message: "" }),
        ads: async (body) => {
          const r = await runReview({ table: body.table, rules: LOCKED_RULES, settings, model: scriptAdsModel(body.table), maxTokens: 600, maxTries: getAdsAiSettings().maxTries });
          return r.ok ? r : { ...r, code: "gate" };
        },
      },
      journal: () => {},
      now: () => new Date(NOW),
      adSettings: settings,
      newId: () => "ad-job-1",
    };
    const r = await runJob("ads", env, { left: getJobsSettings().maxAiCallsPerPress });
    assert.equal(r.kind, "done");
    assert.equal(pendingAd(ads)?.id, "ad-job-1");
    assert.equal(ads.reports?.length, 1);
    assert.equal(ads.reports?.[0].proposalId, "ad-job-1");
    assert.equal(ads.reports?.[0].fromJobs, true);
    assert.equal(ads.reports?.[0].kept[0].no, 9, "門で弾かれた町の名前の言葉");
  });
});

describe("戻す案は承認の箱に入る", () => {
  test("戻す案は承認の箱の行（上の帯・朝の要点の数にも入る）。予約タブには出さない。広告の新しい案は止めない", () => {
    const a = approved(5);
    const out = judgeAll(a.ads, a.book);
    const q = approvalQueue(out.book, out.ads, NOW);
    assert.equal(q.adRevert?.id, out.made[0].id);
    assert.equal(q.ad, null);
    assert.equal(q.count, 1);
    assert.equal(approvalsFor(q, "all").adRevert?.id, out.made[0].id);
    assert.equal(approvalsFor(q, "reservations").adRevert, undefined);
    assert.equal(approvalsFor(q, "reservations").count, 0);
    assert.equal(pendingRevert(out.ads)?.no, 5);
  });

  test("承認（人のボタン）で元に戻る：止めた言葉から外れて、また選べる。見送りなら止めたまま。どちらも行は消える", () => {
    const a = approved(5);
    const out = judgeAll(a.ads, a.book);
    const id = out.made[0].id;
    const yes = approveRevert(out.ads, id, NOW, settings.channel);
    assert.deepEqual(offNos(yes.ads), []);
    assert.equal(yes.ads.judgements?.[0].revert?.state, "approved");
    assert.equal(pendingRevert(yes.ads), null);
    assert.equal(approvalQueue(out.book, yes.ads, NOW).count, 0);
    assert.ok(yes.journal[0].who === "オーナー" && yes.journal[0].text.startsWith("承認："));
    assert.equal(buildTable(report, settings, offNos(yes.ads)).keywords.find((r) => r.no === 5)?.off, false, "また選べる");
    // 2回目は何もしない
    assert.equal(approveRevert(yes.ads, id, NOW, settings.channel).ads, yes.ads);

    const no = skipRevert(out.ads, id, NOW);
    assert.deepEqual(offNos(no.ads), [5]);
    assert.equal(no.ads.judgements?.[0].revert?.state, "skipped");
    assert.equal(pendingRevert(no.ads), null);
  });

  test("戻したあとにまた止めて承認したら、その案はまた判定する（前の判定は残る）", () => {
    const a = approved(5);
    const out = judgeAll(a.ads, a.book);
    const yes = approveRevert(out.ads, out.made[0].id, NOW, settings.channel);
    const t2 = buildTable(report, settings, offNos(yes.ads));
    const b = approved(5, yes.ads, out.book, "ad-5b", t2);
    assert.equal(waitingJudge(b.ads, b.book, shop, settings).length, 1);
    const again = judgeAll(b.ads, b.book);
    assert.equal(again.ads.judgements?.length, 2);
  });
});

describe("最初に戻すで戻る", () => {
  test("広告を最初に戻す：判定・報告・戻す案も消え、広告から足した ToDo も消える", () => {
    const a = approved(5);
    let out = judgeAll(a.ads, a.book);
    out = { ...out, ads: withReport(out.ads, buildWeeklyReport({ id: "rp", nowIso: NOW, today: TODAY, table, shop, settings, mode: "ai", failed: "x" }), settings) };
    assert.ok(out.ads.judgements?.length && out.ads.reports?.length);
    const r = resetAds(out.book);
    assert.deepEqual(r.ads, EMPTY_ADS);
    assert.equal(r.book.todos.filter((t) => t.id.startsWith("td-ad-")).length, 0);
    assert.equal(approvalQueue(r.book, r.ads, NOW).count, 0);
  });

  test("ホームの「最初に戻す」は secretairy:ads を消す（判定・報告もいっしょに）", () => {
    const w = resetAllWrites(TODAY);
    assert.equal(w.find((x) => x.key === ADS_KEY)?.value, null);
    assert.deepEqual(parseAds(null), EMPTY_ADS);
  });

  test("ブラウザに残した判定・報告は読みなおしても同じ。形のおかしい物は落とす", () => {
    const a = approved(5);
    let s = judgeAll(a.ads, a.book).ads;
    s = withReport(s, buildWeeklyReport({ id: "rp", nowIso: NOW, today: TODAY, table, shop, settings, mode: "ai", proposal: { id: "ad-5", ...a.proposal } }), settings);
    assert.deepEqual(parseAds(JSON.stringify(s)), s);
    const bad = parseAds(JSON.stringify({ ...s, judgements: [{ id: 1 }], reports: [{ id: "x" }] }));
    assert.equal(bad.judgements, undefined);
    assert.equal(bad.reports, undefined);
  });
});
