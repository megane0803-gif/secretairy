// 広告の案の「AI のチーム」の会議（docs/SPEC.md §1.7.4）。Claude は呼ばず、決まった返事（team/script.ts）か、決まった答えを返す物に置きかえる。
// 確かめの順：AI なしで最後まで通す → 分身と野党を別々に呼び、補佐がまとめる → 過去が0件の時・野党が欠けた時・「直す」とぶつかった時。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NoAiError } from "../../ai/model";
import { emptyBook } from "../../book/state";
import { calDay } from "../../calendar";
import { getAds } from "../../data/seed";
import { LOCKED_INSTRUCTIONS } from "../../rules/prompt";
import { LOCKED_RULES } from "../../rules/locked";
import { getAdSettings, getAdsAiSettings, getAdsTeamAiSettings, getMenus, getShop } from "../../settings";
import { buildTable, type AdTable } from "../report";
import { runReview } from "../review";
import { scriptAdsModel } from "../script";
import { approveAd, parseAds, pendingAd, withAdFixed, withAdSkipped, withProposal, EMPTY_ADS, type AdsState } from "../state";
import { checkDraft } from "../gate";
import { gateTeamText } from "../team/gate";
import { buildWeeklyReport } from "../weekly";
import { gateAdSentence } from "../words";
import { meet } from "../team/meet";
import { materialText, pastDecisions, research, snapshotOf } from "../team/research";
import { runTeam, type TeamInput, type TeamWriteRequest, type TeamWriteResult, type TeamWriter } from "../team/run";
import { scriptTeamWriter } from "../team/script";
import {
  canMeet,
  regateResult,
  shownTeam,
  teamDecisionLine,
  teamJournal,
  withTeamResult,
  withTeamStarted,
} from "../team/state";
import type { TeamResult } from "../team/types";
import { parseTeamRequest } from "../team/wire";
import { applyPress } from "../../line/apply";

const settings = getAdSettings();
const shop = getShop();
const report = getAds();
const table = buildTable(report, settings);
const team = getAdsTeamAiSettings();
const limits = { maxTokens: team.maxReplyTokens, maxCalls: team.maxCalls, maxTwinChars: team.maxTwinChars, maxLineChars: team.maxLineChars, gateWords: settings.gateWords };
const ANCHOR = "2026-11-05";
const NOW = "2026-11-05T01:00:00.000Z";

/** AI なしの見直しで出る案（1回目は町の名前の言葉で門に弾かれ、作り直しで「美容院 安い 学生」を外す案）を承認BOXに入れる */
async function scriptProposal(): Promise<AdsState> {
  const r = await runReview({
    table,
    rules: LOCKED_RULES,
    settings,
    model: scriptAdsModel(table),
    maxTokens: getAdsAiSettings().maxReplyTokens,
    maxTries: getAdsAiSettings().maxTries,
  });
  assert.ok(r.ok);
  return withProposal(EMPTY_ADS, r.proposal, table, { id: "ad-1", checks: r.checks, nowIso: NOW, mode: "script" }, settings);
}

function inputFor(s: AdsState, over: Partial<TeamInput> = {}, t: AdTable = table): TeamInput {
  const p = pendingAd(s)!;
  return {
    table: t,
    snapshot: snapshotOf(p),
    rules: LOCKED_RULES,
    past: pastDecisions(s, report.past ?? [], { shop, anchor: ANCHOR, excludeId: p.id, max: team.maxHistory }),
    judgements: [],
    towns: settings.towns,
    shop,
    ...over,
  };
}

/** 決まった答えを返す物（Claude の代わり。呼ばれた頼みを全部とっておく） */
function fakeClaude(answers: Partial<Record<TeamWriteRequest["role"], unknown>>, stop: TeamWriteResult["stop"] = "end"): TeamWriter & { seen: TeamWriteRequest[] } {
  const seen: TeamWriteRequest[] = [];
  return {
    claude: true,
    seen,
    async write(req) {
      seen.push(structuredClone(req));
      return { raw: answers[req.role] ?? null, stop };
    },
  };
}

const GOOD = {
  twin: { guess: "approve", text: "前も予約につながらない言葉から見直した。" },
  opposition: { stance: "against", risk: "外すと、値段を比べている学生にも届かなくなる。", alternative: "今回は残して次の見直しで確かめたい。" },
  aide: { adopt: "opposition", conclusion: "今回は外さずに残す考えです。", reason: "届く方が減るのを先に確かめたいからです。", next: "次の見直しで、この言葉の予約をもう一度見ます。" },
};

describe("架空の最初の状態：過去の広告の判断", () => {
  test("1〜2件。対象・止める／外す・承認か見送りか・決めた日（営業日）・その時の予約だけで、理由は持たない", () => {
    const past = report.past ?? [];
    assert.ok(past.length >= 1 && past.length <= 2);
    assert.ok(past.some((d) => d.decision === "approved" && d.action === "stop" && d.bookings === 0), "予約につながらない言葉を止めて承認した");
    for (const d of past) assert.deepEqual(Object.keys(d).sort(), ["action", "bookings", "day", "decision", "id", "text"]);
    const list = pastDecisions(EMPTY_ADS, past, { shop, anchor: ANCHOR, max: team.maxHistory });
    assert.equal(list.length, past.length);
    for (const d of list) {
      assert.ok(d.date < ANCHOR, "過去の日");
      assert.ok(calDay(shop, d.date).open, "定休日には置かない");
    }
  });

  test("広告の記録の承認・見送り（decidedAt）も入る。新しい順。今の案は入れない", () => {
    const s: AdsState = {
      ...EMPTY_ADS,
      proposals: [
        { id: "old", action: "stop", no: 7, text: "髪型 流行り", reason: "AI の理由", total: { clicks: 1, cost: 1, bookings: 0 }, checks: [], createdAt: NOW, state: "skipped", decidedAt: "2026-11-04T03:00:00.000Z", fixed: false, mode: "ai" },
        { id: "now", action: "exclude", no: 10, text: "美容院 安い 学生", reason: "x", total: { clicks: 1, cost: 1, bookings: 0 }, checks: [], createdAt: NOW, state: "pending", fixed: false, mode: "ai" },
      ],
    };
    const list = pastDecisions(s, report.past ?? [], { shop, anchor: ANCHOR, excludeId: "now", max: 8 });
    assert.equal(list[0].text, "髪型 流行り");
    assert.equal(list[0].decision, "skipped");
    assert.equal(list[0].date, "2026-11-04");
    assert.ok(!list.some((d) => d.text === "美容院 安い 学生"));
    // 理由（AI が案を出した時の理由）は持たない
    assert.ok(!JSON.stringify(list).includes("AI の理由"));
  });
});

describe("1. AI なしで最後まで通す（美容院 安い 学生）", () => {
  test("分身「前も…私なら外す」→ 野党「外すと…残して確かめたい」→ 補佐が野党を採る → 見送り → 日誌「分身の予想：外す／オーナー：残した」", async () => {
    let s = await scriptProposal();
    const p0 = pendingAd(s)!;
    assert.equal(p0.text, "美容院 安い 学生");
    assert.equal(p0.action, "exclude");
    assert.ok(canMeet(p0));

    s = withTeamStarted(s, p0.id, NOW, p0.mode);
    assert.deepEqual(pendingAd(s)!.team?.snapshot, snapshotOf(p0), "会議を始めた時の中身を印に残す");
    const result = await meet(inputFor(s), "script", () => assert.fail("決まった返事では Claude を作らない"), limits);
    assert.ok(result);
    assert.equal(result.mode, "script");
    assert.equal(result.calls, 0);
    assert.deepEqual(result.twin, { guess: "approve", text: "前も予約につながらない言葉から見直した。", noHistory: false });
    assert.deepEqual(result.opposition, { risk: "外すと、値段を比べている学生にも届かなくなる。", alternative: "今回は残して次の見直しで確かめたい。" });
    assert.equal(result.aide?.adopt, "opposition");
    assert.ok(result.aide?.conclusion && result.aide.reason && result.aide.next);
    assert.deepEqual(result.dropped, []);

    const arrived = withTeamResult(s, p0.id, NOW, result);
    assert.equal(arrived.arrival, "shown");
    s = arrived.state;
    const p1 = pendingAd(s)!;
    assert.ok(shownTeam(p1));
    // 会議は広告も承認BOXも変えない
    assert.equal(p1.state, "pending");
    assert.deepEqual(s.applied, []);

    const journal = teamJournal(p1, result).map((j) => j.text);
    assert.ok(journal[0].startsWith("リサーチャー："));
    assert.ok(journal.includes("分身（AI なし）：前も予約につながらない言葉から見直した。私なら外す"));
    assert.ok(journal.some((t) => t.startsWith("野党（AI なし）：外すと、値段を比べている学生にも届かなくなる。今回は残して次の見直しで確かめたい。")));
    assert.ok(journal.some((t) => t.startsWith("補佐（AI なし）：野党の理由を採った。")));

    // 決めるのはオーナーのボタン：見送り
    assert.equal(teamDecisionLine(p1, "skipped"), "分身の予想：外す／オーナー：残した");
    assert.equal(teamDecisionLine(p1, "approved"), "分身の予想：外す／オーナー：外した");
    s = withAdSkipped(s, p1.id, NOW);
    assert.equal(s.proposals[0].state, "skipped");
    // 決まった後はもう会議にかけない
    assert.ok(!canMeet(s.proposals[0]));
  });

  test("決まった返事の声は、材料（架空のデータ）にある事だけ：数字・日付を書かない・門を通る", async () => {
    const s = await scriptProposal();
    const result = (await runTeam(inputFor(s), scriptTeamWriter(), limits, "script"))!;
    const all = [result.twin?.text, result.opposition?.risk, result.opposition?.alternative, result.aide?.conclusion, result.aide?.reason, result.aide?.next];
    for (const t of all) {
      assert.ok(t);
      assert.doesNotMatch(t, /[0-9０-９]/);
    }
    // 野党の「値段を比べている学生」は、言葉「美容院 安い 学生」にある事から
    assert.match(result.opposition!.risk, /学生/);
  });

  test("ホームと広告タブで同じ行：印と答えはブラウザに残り、読みなおせる", async () => {
    let s = await scriptProposal();
    const p = pendingAd(s)!;
    s = withTeamStarted(s, p.id, NOW, p.mode);
    const result = (await meet(inputFor(s), "script", scriptTeamWriter, limits))!;
    s = withTeamResult(s, p.id, NOW, result).state;
    const back = parseAds(JSON.stringify(s));
    assert.deepEqual(back.proposals[0].team, s.proposals[0].team);
    assert.ok(shownTeam(back.proposals[0]));
  });

  test("LINE のボタンで見送っても、日誌に「分身の予想：外す／オーナー：残した」", async () => {
    let s = await scriptProposal();
    const p = pendingAd(s)!;
    s = withTeamStarted(s, p.id, NOW, p.mode);
    s = withTeamResult(s, p.id, NOW, (await meet(inputFor(s), "script", scriptTeamWriter, limits))!).state;
    const out = applyPress({ id: "e1", at: NOW, kind: "press", approvalId: p.id, target: "ad", how: "skip" }, emptyBook(ANCHOR), s, {
      nowIso: NOW,
      today: ANCHOR,
      shop,
      adSettings: settings,
      menus: getMenus(),
      customers: [],
    });
    assert.ok(out.journal.some((j) => j.text === "分身の予想：外す／オーナー：残した"));
  });

  test("承認（画面のボタン）の後も、同じ形の1行", async () => {
    let s = await scriptProposal();
    const p = pendingAd(s)!;
    s = withTeamStarted(s, p.id, NOW, p.mode);
    s = withTeamResult(s, p.id, NOW, (await meet(inputFor(s), "script", scriptTeamWriter, limits))!).state;
    const decided = pendingAd(s)!;
    assert.equal(teamDecisionLine(decided, "approved"), "分身の予想：外す／オーナー：外した");
    const out = approveAd(s, emptyBook(ANCHOR), decided.id, { nowIso: NOW, today: ANCHOR, shop, settings });
    assert.equal(out.ads.proposals[0].state, "approved");
  });
});

describe("2. 分身と野党を別々に呼び、補佐がまとめる", () => {
  test("分身と野党は同じ材料を別々に読む（おたがいの答えは見ない）。補佐は門を通った2つだけを読む。呼ぶのは3回", async () => {
    const s = await scriptProposal();
    const w = fakeClaude(GOOD);
    const r = (await runTeam(inputFor(s), w, limits, "ai"))!;
    assert.equal(r.calls, 3);
    assert.deepEqual(w.seen.map((x) => x.role).sort(), ["aide", "opposition", "twin"]);
    const twin = w.seen.find((x) => x.role === "twin")!;
    const opp = w.seen.find((x) => x.role === "opposition")!;
    const aide = w.seen.find((x) => x.role === "aide")!;
    // 同じ材料（リサーチャーの数・前の判断）
    const material = twin.user.replace(/\n\n[^\n]*$/, "");
    assert.equal(opp.user.replace(/\n\n[^\n]*$/, ""), material);
    assert.match(material, /押された/);
    assert.match(material, /美容室 深夜/);
    // おたがいの答えは見ない
    assert.ok(!twin.user.includes(GOOD.opposition.risk) && !twin.system.includes(GOOD.opposition.risk));
    assert.ok(!opp.user.includes(GOOD.twin.text) && !opp.system.includes(GOOD.twin.text));
    // 補佐は2つだけ（材料の数や前の判断は読まない）
    assert.ok(aide.user.includes(GOOD.twin.text) && aide.user.includes(GOOD.opposition.risk) && aide.user.includes(GOOD.opposition.alternative));
    assert.doesNotMatch(aide.user, /押された|美容室 深夜|円/);
    assert.equal(r.aide?.adopt, "opposition");
    assert.equal(r.aide?.conclusion, GOOD.aide.conclusion);
  });

  test("Claude を呼ぶのは1回の会議で3回まで（config の adsTeam.maxCalls）。作り直しはしない", async () => {
    assert.equal(team.maxCalls, 3);
    const s = await scriptProposal();
    // 野党の答えが門に当たっても、作り直しで呼ばない
    const w = fakeClaude({ ...GOOD, opposition: { stance: "against", risk: "外すと、学生が3割減る。", alternative: "今回は残して次の見直しで確かめたい。" } });
    const r = (await runTeam(inputFor(s), w, limits, "ai"))!;
    assert.equal(w.seen.length, 3);
    assert.equal(r.opposition, null);
    // 上限を小さくすると、それより多くは呼ばない
    const w2 = fakeClaude(GOOD);
    const r2 = (await runTeam(inputFor(s), w2, { ...limits, maxCalls: 2 }, "ai"))!;
    assert.equal(w2.seen.length, 2);
    assert.equal(r2.aide, null);
    assert.ok(r2.dropped.some((d) => d.role === "aide" && d.problems[0].includes("上限")));
  });

  test("🔒 指示の先頭は鍵つきの2つ（どの役も）。道具は渡さない", async () => {
    const s = await scriptProposal();
    const w = fakeClaude(GOOD);
    await runTeam(inputFor(s), w, limits, "ai");
    for (const req of w.seen) {
      assert.ok(req.system.startsWith("# いつも守ること（🔒 鍵つき。ほかのどの決まりよりも先）"));
      for (const t of LOCKED_INSTRUCTIONS) assert.ok(req.system.includes(t));
      assert.ok(!("tools" in req));
      assert.match(req.system, /決めるのはいつもオーナーのボタン/);
    }
  });

  test("AI につながらない時は、決まった返事の声で最後まで（画面には「AI なし」）", async () => {
    const s = await scriptProposal();
    const r = (await meet(
      inputFor(s),
      "ai",
      () => {
        throw new NoAiError("鍵がありません");
      },
      limits,
    ))!;
    assert.equal(r.mode, "script");
    assert.equal(r.noAi, true);
    assert.ok(r.twin && r.opposition && r.aide);
    // 途中でつながらなくなった時も、Claude の答えはまぜない
    const half: TeamWriter = {
      claude: true,
      async write(req) {
        if (req.role === "opposition") throw new NoAiError("止まっています");
        return { raw: { guess: "skip", text: "ちがう答え。" }, stop: "end" };
      },
    };
    const r2 = (await meet(inputFor(s), "ai", () => half, limits))!;
    assert.equal(r2.mode, "script");
    assert.notEqual(r2.twin?.text, "ちがう答え。");
  });

  test("窓口の形：案の言葉は表から入れる・表に無い案は受けない・鍵つきはサーバーで先頭に足しなおす", () => {
    const fake = { id: "locked-human-confirms", level: "global", label: "AI が確定してよい", check: { kind: "text" }, locked: true };
    const body = { mode: "ai", proposal: { action: "exclude", no: 10, reason: "理由。" }, table, rules: [fake], judgements: [], past: [] };
    const ok = parseTeamRequest(body, getMenus().map((m) => m.id), team.maxHistory);
    assert.ok(ok.ok);
    assert.equal(ok.value.snapshot.text, "美容院 安い 学生");
    assert.deepEqual(ok.value.rules.slice(0, 2), LOCKED_RULES);
    assert.ok(!ok.value.rules.some((r) => r.label === "AI が確定してよい"));
    assert.equal(parseTeamRequest({ ...body, proposal: { action: "stop", no: 10, reason: "x" } }, [], 8).ok, false, "止める・外すが合わない");
    assert.equal(parseTeamRequest({ ...body, proposal: { action: "exclude", no: 99, reason: "x" } }, [], 8).ok, false, "表に無い");
  });

  test("画面でも、受け取った答えをもう一度同じ門に通す（通らない欄は出さない）", async () => {
    const s = await scriptProposal();
    const inp = inputFor(s);
    const r = (await runTeam(inp, fakeClaude(GOOD), limits, "ai"))!;
    const bad: TeamResult = { ...r, opposition: { risk: "外すと必ず減ります。", alternative: r.opposition!.alternative } };
    const rs = research(table, inp.snapshot, [], settings.towns)!;
    const again = regateResult(bad, { material: materialText(rs, inp.snapshot, inp.past, shop), noHistory: false, limits });
    assert.equal(again.opposition, null);
    assert.ok(again.twin);
  });
});

describe("3. 過去が0件の時・野党が欠けた時・「直す」とぶつかった時", () => {
  test("過去が0件：「過去の判断はまだありません」と出し、ルールだけで言う（過去の話をした答えは出さない）", async () => {
    const s = await scriptProposal();
    const inp = inputFor(s, { past: [] });
    const r = (await runTeam(inp, scriptTeamWriter(), limits, "script"))!;
    assert.equal(r.twin?.noHistory, true);
    assert.doesNotMatch(r.twin!.text, /前|いつも|過去/);
    const j = teamJournal(pendingAd(s)!, r).find((x) => x.text.startsWith("分身"))!;
    assert.match(j.text, /^分身（AI なし）：過去の判断はまだありません。/);
    // Claude が過去の話をしたら出さない
    const w = fakeClaude({ ...GOOD });
    const r2 = (await runTeam(inp, w, limits, "ai"))!;
    assert.equal(r2.twin, null);
    assert.ok(r2.dropped.some((d) => d.role === "twin" && d.problems[0].includes("過去")));
    // 分身に渡す材料にも「まだありません」
    assert.match(w.seen.find((x) => x.role === "twin")!.user, /過去の判断はまだありません/);
  });

  test("野党が欠けた時（片方が空・賛成の言いかえ・stance が agree）は出さず、「反対意見を確かめられませんでした」。補佐は分身を採る", async () => {
    const s = await scriptProposal();
    const cases = [
      { stance: "against", risk: "外すと、値段を比べている学生にも届かなくなる。", alternative: "" },
      { stance: "against", risk: "", alternative: "今回は残して次の見直しで確かめたい。" },
      { stance: "against", risk: "特に危ない所はありません。", alternative: "案のとおり外すのがよいです。" },
      { stance: "against", risk: "届く方が少し減る。", alternative: "この言葉を外すのがよい。" },
      { stance: "agree", risk: "届く方が少し減る。", alternative: "今回は残して次の見直しで確かめたい。" },
    ];
    for (const opposition of cases) {
      const w = fakeClaude({ ...GOOD, opposition, aide: { ...GOOD.aide, adopt: "twin" } });
      const r = (await runTeam(inputFor(s), w, limits, "ai"))!;
      assert.equal(r.opposition, null, JSON.stringify(opposition));
      assert.equal(r.aide?.adopt, "twin");
      // 補佐には「確かめられませんでした」だけが渡る
      const aide = w.seen.find((x) => x.role === "aide")!;
      assert.match(aide.user, /反対意見を確かめられませんでした/);
      if (opposition.risk) assert.ok(!aide.user.includes(opposition.risk));
      const line = teamJournal(pendingAd(s)!, r).find((x) => x.text.startsWith("野党"))!;
      assert.equal(line.text, "野党：反対意見を確かめられませんでした");
    }
    // 補佐が、確かめられなかった野党を採ったら出さない
    const w = fakeClaude({ ...GOOD, opposition: { stance: "against", risk: "", alternative: "" } });
    const r = (await runTeam(inputFor(s), w, limits, "ai"))!;
    assert.equal(r.aide, null);
  });

  test("分身も野党も確かめられない時は、補佐を呼ばない", async () => {
    const s = await scriptProposal();
    const w = fakeClaude({}, "refusal");
    const r = (await runTeam(inputFor(s), w, limits, "ai"))!;
    assert.equal(w.seen.length, 2);
    assert.equal(r.twin, null);
    assert.equal(r.opposition, null);
    assert.equal(r.aide, null);
  });

  test("「直す」とぶつかった時：会議の間に案が変わったら答えは出さない。会議はもうかけない", async () => {
    let s = await scriptProposal();
    const p = pendingAd(s)!;
    s = withTeamStarted(s, p.id, NOW, p.mode);
    const result = (await meet(inputFor(s), "script", scriptTeamWriter, limits))!;
    // 会議の間に「直す」で 12番を外す案に変わった
    s = withAdFixed(s, p.id, { action: "exclude", no: 12, text: "髪型 流行り 芸能人", reason: "オーナーの一言に合わせて出しなおしました。" }, table, p.checks);
    const out = withTeamResult(s, p.id, NOW, result);
    assert.equal(out.arrival, "changed");
    const after = pendingAd(out.state)!;
    assert.equal(shownTeam(after), null);
    assert.equal(after.team?.dropped, "changed");
    assert.ok(!canMeet(after), "1つの案に会議は1回まで");
    assert.equal(teamDecisionLine(after, "skipped"), null, "出していない会議の予想は日誌に書かない");
  });

  test("答えが出た後に「直す」で変わったら、もう出さない", async () => {
    let s = await scriptProposal();
    const p = pendingAd(s)!;
    s = withTeamStarted(s, p.id, NOW, p.mode);
    s = withTeamResult(s, p.id, NOW, (await meet(inputFor(s), "script", scriptTeamWriter, limits))!).state;
    assert.ok(shownTeam(pendingAd(s)!));
    s = withAdFixed(s, p.id, { action: "exclude", no: 12, text: "髪型 流行り 芸能人", reason: "出しなおしました。" }, table, p.checks);
    assert.equal(shownTeam(pendingAd(s)!), null);
  });

  test("LINE・別の画面でもう決まっていたら出さない", async () => {
    let s = await scriptProposal();
    const p = pendingAd(s)!;
    s = withTeamStarted(s, p.id, NOW, p.mode);
    const result = (await meet(inputFor(s), "script", scriptTeamWriter, limits))!;
    s = withAdSkipped(s, p.id, NOW);
    const out = withTeamResult(s, p.id, NOW, result);
    assert.equal(out.arrival, "decided");
    assert.equal(out.state.proposals[0].team?.result, undefined);
  });

  test("二重の呼び出しを防ぐ：もう印があれば始めない。印の時刻がちがう答えは入れない", async () => {
    let s = await scriptProposal();
    const p = pendingAd(s)!;
    s = withTeamStarted(s, p.id, NOW, p.mode);
    assert.equal(withTeamStarted(s, p.id, "2026-11-05T02:00:00.000Z", p.mode), s);
    const result = (await meet(inputFor(s), "script", scriptTeamWriter, limits))!;
    assert.equal(withTeamResult(s, p.id, "2026-11-05T02:00:00.000Z", result).arrival, "missing");
    s = withTeamResult(s, p.id, NOW, result).state;
    assert.equal(withTeamResult(s, p.id, NOW, result).arrival, "missing", "2回目の答えは入れない");
  });
});

describe("会議の途中で LINE のボタンで決まった時・日誌の形・出さない所", () => {
  for (const how of ["approve", "skip"] as const)
    test(`会議の途中で LINE のボタン（${how === "approve" ? "承認" : "見送り"}）で決まったら、答えを出さない`, async () => {
      let s = await scriptProposal();
      const p = pendingAd(s)!;
      s = withTeamStarted(s, p.id, NOW, p.mode);
      const result = (await meet(inputFor(s), "script", scriptTeamWriter, limits))!;
      const line = applyPress({ id: "e1", at: NOW, kind: "press", approvalId: p.id, target: "ad", how }, emptyBook(ANCHOR), s, {
        nowIso: NOW,
        today: ANCHOR,
        shop,
        adSettings: settings,
        menus: getMenus(),
        customers: [],
      });
      // 答えをまだ出していないので、分身の予想の1行も書かない
      assert.ok(!line.journal.some((j) => j.text.startsWith("分身の予想")));
      const out = withTeamResult(line.ads, p.id, NOW, result);
      assert.equal(out.arrival, "decided");
      assert.equal(out.state.proposals[0].team?.result, undefined);
      assert.equal(shownTeam(out.state.proposals[0]), null);
    });

  test("会議の中身は、役の名前つきで短く日誌に（AI の役は「AI」・リサーチャーはプログラム）", async () => {
    const s = await scriptProposal();
    const p = pendingAd(s)!;
    for (const [mode, writer] of [
      ["ai", fakeClaude(GOOD)],
      ["script", scriptTeamWriter()],
    ] as const) {
      const r = (await runTeam(inputFor(s), writer, limits, mode))!;
      const lines = teamJournal(p, r);
      assert.deepEqual(
        lines.map((l) => l.text.split(/[（：]/)[0]),
        ["リサーチャー", "分身", "野党", "補佐"],
      );
      assert.equal(lines[0].who, "プログラム");
      for (const l of lines.slice(1)) assert.equal(l.who, mode === "ai" ? "AI" : "プログラム");
      // 短く：数字はリサーチャーの番号だけ・1行は欄の長さの合計まで
      const max = team.maxTwinChars + team.maxLineChars * 3 + 20;
      for (const l of lines) assert.ok([...l.text].length <= max, `${l.text}（${[...l.text].length}字）`);
    }
  });

  test("ホームの「AI の仕事」と予約の「AI の手順」には出さない（会議の部品を使うのは広告の案の行だけ）", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const root = join(__dirname, "../../../..");
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    const users = walk(join(root, "src"))
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("__tests__") && !f.includes(join("src", "lib", "ads", "team")))
      // 会議の部品を import している所（と、会議の窓口の URL を書いている所）
      .filter((f) => /from "[^"]*(ads\/team|\.\/team\/|AdTeam)[^"]*"|"\/api\/ai\/ads\/team"/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f).split("\\").join("/"))
      .sort();
    assert.deepEqual(users, [
      "src/app/api/ai/ads/team/route.ts",
      // 発信の下書きの会議（§1.10.1）：共有するのは役の名前と短い説明・Claude を呼ぶ薄い所だけ（posts/__tests__/team.test.ts で確かめる）
      "src/app/api/ai/posts/team/route.ts",
      "src/components/AdApprovalRows.tsx",
      "src/components/AdTeam.tsx",
      "src/lib/ads/state.ts",
      "src/lib/line/apply.ts",
      "src/lib/posts/deskStore.ts",
      "src/lib/posts/team/run.ts",
      "src/lib/posts/team/script.ts",
      "src/lib/posts/team/types.ts",
    ]);
    // AI の仕事（src/lib/jobs・ホームの欄）と AI の手順（予約チャット・AiSteps）は、会議に触れない
    for (const f of [...walk(join(root, "src/lib/jobs")), join(root, "src/app/home/AiJobs.tsx"), join(root, "src/components/AiSteps.tsx"), ...walk(join(root, "src/lib/ai")), ...walk(join(root, "src/app/reservations"))].filter((f) => !f.includes("__tests__")))
      assert.doesNotMatch(readFileSync(f, "utf8"), /ads\/team|AdTeam|分身|野党|補佐|リサーチャー/, relative(root, f));
  });
});

describe("言葉の門（欄ごと）", () => {
  const opts = { maxSentences: 1, maxChars: team.maxLineChars, gateWords: settings.gateWords, material: "" };

  test("今の広告の門とちがい、欄の文の全部を見る（2文目の数字・2文目があることも当てる）", () => {
    const g = gateTeamText("残したい。予約は3件です。", { ...opts, maxSentences: 2 });
    assert.equal(g.ok, false);
    assert.equal(gateTeamText("残したい。次で確かめたい。", opts).ok, false, "1文の欄に2文");
    assert.equal(gateTeamText("残したい。次で確かめたい。", { ...opts, maxSentences: 2 }).ok, true);
  });

  test("🔒 決めた・承認した・確定したと言わない。健康や医療の判断の言葉は材料に無ければ外す", () => {
    for (const t of ["私が承認しておきました。", "広告を止めておきました。", "AI が決めました。", "頭皮が荒れるお客様には安全です。", "効果が出るのでおすすめです。"])
      assert.equal(gateTeamText(t, opts).ok, false, t);
  });

  test("数字・使わない言葉・英字・長すぎる文も外す", () => {
    for (const t of ["三回目の見直しです。", "外すのは失敗です。", "SNS で探す方に届かない。", "あ".repeat(team.maxLineChars + 1)]) assert.equal(gateTeamText(t, opts).ok, false, t);
  });

  test("補佐の3行は1行ずつ：当たった行だけ外し、ほかは出す", async () => {
    const s = await scriptProposal();
    const r = (await runTeam(inputFor(s), fakeClaude({ ...GOOD, aide: { ...GOOD.aide, next: "来週の金曜にもう一度見ます。" } }), limits, "ai"))!;
    assert.equal(r.aide?.conclusion, GOOD.aide.conclusion);
    assert.equal(r.aide?.reason, GOOD.aide.reason);
    assert.equal(r.aide?.next, undefined);
    assert.ok(r.dropped.some((d) => d.role === "aide" && d.field === "次の一手"));
    const lines = teamJournal(pendingAd(s)!, r).map((x) => x.text);
    assert.ok(lines.some((t) => t.startsWith("言葉の門で外した：補佐の次の一手")));
  });

  test("野党の欄も1つずつ：「代わりの選び方」だけ当たっても、野党は出さない", async () => {
    const s = await scriptProposal();
    const r = (await runTeam(inputFor(s), fakeClaude({ ...GOOD, opposition: { ...GOOD.opposition, alternative: "二週間待ってから決めたい。" } }), limits, "ai"))!;
    assert.equal(r.opposition, null);
    assert.ok(r.dropped.some((d) => d.role === "opposition" && d.field === "代わりの選び方"));
  });
});

describe("リサーチャー（プログラム）", () => {
  test("その言葉の4週の数・予約・お金・前の判定を表から並べる", () => {
    const r = research(table, { action: "exclude", no: 10 }, [{ no: 3, text: "美容院 安い", action: "stop", verdict: "worked" }], settings.towns)!;
    assert.equal(r.text, "美容院 安い 学生");
    assert.equal(r.weeks.length, 4);
    assert.deepEqual(r.total, { clicks: 50, cost: 2500, bookings: 0 });
    assert.equal(r.judgements.length, 0);
    assert.equal(r.otherJudgements[0].verdict, "worked");
    assert.equal(research(table, { action: "stop", no: 10 }, [], settings.towns), null);
  });
});

describe("上限は config に・窓口は /api/ai/ の下", () => {
  test("adsTeam の上限は全部 config/ai.json にあり、窓口と画面に数を直に書かない", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const ai = JSON.parse(readFileSync(join(__dirname, "../../../../config/ai.json"), "utf8"));
    for (const k of ["maxReplyTokens", "maxCalls", "maxTwinChars", "maxLineChars", "maxHistory", "maxRequestChars"])
      assert.ok(Number.isInteger(ai.adsTeam[k]) && ai.adsTeam[k] > 0, k);
    assert.equal(team.maxCalls, ai.adsTeam.maxCalls);
    const route = readFileSync(join(__dirname, "../../../app/api/ai/ads/team/route.ts"), "utf8");
    const view = readFileSync(join(__dirname, "../../../components/AdTeam.tsx"), "utf8");
    for (const t of [route, view]) assert.doesNotMatch(t, /maxCalls:\s*\d|maxTokens:\s*\d|\d+_000\b/);
    // 画面の部品は確定・承認の変え方を呼ばない（決めるのは承認BOXのボタン）
    assert.doesNotMatch(view, /approveAd|withAdApproved|withAdSkipped|withApproved/);
  });
});

// ---- 本番で本物の Claude（3番「美容院 安い」を止める案）で3役とも出なかった時の落ち方 ----
// 1. 分身：長くなって途中で切れた 2. 野党の危ない所：2文・数字 3. 野党の代わりの選び方：数字・「様子を見」
// 門はゆるめず、指示と出力の上限で直す。ここでは落ちる見本と、門で落ちない見本の両方を確かめる。

describe("本番の3つの落ち方（落ちる見本・落ちない見本）", () => {
  /** 3番「美容院 安い」を止める案（本番と同じ案） */
  async function stop3(): Promise<AdsState> {
    const p = { action: "stop" as const, no: 3, text: "美容院 安い", reason: "押されてお金はかかっていますが、予約につながっていません。" };
    return withProposal(EMPTY_ADS, p, table, { id: "ad-3", checks: [], nowIso: NOW, mode: "ai" }, settings);
  }
  const OK3 = {
    twin: { guess: "approve", text: "前も予約につながらない言葉から見直した。お金がかかっているので止めそうです。" },
    opposition: { stance: "against", risk: "止めると、値段で探している方に広告が出なくなる。", alternative: "今回は残して次の見直しで確かめたい。" },
    aide: { adopt: "opposition", conclusion: "今回は止めずに残す考えです。", reason: "値段で探している方に届かなくなるからです。", next: "次の見直しで、この言葉の予約をもう一度確かめます。" },
  };

  test("落ちない見本：3役とも門を通り、補佐まで呼ぶ（呼ぶのは3回）", async () => {
    const s = await stop3();
    const w = fakeClaude(OK3);
    const r = (await runTeam(inputFor(s), w, limits, "ai"))!;
    assert.deepEqual(r.dropped, []);
    assert.ok(r.twin && r.opposition && r.aide);
    assert.equal(r.calls, 3);
    assert.equal(r.aide?.next, OK3.aide.next);
  });

  test("1. 分身が途中で切れた：出さない（落ちる見本）。出力の上限は目安の字数に足りる大きさで、その数で呼ぶ", async () => {
    const s = await stop3();
    const cut: TeamWriter & { seen: TeamWriteRequest[] } = {
      claude: true,
      seen: [],
      async write(req) {
        this.seen.push(req);
        return req.role === "twin" ? { raw: null, stop: "max_tokens" } : { raw: OK3[req.role], stop: "end" };
      },
    };
    const r = (await runTeam(inputFor(s), cut, limits, "ai"))!;
    assert.equal(r.twin, null);
    assert.ok(r.dropped.some((d) => d.role === "twin" && d.problems[0] === "長くなって途中で切れました"));
    assert.equal(r.aide?.adopt, "opposition", "野党は出て、補佐も呼ぶ");
    // 上限：3つの欄（1文60字くらい）を JSON で書いて、考える分も足りる大きさ（日本語は1字で数トークンになることもある）
    const need = (team.maxLineChars * 3 + 100) * 3;
    assert.ok(team.maxReplyTokens >= need, `maxReplyTokens ${team.maxReplyTokens} >= ${need}`);
    for (const req of cut.seen) assert.equal(req.maxTokens, team.maxReplyTokens);
  });

  test("会議のモデルは Sonnet（config/ai.json の adsTeam）。1回の会議で3回までは変えない", () => {
    assert.match(team.model, /sonnet/);
    assert.equal(team.maxCalls, 3);
  });

  test("2. 野党の危ない所：2文・数字（「4」「5000」「0」）は落ちる。1文・言葉で言えば通る", async () => {
    const s = await stop3();
    const badRisk = "4週で5000円かかって予約は0件です。止めると探す方に届かなくなります。";
    const r = (await runTeam(inputFor(s), fakeClaude({ ...OK3, opposition: { ...OK3.opposition, risk: badRisk } }), limits, "ai"))!;
    assert.equal(r.opposition, null);
    const d = r.dropped.find((x) => x.role === "opposition" && x.field === "危ない所")!;
    assert.ok(d.problems.some((p) => p.includes("1文より多く")));
    assert.ok(d.problems.some((p) => p.includes("「4」") && p.includes("「5000」") && p.includes("「0」")));
    const good = (await runTeam(inputFor(s), fakeClaude({ ...OK3, opposition: { ...OK3.opposition, risk: "止めると、値段で探している方に広告が出なくなる。" } }), limits, "ai"))!;
    assert.ok(good.opposition);
  });

  test("3. 野党の代わりの選び方：数字（「0」）と「様子を見」は落ちる。「次の見直しで確かめる」なら通る", async () => {
    const s = await stop3();
    const bad = "予約が0件のまま様子を見る。";
    const r = (await runTeam(inputFor(s), fakeClaude({ ...OK3, opposition: { ...OK3.opposition, alternative: bad } }), limits, "ai"))!;
    assert.equal(r.opposition, null);
    const d = r.dropped.find((x) => x.role === "opposition" && x.field === "代わりの選び方")!;
    assert.ok(d.problems.some((p) => p.includes("「0」")));
    assert.ok(d.problems.some((p) => p.includes("「様子を見」")));
    for (const alt of ["予約がないまま、次の見直しで確かめたい。", "今回は残して次の見直しで確かめたい。"]) {
      const g = (await runTeam(inputFor(s), fakeClaude({ ...OK3, opposition: { ...OK3.opposition, alternative: alt } }), limits, "ai"))!;
      assert.ok(g.opposition, alt);
    }
  });

  test("補佐を呼ぶのは分身か野党が門を通った時だけ（本番は2つとも落ちて calls 2）", async () => {
    const s = await stop3();
    const prod = {
      opposition: { stance: "against", risk: "4週で5000円かかって予約は0件です。止めると探す方に届かなくなります。", alternative: "予約が0件のまま様子を見る。" },
    };
    const w: TeamWriter & { seen: TeamWriteRequest[] } = {
      claude: true,
      seen: [],
      async write(req) {
        this.seen.push(req);
        return req.role === "twin" ? { raw: null, stop: "max_tokens" } : { raw: prod.opposition, stop: "end" };
      },
    };
    const r = (await runTeam(inputFor(s), w, limits, "ai"))!;
    assert.equal(r.calls, 2);
    assert.equal(r.twin, null);
    assert.equal(r.opposition, null);
    assert.equal(r.aide, null);
  });

  test("指示に「数字を書かない」「1文」「60字」「様子を見るは使わず次の見直しで確かめる」が入っている（3役とも）・欄ごとの JSON の形", async () => {
    const s = await stop3();
    const w = fakeClaude(OK3);
    await runTeam(inputFor(s), w, limits, "ai");
    assert.equal(w.seen.length, 3);
    for (const req of w.seen) {
      for (const must of ["数字を書かない", "1文", "60字", "「様子を見る」は使わず", "次の見直しで確かめる", "予約がない", "お金がかかっている", "値段", "日付"])
        assert.ok(req.system.includes(must), `${req.role}：${must}`);
      // 欄ごとの JSON：欄が決まっていて、ほかの欄は受けない。文の欄の説明にも数字と1文の決まり
      assert.equal(req.schema.additionalProperties, false);
      const props = req.schema.properties as Record<string, { type: string; description?: string }>;
      for (const [k, v] of Object.entries(props)) if (v.type === "string" && !("enum" in v)) assert.match(v.description ?? "", /数字/, `${req.role}.${k}`);
    }
    const sys = (role: string) => w.seen.find((x) => x.role === role)!.system;
    assert.match(sys("twin"), /1〜2文/);
    assert.match(sys("opposition"), /risk：[^\n]*1文だけ/);
    assert.match(sys("opposition"), /alternative：[^\n]*1文だけ/);
    assert.match(sys("aide"), /3つとも、それぞれ1文だけ/);
    // 材料に、数を言葉で言った物（数字なし）が入る
    const user = w.seen.find((x) => x.role === "twin")!.user;
    const words = user.slice(user.indexOf("# 数を言葉で言うと"));
    assert.match(words, /予約：ずっと予約がない/);
    assert.match(words, /お金：毎週お金がかかっている/);
    assert.doesNotMatch(words.split("\n\n")[0], /[0-9０-９]/);
  });

  test("言葉の門と🔒の言葉のリストはゆるめていない", () => {
    const opts = { maxSentences: 1, maxChars: team.maxLineChars, gateWords: settings.gateWords, material: "" };
    for (const t of ["様子を見たい。", "予約は0件です。", "三週間待ちたい。", "止めると効果が下がる。", "安全に残したい。"]) assert.equal(gateTeamText(t, opts).ok, false, t);
  });
});

describe("広告の理由の「一」：カードと報告で同じ結果", () => {
  const reasons: [string, boolean][] = [
    ["費用がかさむ一方で、ずっと予約につながっていないため。", true],
    ["一度も予約につながっていません。", true],
    ["ほかの言葉と一緒に見ても、予約につながっていません。", true],
    ["一回も予約がありません。", false],
    ["予約は一件だけです。", false],
    ["一万円近くかかっています。", false],
  ];

  test("「一方」「一度」「一緒」の「一」は数えない。「一回」「一件」「一万」は今までどおり落とす", () => {
    for (const [t, ok] of reasons) assert.equal(gateAdSentence(t, settings.gateWords).ok, ok, t);
  });

  test("案のカード（checkDraft）と毎週の報告（buildWeeklyReport）で、同じ文はいつも同じ結果", () => {
    for (const [reason, ok] of reasons) {
      const card = checkDraft(table, settings.towns, { tool: "stop_keyword", action: "stop", no: 3, reason, extraKeys: [] });
      assert.equal(card.ok, ok, `カード：${reason}`);
      const report = buildWeeklyReport({
        id: "r1",
        nowIso: NOW,
        today: ANCHOR,
        table,
        shop,
        settings,
        mode: "ai",
        proposal: { action: "stop", no: 3, text: "美容院 安い", reason, id: "ad-x" },
      });
      assert.equal(report.proposal?.reason === reason, ok, `報告：${reason}`);
    }
  });
});
