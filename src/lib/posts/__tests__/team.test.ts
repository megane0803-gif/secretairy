// 発信の下書きの「AI のチーム」（docs/SPEC.md §1.10.1）。Claude は呼ばず、決まった返事（team/script.ts）か、決まった答えを返す物に置きかえる。
// 今日は 2026-11-05（木）。下書きは画面と同じ順（作る → 門 → 日付を入れる）で作る。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ROLE_DESC, ROLE_NAME } from "../../ads/team/types";
import { NoAiError } from "../../ai/model";
import { calDay } from "../../calendar";
import { getCustomers, getPostMemos } from "../../data/seed";
import { resolveChatReservations, type ChatReservation, type Reservation } from "../../reservations";
import { LOCKED_INSTRUCTIONS } from "../../rules/prompt";
import { getSeedRules } from "../../rules/store";
import { KARTE_GATE_WORDS } from "../../rules/locked";
import { getAdsTeamAiSettings, getMenus, getPostsAiSettings, getPostsSettings, getPostsTeamAiSettings, getPostsTeamLimits, getShop, type PostKind } from "../../settings";
import { readOwnerClosed } from "../closed";
import type { PostDraft } from "../deskStore";
import { fillPost, periodOf, postFacts } from "../facts";
import { BLOG_LINK_MARK, CLOSED_MARK, gatePost, OPENINGS_MARK } from "../gate";
import { scriptPostsModel } from "../script";
import { runWrite } from "../write";
import { askPostsTeam, postTeamRequestFor, regatePostTeam, runLimitsOf } from "../team/client";
import { checkReplaced, editableSentences, factsIn, hashText, sentencesOf } from "../team/gate";
import { meetPost } from "../team/meet";
import { maskPieces, runPostTeam, type PostTeamInput, type PostTeamWriteRequest, type PostTeamWriter } from "../team/run";
import { RESEARCH_TAG, researchPost } from "../team/research";
import { AVOID_CONTAINING, SHOP_FILLS } from "../team/prompt";
import {
  applyPostPick,
  canMeetPost,
  pickState,
  pickSummary,
  postTeamJournal,
  skipPostPick,
  withHandEdit,
  withPostTeamResult,
  withPostTeamStarted,
} from "../team/state";
import { DRAFT_CHANGED, POST_ROLE_DESC, POST_ROLE_NAME, TOO_LONG, type PostTeamResult } from "../team/types";
import { parsePostTeamRequest } from "../team/wire";
import type { TeamJsonResult } from "../../ads/team/claude";

const settings = getPostsSettings();
const shop = getShop();
const words = settings.gateWords;
const memos = getPostMemos();
const rules = getSeedRules();
const notice = settings.kinds.find((k) => k.id === "notice")!;
const blog = settings.kinds.find((k) => k.id === "blog")!;
const TL = getPostsTeamLimits();
const limits = runLimitsOf(TL);
const TODAY = "2026-11-05";
const NOW = { date: TODAY, time: "09:00" };
const NEW_YEAR_POINTS = "12月31日から1月5日まで休みます";

/** 画面（PostsForm）と同じ順で、下書きを作る：決まった返事か決まった文 → 門 → 日付を入れる */
async function makeDraft(materials: Record<string, string>, opts: { raw?: string; kind?: PostKind; all?: Reservation[] } = {}): Promise<PostDraft> {
  const kind = opts.kind ?? notice;
  let raw = opts.raw;
  if (raw === undefined) {
    const ai = getPostsAiSettings();
    const r = await runWrite({ kind, materials, memos, rules, shopName: shop.name, gateWords: words, model: scriptPostsModel(kind, materials, memos), maxTokens: ai.maxReplyTokens, maxTries: ai.maxTries, lengthSlack: settings.lengthSlack });
    assert.ok(r.ok);
    raw = r.text;
  }
  const g = gatePost(raw, words);
  assert.ok(g.ok, g.problems.join("。"));
  const text = kind.materials.map((f) => materials[f.id] ?? "");
  const period = periodOf(text.join(" "), TODAY, settings.periods);
  const owner = readOwnerClosed(text.join("\n"), TODAY);
  const facts = postFacts(shop, settings, calDay(shop, TODAY), NOW, opts.all ?? [], period, owner);
  const f = fillPost(raw, kind, facts);
  return {
    id: "pd-1",
    version: 0,
    kind: kind.id,
    text: f.text,
    made: f.text,
    checks: g.checks,
    inserted: f.inserted,
    tries: 1,
    cut: false,
    mode: "script",
    topic: materials.topic ?? "",
    closedFrom: facts.closedFrom,
    unreadable: facts.unreadable,
    cautions: facts.cautions,
    closedDates: owner.kind === "dates" ? owner.dates : undefined,
    pieces: f.pieces,
    openings: facts.openings,
    closed: facts.closed,
    period,
  };
}

const NEW_YEAR = () => makeDraft({ topic: "年末年始のお休み", points: NEW_YEAR_POINTS });

function inputOf(d: PostDraft, kind: PostKind = notice): PostTeamInput {
  return { kind, text: d.text, pieces: d.pieces ?? [], memos, rules, gateWords: words };
}

/** 決まった答えを返す物（Claude の代わり。呼ばれた頼みを全部とっておく） */
function fakeClaude(answers: Partial<Record<PostTeamWriteRequest["role"], unknown>>, stop: TeamJsonResult["stop"] = "end"): PostTeamWriter & { seen: PostTeamWriteRequest[] } {
  const seen: PostTeamWriteRequest[] = [];
  return {
    claude: true,
    seen,
    async write(req) {
      seen.push(req);
      return { raw: answers[req.role] ?? null, stop };
    },
  };
}

/** 会議を始めて、答えを出すまで（画面と同じ順） */
function shownDraft(d: PostDraft, result: PostTeamResult): PostDraft {
  const started = withPostTeamStarted(d, "pt-1", "2026-11-05T01:00:00.000Z", d.mode, TL.maxDraftChars);
  const out = withPostTeamResult(started, { draftId: d.id, meetingId: "pt-1" }, result);
  assert.equal(out.arrival, "shown");
  return out.draft!;
}

const ref = (d: PostDraft, no: number) => ({ draftId: d.id, version: d.version ?? 0, meetingId: d.team!.meetingId, no });
const applyCtx = { gateWords: words, maxLineChars: TL.maxLineChars };

const GOOD = {
  twin: { edits: [{ from: "年末年始のお休みについて、お知らせです。", to: "年末年始のお休みについて、お知らせします。" }] },
  opposition: {
    stance: "against",
    concern: "unclear",
    why: "言い切っていないので、何を伝えたいかが分かりにくいところです。",
    from: "ヘッドスパは、ゆっくり休める時間として楽しんでもらっているメニュー。",
    to: "ヘッドスパは、ゆっくり休める時間として楽しんでもらっているメニューです。",
  },
  aide: { picks: [{ no: 2, reason: "読む人に伝わりやすくなるからです。" }, { no: 1, reason: "オーナーの言い方に近づくからです。" }] },
};

describe("1. 同じ文が2回ある下書き", () => {
  test("その文への候補は出ない（一部だけ一致する文も出ない）", async () => {
    const raw = `いつもありがとうございます。\n\nヘッドスパのお知らせです。\n\nいつもありがとうございます。\n\n${OPENINGS_MARK}\n\n${CLOSED_MARK}はお休みです。\n\n${BLOG_LINK_MARK}`;
    const d = await makeDraft({ topic: "冬のお知らせ" }, { raw });
    assert.ok(!editableSentences(d.text, d.pieces!).includes("いつもありがとうございます。"));
    const w = fakeClaude({
      twin: { edits: [{ from: "いつもありがとうございます。", to: "いつも来てくださって、ありがとうございます。" }, { from: "ヘッドスパの", to: "ヘッドスパのお知らせをします。" }] },
      opposition: { stance: "against", concern: "unclear", why: "何のお知らせかが分かりにくいところです。", from: "いつもありがとうございます。", to: "いつも本当にありがとうございます。" },
    });
    const r = (await runPostTeam(inputOf(d), w, limits, "ai"))!;
    assert.equal(r.candidates.length, 0);
    assert.equal(r.twin, null);
    assert.equal(r.opposition, null);
    assert.ok(r.dropped.some((x) => x.problems.includes("同じ文が下書きに2回以上あります")));
    assert.ok(r.dropped.some((x) => x.problems.includes("下書きの1文まるごとと一致しません")));
    // 候補が無いので補佐は呼ばない
    assert.equal(w.seen.length, 2);
  });

  test("文は「。」「！」「？」と改行で区切る", () => {
    assert.deepEqual(sentencesOf("こんにちは！元気ですか？\nまたね。お元気で"), ["こんにちは！", "元気ですか？", "またね。", "お元気で"]);
  });
});

describe("2. 手で直した時", () => {
  test("答えを待つ間に手で直した：答えは出さない", async () => {
    const d = await NEW_YEAR();
    const r = (await meetPost(inputOf(d), "script", () => fakeClaude({}), limits))!;
    const started = withPostTeamStarted(d, "pt-1", "now", "script", TL.maxDraftChars);
    const edited = withHandEdit(started, `${started.text}！`);
    const out = withPostTeamResult(edited, { draftId: d.id, meetingId: "pt-1" }, r);
    assert.equal(out.arrival, "changed");
    assert.equal(out.draft!.team!.result, undefined);
    // 作り直した（下書きの番号が変わった）時も出さない
    const other = withPostTeamResult({ ...started, id: "pd-2" }, { draftId: d.id, meetingId: "pt-1" }, r);
    assert.equal(other.arrival, "missing");
    // 1つの下書きに会議は1回
    assert.equal(canMeetPost(out.draft, TL.maxDraftChars).ok, false);
  });

  test("答えが出た後に手で直した：残りの候補は「下書きが変わったので入れられません」", async () => {
    const d = await NEW_YEAR();
    const s = shownDraft(d, (await meetPost(inputOf(d), "script", () => fakeClaude({}), limits))!);
    const first = s.team!.result!.aide!.picks[0].no;
    const a = applyPostPick(s, ref(s, first), applyCtx);
    assert.equal(a.outcome, "applied");
    const e = withHandEdit(a.draft!, a.draft!.text.replace("いつも", "いつも、"));
    const rest = s.team!.result!.aide!.picks.slice(1);
    for (const p of rest) assert.equal(pickState(e, p.no), "changed");
    const b = applyPostPick(e, ref(e, rest[0].no), applyCtx);
    assert.equal(b.outcome, "changed");
    assert.deepEqual(b.problems, [DRAFT_CHANGED]);
    assert.equal(b.draft!.text, e.text, "下書きは変えない");
    // 入れた物は入れたまま。手で直した後の版は上げない
    assert.equal(e.version, 1);
    assert.equal(pickSummary(e)!.line, "補佐の直し：入れた1・入れなかった0・入れられなかった2");
  });

  test("「入れる」を押した時も照合する：版・会議の番号がちがえば入れない", async () => {
    const d = await NEW_YEAR();
    const s = shownDraft(d, (await meetPost(inputOf(d), "script", () => fakeClaude({}), limits))!);
    const no = s.team!.result!.aide!.picks[0].no;
    assert.equal(applyPostPick(s, { ...ref(s, no), version: 5 }, applyCtx).outcome, "changed");
    assert.equal(applyPostPick(s, { ...ref(s, no), meetingId: "pt-other" }, applyCtx).outcome, "missing");
    assert.equal(applyPostPick(s, { ...ref(s, no), draftId: "pd-other" }, applyCtx).outcome, "missing");
  });
});

describe("3. 2つ続けて入れる", () => {
  test("両方入り、版が2つ上がる。日誌に「補佐の直し：入れた2・入れなかった1」", async () => {
    const d = await NEW_YEAR();
    const s = shownDraft(d, (await meetPost(inputOf(d), "script", () => fakeClaude({}), limits))!);
    const picks = s.team!.result!.aide!.picks;
    assert.equal(picks.length, 3);
    const a = applyPostPick(s, ref(s, picks[0].no), applyCtx);
    assert.equal(a.outcome, "applied");
    assert.equal(pickSummary(a.draft), null, "まだ選んでいない直しがある");
    const b = applyPostPick(a.draft, ref(a.draft!, picks[1].no), applyCtx);
    assert.equal(b.outcome, "applied");
    assert.equal(b.draft!.version, 2);
    for (const p of picks.slice(0, 2)) {
      assert.ok(b.draft!.text.includes(p.to));
      assert.ok(!b.draft!.text.includes(p.from));
    }
    // 入れたのはその1文だけ（ほかは変えない）
    const rest = (x: string) => picks.slice(0, 2).reduce((t, p) => t.replace(p.to, p.from), x);
    assert.equal(rest(b.draft!.text), d.text);
    const c = skipPostPick(b.draft, ref(b.draft!, picks[2].no));
    assert.equal(c.outcome, "skipped");
    assert.equal(c.draft!.version, 2, "入れない時は版を上げない");
    const sum = pickSummary(c.draft)!;
    assert.equal(sum.line, "補佐の直し：入れた2・入れなかった1");
    assert.equal(pickSummary(sum.draft), null, "日誌の1行は1回だけ");
    // 同じ直しは2回入れない
    assert.equal(applyPostPick(c.draft, ref(c.draft!, picks[0].no), applyCtx).outcome, "missing");
  });

  test("元の文がもう1回だけでなければ入れない（入れた後の文と重なる時など）", async () => {
    const d = await NEW_YEAR();
    const s = shownDraft(d, (await meetPost(inputOf(d), "script", () => fakeClaude({}), limits))!);
    const p = s.team!.result!.aide!.picks[0];
    // 別の画面などで元の文が2回になった下書き（チームが知っている文も同じにしておく）
    const twice = `${s.text}\n${p.from}`;
    const t2: PostDraft = { ...s, text: twice, team: { ...s.team!, text: twice } };
    const r = applyPostPick(t2, ref(t2, p.no), applyCtx);
    assert.equal(r.outcome, "blocked");
    assert.equal(r.draft!.text, twice);
  });
});

describe("4. 日付の入った下書き（年末年始の例）", () => {
  test("会議ができ、全文の確かめで正しい日付は当たらない。日付のある文への候補は出ない", async () => {
    const d = await NEW_YEAR();
    assert.ok(d.text.includes("12月31日（木）〜1月5日（火）"));
    assert.ok(canMeetPost(d, TL.maxDraftChars).ok);
    // 作る時の門をそのまま掛けると、正しい日付まで当たる（だから掛けない）
    assert.equal(gatePost(d.text, words).ok, false);
    // 日付のある文は、候補にしてよい文に入らない
    for (const s of editableSentences(d.text, d.pieces!)) assert.deepEqual(factsIn(s), [], s);
    const dateLine = sentencesOf(d.text).find((s) => s.includes("12月31日"))!;
    const w = fakeClaude({
      ...GOOD,
      twin: { edits: [GOOD.twin.edits[0], { from: dateLine, to: "お休みは年末年始です。" }] },
    });
    const r = (await runPostTeam(inputOf(d), w, limits, "ai"))!;
    assert.deepEqual(r.twin!.edits, GOOD.twin.edits);
    assert.ok(r.dropped.some((x) => x.field === "直し2" && x.problems.some((p) => p.includes("数字・日付"))));
    // 候補を入れても、全文の確かめで日付は当たらない
    const s = shownDraft(d, r);
    for (const p of s.team!.result!.aide!.picks) {
      const c = checkReplaced(d.text, d.text.replace(p.from, p.to), { pieces: d.pieces!, gateWords: words, closed: { shop, dates: d.closedDates!, all: [] } });
      assert.equal(c.ok, true, c.problems.join("。"));
      // 事実の確かめ（closedCautions）は知らせるだけ（止めない）
      assert.ok(c.cautions.some((x) => x.includes("店の設定では営業日")));
    }
    assert.equal(applyPostPick(s, ref(s, s.team!.result!.aide!.picks[0].no), applyCtx).outcome, "applied");
  });

  test("プログラムが入れた所が変わる置きかえは入れない", async () => {
    const d = await NEW_YEAR();
    const closed = d.pieces!.find((p) => p.includes("12月31日"))!;
    const c = checkReplaced(d.text, d.text.replace(closed, "年末年始"), { pieces: d.pieces!, gateWords: words });
    assert.equal(c.ok, false);
    assert.ok(c.problems[0].includes("プログラムが入れた所"));
    // 数字の無い入れた所（読み取れなかった時の言葉）を含む文・足す文も、候補にしない
    const u = await makeDraft({ topic: "年末年始のお休み", points: "十二月三十一日から休みます" });
    assert.equal(u.unreadable, true);
    const piece = u.pieces!.find((p) => !/\d/.test(p) && p.startsWith("（"))!;
    const withPiece = sentencesOf(u.text).find((s) => s.includes(piece))!;
    const w = fakeClaude({
      twin: {
        edits: [
          { from: withPiece, to: "お休みは年末年始です。" },
          { from: "くわしくはブログに書きました。", to: `くわしくはブログに書きました${piece}。` },
        ],
      },
    });
    const r = (await runPostTeam(inputOf(u), w, limits, "ai"))!;
    assert.equal(r.twin, null);
    assert.ok(r.dropped.some((x) => x.problems.includes("プログラムが入れた所を含む文です")));
    assert.ok(r.dropped.some((x) => x.problems.some((p) => p.includes("プログラムが入れた所（日付・空き枠・リンクの印）が変わります"))));
  });

  test("AI には日時を見せない（プログラムが入れた所は印に置きかえて渡す）", async () => {
    const d = await NEW_YEAR();
    const w = fakeClaude(GOOD);
    await runPostTeam(inputOf(d), w, limits, "ai");
    for (const req of w.seen) {
      assert.doesNotMatch(req.user, /12月31日|12\/25|10:00/);
      if (req.role !== "aide") assert.ok(req.user.includes(SHOP_FILLS));
    }
    assert.ok(!maskPieces(d.text, d.pieces!).includes("12月31日"));
  });
});

describe("5. 門で外れる候補", () => {
  test("使わない言葉・数字・URL・印・健康の判断の入った直しは出ない", async () => {
    const d = await NEW_YEAR();
    const from = "またお会いできるのを楽しみにしています。";
    const bad = [
      "今だけ、またお会いできるのを楽しみにしています。",
      "三日後にまたお会いできるのを楽しみにしています。",
      "またお会いできるのを2回楽しみにしています。",
      "またお会いできるのを楽しみに https://example.com しています。",
      "またお会いできるのを【空き枠】に楽しみにしています。",
      "ヘッドスパで頭皮の乾燥も改善するので大丈夫です。",
      "ご予約を確定しました。またお会いしましょう。",
    ];
    for (const to of bad) {
      const r = (await runPostTeam(inputOf(d), fakeClaude({ twin: { edits: [{ from, to }] } }), limits, "ai"))!;
      assert.equal(r.candidates.length, 0, to);
      assert.ok(r.dropped.length > 0, to);
    }
  });

  test("補佐が確かめ済みに無い番号を選んでも出ない。文を書きかえて返しても、候補の文をそのまま使う", async () => {
    const d = await NEW_YEAR();
    const w = fakeClaude({
      ...GOOD,
      aide: {
        picks: [
          { no: 99, reason: "読む人に伝わりやすくなるからです。" },
          { no: 1, reason: "オーナーの言い方に近づくからです。", to: "補佐が書きかえた文です。" },
          { no: 1, reason: "もう一度です。" },
        ],
      },
    });
    const r = (await runPostTeam(inputOf(d), w, limits, "ai"))!;
    assert.deepEqual(r.aide!.picks.map((p) => p.no), [1]);
    assert.equal(r.aide!.picks[0].to, GOOD.twin.edits[0].to);
    assert.ok(r.dropped.some((x) => x.problems[0].includes("候補に無い番号（99）")));
    assert.ok(r.dropped.some((x) => x.problems[0].includes("1つに絞りました")));
    // 補佐は確かめ済みの候補（番号つき）だけを読む
    const aideReq = w.seen.find((x) => x.role === "aide")!;
    assert.match(aideReq.user, /1\. 分身：「年末年始のお休みについて、お知らせです。」→「年末年始のお休みについて、お知らせします。」/);
    assert.doesNotMatch(aideReq.user, /お店のメモ/);
  });

  test("同じ元の文への候補は1つに絞る・3つまで", async () => {
    const d = await NEW_YEAR();
    const from = "またお会いできるのを楽しみにしています。";
    const w = fakeClaude({
      twin: { edits: [{ from, to: "またお会いできるのを楽しみに待っています。" }, { from: "いつもありがとうございます。", to: "いつも来てくださって、ありがとうございます。" }] },
      opposition: { stance: "against", concern: "pushy", why: "楽しみと言い切ると、来ることを急かして聞こえるかもしれません。", from, to: "またお会いできたらうれしいです。" },
      aide: { picks: [{ no: 1, reason: "やさしい言い方だからです。" }, { no: 3, reason: "読む人に伝わりやすいからです。" }, { no: 2, reason: "あいさつがやわらかいからです。" }] },
    });
    const r = (await runPostTeam(inputOf(d), w, limits, "ai"))!;
    assert.equal(r.candidates.length, 3);
    assert.deepEqual(r.aide!.picks.map((p) => p.no), [1, 2]);
    const many = fakeClaude({ ...GOOD, aide: { picks: [1, 2, 1, 2].map((no) => ({ no, reason: "読む人に伝わりやすいからです。" })) } });
    assert.ok((await runPostTeam(inputOf(d), many, { ...limits, maxPicks: 1 }, "ai"))!.aide!.picks.length === 1);
  });

  test("画面でも、受け取った答えをもう一度同じ確かめに通す（通らない物は出さない）", async () => {
    const d = await NEW_YEAR();
    const r = (await runPostTeam(inputOf(d), fakeClaude(GOOD), limits, "ai"))!;
    const tampered: PostTeamResult = {
      ...r,
      twin: { edits: [{ from: GOOD.twin.edits[0].from, to: "今だけのお知らせです。" }] },
      candidates: [{ no: 1, source: "twin", from: GOOD.twin.edits[0].from, to: "今だけのお知らせです。" }, { ...r.candidates[1] }],
    };
    const g = regatePostTeam(tampered, { text: d.text, pieces: d.pieces!, gateWords: words, limits });
    assert.equal(g.twin, null);
    assert.deepEqual(g.candidates.map((c) => c.source), ["opposition"]);
    assert.deepEqual(g.aide!.picks.map((p) => p.to), [GOOD.opposition.to]);
  });
});

describe("6. 野党が賛成の言いかえ・欠けた", () => {
  test("出さず「反対意見を確かめられませんでした」", async () => {
    const d = await NEW_YEAR();
    const base = GOOD.opposition;
    for (const opposition of [
      { ...base, stance: "agree" },
      { ...base, why: "このままでよいと思います。" },
      { ...base, why: "" },
      { ...base, to: "" },
      { ...base, to: base.from },
      { stance: "against" },
    ]) {
      const r = (await runPostTeam(inputOf(d), fakeClaude({ ...GOOD, opposition }), limits, "ai"))!;
      assert.equal(r.opposition, null, JSON.stringify(opposition));
      const j = postTeamJournal(r, researchPost(d, ctxOf(notice)));
      assert.ok(j.some((l) => l.text === "野党：反対意見を確かめられませんでした"));
    }
  });
});

describe("7. 長すぎる下書き", () => {
  test("「長すぎるのでチームにかけられません」で、呼ばない（切り捨てない）", async () => {
    const long = `${"ヘッドスパのお知らせです。".repeat(60)}`;
    assert.ok([...long].length > TL.maxDraftChars);
    const d = await makeDraft({ topic: "冬の髪の乾燥とヘッドスパ" }, { raw: long, kind: blog });
    const can = canMeetPost(d, TL.maxDraftChars);
    assert.equal(can.ok, false);
    assert.equal(!can.ok && can.message, TOO_LONG);
    assert.equal(withPostTeamStarted(d, "pt-1", "now", "ai", TL.maxDraftChars), d, "会議を始めない");
    const w = fakeClaude(GOOD);
    assert.equal(await runPostTeam(inputOf(d, blog), w, limits, "ai"), null);
    assert.equal(w.seen.length, 0);
    const parsed = parsePostTeamRequest({ mode: "ai", kind: "blog", text: long, pieces: [], memos, rules: [] }, settings.kinds, TL.maxDraftChars, getMenus().map((m) => m.id));
    assert.equal(parsed.ok, false);
    assert.equal(!parsed.ok && parsed.code, "long");
    // 画面からは送らない
    const old = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched += 1;
      throw new Error("呼ばない");
    }) as typeof fetch;
    try {
      const a = await askPostsTeam(d, { kind: blog, memos, rules, gateWords: words, limits: TL });
      assert.deepEqual(a, { ok: false, message: TOO_LONG });
      assert.equal(fetched, 0);
    } finally {
      globalThis.fetch = old;
    }
  });
});

describe("8. Claude を呼ぶのは3回まで・道具なし・どの指示も🔒が先頭", () => {
  test("分身と野党は同じ材料を別々に読み、補佐は候補だけ。呼ぶのは3回", async () => {
    const d = await NEW_YEAR();
    const w = fakeClaude(GOOD);
    const r = (await runPostTeam(inputOf(d), w, limits, "ai"))!;
    assert.equal(r.calls, 3);
    assert.equal(TL.maxCalls, 3);
    assert.deepEqual(w.seen.map((x) => x.role).sort(), ["aide", "opposition", "twin"]);
    const tw = w.seen.find((x) => x.role === "twin")!;
    const op = w.seen.find((x) => x.role === "opposition")!;
    assert.equal(tw.material.text, op.material.text);
    assert.ok(!tw.user.includes(GOOD.opposition.to) && !op.user.includes(GOOD.twin.edits[0].to), "おたがいの答えは見せない");
    // 上限を小さくすると、それより多くは呼ばない
    const w2 = fakeClaude(GOOD);
    const r2 = (await runPostTeam(inputOf(d), w2, { ...limits, maxCalls: 2 }, "ai"))!;
    assert.equal(w2.seen.length, 2);
    assert.equal(r2.aide, null);
    assert.ok(r2.dropped.some((x) => x.role === "aide" && x.problems[0].includes("上限")));
  });

  test("🔒 指示の先頭は鍵つきの2つ（どの役も）。道具は渡さない。保存した下書きは材料にしない", async () => {
    const d = await NEW_YEAR();
    const w = fakeClaude(GOOD);
    await runPostTeam(inputOf(d), w, limits, "ai");
    for (const req of w.seen) {
      assert.ok(req.system.startsWith("# いつも守ること（🔒 鍵つき。ほかのどの決まりよりも先）"), req.role);
      for (const t of LOCKED_INSTRUCTIONS) assert.ok(req.system.includes(t));
      assert.ok(!("tools" in req));
      assert.match(req.system, /保存しない・送らない・公開しない/);
      // 店のルール（タブ：発信）が入る
      assert.match(req.system, /お客様の顔が分かる写真は載せない/);
    }
    const claude = readFileSync(join(__dirname, "../../ads/team/claude.ts"), "utf8");
    assert.doesNotMatch(claude, /tools\s*:/);
    // 窓口に送る物に、保存した下書きは無い
    assert.deepEqual(Object.keys(postTeamRequestFor(d, { kind: notice, memos, rules, gateWords: words, limits: TL })).sort(), ["kind", "memos", "mode", "pieces", "rules", "text"]);
    const view = readFileSync(join(__dirname, "../../../components/PostTeam.tsx"), "utf8");
    assert.doesNotMatch(view, /usePosts|withSavedPost/);
    // 鍵つきは送られた物を使わず、サーバーで先頭に足しなおす
    const p = parsePostTeamRequest({ mode: "ai", kind: "notice", text: d.text, pieces: d.pieces, memos, rules: [{ id: "locked-no-medical", level: "global", label: "ゆるめる", check: { kind: "text" } }] }, settings.kinds, TL.maxDraftChars, getMenus().map((m) => m.id));
    assert.ok(p.ok);
    assert.ok(p.ok && p.value.rules.filter((r) => r.locked).length === 2 && !p.value.rules.some((r) => r.label === "ゆるめる"));
  });

  test("3つの役の指示の書き方に「使わない言葉を含む言い方も書かない（『必ずしも』など）」がある", async () => {
    assert.equal(AVOID_CONTAINING, "使わない言葉を含む言い方も書かない（『必ずしも』など。言葉の一部でも当たります）");
    const d = await NEW_YEAR();
    const w = fakeClaude(GOOD);
    await runPostTeam(inputOf(d), w, limits, "ai");
    assert.deepEqual(w.seen.map((x) => x.role).sort(), ["aide", "opposition", "twin"]);
    for (const req of w.seen) {
      const head = req.system.indexOf("# 書き方");
      const at = req.system.indexOf(`- ${AVOID_CONTAINING}`);
      assert.ok(head >= 0 && at > head, req.role);
    }
    // 門は言葉の一部でも当てる（「必ずしも」は「必ず」に当たる）ので、ゆるめずに指示で直す
    const r = (await runPostTeam(inputOf(d), fakeClaude({ ...GOOD, opposition: { ...GOOD.opposition, why: "必ずしも伝わるとは限らない言い方です。" } }), limits, "ai"))!;
    assert.equal(r.opposition, null);
  });

  test("AI につながらない時は、決まった返事の声で最後まで（Claude の答えはまぜない）", async () => {
    const d = await NEW_YEAR();
    const r = (await meetPost(inputOf(d), "ai", () => {
      throw new NoAiError("鍵がありません");
    }, limits))!;
    assert.equal(r.mode, "script");
    assert.equal(r.noAi, true);
    const half: PostTeamWriter = {
      claude: true,
      async write(req) {
        if (req.role === "opposition") throw new NoAiError("止まっています");
        return { raw: { edits: [{ from: "いつもありがとうございます。", to: "いつも本当にありがとうございます。" }] }, stop: "end" };
      },
    };
    const r2 = (await meetPost(inputOf(d), "ai", () => half, limits))!;
    assert.equal(r2.mode, "script");
    assert.ok(!r2.candidates.some((c) => c.to === "いつも本当にありがとうございます。"));
  });
});

/** リサーチャーの材料（画面の今の台帳と設定） */
function ctxOf(kind: PostKind, all: Reservation[] = []) {
  return { kind, shop, settings, today: calDay(shop, TODAY), now: NOW, all };
}

describe("9. AI なし：決まった返事で4つの声", () => {
  test("年末年始の例で、リサーチャー・分身・野党・補佐が出る", async () => {
    const d = await NEW_YEAR();
    const r = (await meetPost(inputOf(d), "script", () => fakeClaude({}), limits))!;
    assert.equal(r.calls, 0);
    assert.deepEqual(r.twin!.edits, [
      { from: "年末年始のお休みについて、お知らせです。", to: "年末年始のお休みについて、お知らせします。" },
      { from: "またお会いできるのを楽しみにしています。", to: "またお会いできるのを楽しみに待っています。" },
    ]);
    assert.equal(r.opposition!.concern, "unclear");
    assert.equal(r.opposition!.edit.to, "ヘッドスパは、ゆっくり休める時間として楽しんでもらっているメニューです。");
    assert.equal(r.aide!.picks.length, 3);
    assert.deepEqual(r.dropped, []);
    const research = researchPost(d, ctxOf(notice));
    assert.ok(research.lines.length > 0);
    const j = postTeamJournal(r, research);
    assert.deepEqual(j.map((l) => l.text.split("：")[0]), ["リサーチャー", "分身（AI なし）", "野党（AI なし）", "補佐（AI なし）"]);
    assert.ok(j.every((l) => l.who === "プログラム"), "決まった返事はプログラム");
  });

  test("架空のデータ（下書き・お店のメモ・ルール）に無い事は言わない：言い回しだけを変え、事実を足さない", async () => {
    for (const materials of [
      { topic: "年末年始のお休み", points: NEW_YEAR_POINTS },
      { topic: "冬のヘアケアのお知らせ", points: "ヘッドスパでゆっくりしてほしい" },
    ]) {
      const d = await makeDraft(materials);
      const r = (await meetPost(inputOf(d), "script", () => fakeClaude({}), limits))!;
      const known = `${d.text}\n${memos.map((m) => m.text).join("\n")}`;
      for (const c of r.candidates) {
        assert.ok(d.text.includes(c.from));
        assert.deepEqual(factsIn(c.to), []);
        // 足した言葉は、言い回しの言葉だけ（「します」「待って」「です」「いただけたらうれしい」）
        const added = [...c.to].filter((ch, i) => c.from[i] !== ch).join("");
        assert.match(added, /^[しますまってです待いただけたらうれしい。！]*$/, `${c.from} → ${c.to}`);
        assert.ok(KARTE_GATE_WORDS.every((w) => !c.to.includes(w) || known.includes(w)));
      }
      for (const p of r.aide?.picks ?? []) assert.ok(["読む人に伝わりやすくなるからです。", "オーナーの言い方に近づくからです。"].includes(p.reason!));
    }
  });
});

describe("リサーチャー（プログラム）", () => {
  test("札は「日時・空き枠を確かめた」まで。数・日時はリサーチャーにだけ入る", async () => {
    assert.equal(RESEARCH_TAG, "日時・空き枠を確かめた");
    assert.doesNotMatch(RESEARCH_TAG, /施術|メニュー/);
    const d = await NEW_YEAR();
    const r = researchPost(d, ctxOf(notice));
    const labels = r.lines.map((l) => `${l.state} ${l.label}：${l.value}`);
    assert.ok(labels.some((l) => l.startsWith("ng お休みの日付（材料から）") && l.includes("店の設定では営業日")), labels.join("\n"));
    assert.ok(labels.some((l) => l.startsWith("ok 空き枠（台帳から）")));
    assert.ok(labels.some((l) => l === "ok プログラムが入れた所：入れた時のまま残っています"));
    assert.ok(labels.some((l) => l === "info 印：公開したあとに入れる印が残っています"));
    assert.ok(labels.some((l) => l === "ok 言葉の門：使わない言葉はありません"));
    assert.ok(labels.some((l) => l.startsWith("ok 文字数")));
  });

  test("今の台帳と設定から毎回出しなおす（予約が入った・空き枠が変わったら確かめなおす）", async () => {
    const d = await NEW_YEAR();
    const c = getCustomers();
    const hold = (id: string, date: string): ChatReservation => ({
      id,
      customerId: c[0].id,
      menuId: "cut",
      date,
      start: "10:00",
      status: "hold",
      heldAt: "2026-11-01T00:00:00.000Z",
      expiresAt: "2026-11-02T00:00:00.000Z",
    });
    const all = resolveChatReservations(getMenus(), c, [hold("h-1", "2026-12-31"), hold("h-2", "2026-12-25")]);
    const r = researchPost(d, ctxOf(notice, all));
    assert.ok(r.lines.some((l) => l.state === "ng" && l.value === "12月31日（木）に予約が1件あります"));
    assert.ok(r.lines.some((l) => l.state === "ng" && l.label === "空き枠（台帳から）" && l.value.includes("変わりました")));
    // 手でプログラムの入れた所を消したら
    const e = withHandEdit(d, d.text.replace("12月31日（木）〜1月5日（火）", "年末年始"));
    assert.ok(researchPost(e, ctxOf(notice)).lines.some((l) => l.state === "ng" && l.label === "プログラムが入れた所"));
  });

  test("材料の日付を読み取れなかった下書きは「お休みの日付を読み取れなかった下書きです」", async () => {
    const d = await makeDraft({ topic: "年末年始のお休み", points: "十二月三十一日から休みます" });
    const r = researchPost(d, ctxOf(notice));
    assert.ok(r.lines.some((l) => l.state === "ng" && l.value === "お休みの日付を読み取れなかった下書きです"));
  });

  test("ブログのリンクの印のほかの印が残っていたら知らせる・長すぎたら知らせる", async () => {
    const d = await makeDraft({ topic: "冬のお知らせ" }, { raw: `お知らせです。【写真を入れる】\n\n${BLOG_LINK_MARK}`, kind: blog });
    const r = researchPost(d, ctxOf(blog));
    assert.ok(r.lines.some((l) => l.state === "ng" && l.value === "印が残っています：【写真を入れる】"));
    const long = researchPost({ ...d, text: "あ".repeat(2000) }, ctxOf(blog));
    assert.ok(long.lines.some((l) => l.state === "ng" && l.label === "文字数"));
  });
});

describe("役の名前・上限・窓口", () => {
  test("役の名前と短い説明は広告のチームと同じ。分身だけ「書きそう」", () => {
    assert.deepEqual(POST_ROLE_NAME, ROLE_NAME);
    assert.equal(POST_ROLE_DESC.twin, "「あなたならこう書きそう」を言う係");
    for (const k of ["researcher", "opposition", "aide"] as const) assert.equal(POST_ROLE_DESC[k], ROLE_DESC[k]);
  });

  test("postsTeam の上限は全部 config/ai.json にあり、モデルは広告のチームと同じ値。窓口は /api/ai/ の下", () => {
    const ai = JSON.parse(readFileSync(join(__dirname, "../../../../config/ai.json"), "utf8"));
    for (const k of ["maxReplyTokens", "maxCalls", "maxTwinEdits", "maxPicks", "maxLineChars", "maxDraftChars", "maxRequestChars"])
      assert.ok(Number.isInteger(ai.postsTeam[k]) && ai.postsTeam[k] > 0, k);
    assert.equal(getPostsTeamAiSettings().model, getAdsTeamAiSettings().model);
    const route = readFileSync(join(__dirname, "../../../app/api/ai/posts/team/route.ts"), "utf8");
    const view = readFileSync(join(__dirname, "../../../components/PostTeam.tsx"), "utf8");
    for (const t of [route, view]) assert.doesNotMatch(t, /maxCalls:\s*\d|maxTokens:\s*\d|\d+_000\b/);
    assert.match(view, /"\/api\/ai\/posts\/team"|askPostsTeam/);
    // 会議は保存・送信・公開をしない
    assert.doesNotMatch(view + route, /withSavedPost|fetch\("\/api\/line/);
  });

  test("下書きの中身の印は、中身が変われば変わる", () => {
    assert.notEqual(hashText("あいう。"), hashText("あいう！"));
    assert.equal(hashText("あいう。"), hashText("あいう。"));
  });

  test("発信のチームは広告の判断に結びついた物を使わない（共有は名前・見た目・Claude を呼ぶ薄い所まで）", () => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const dir = join(__dirname, "../team");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      const imports = [...src.matchAll(/from "([^"]*ads[^"]*)"/g)].map((m) => m[1]);
      for (const i of imports) assert.ok(["../../ads/team/types", "../../ads/team/claude"].includes(i), `${f}: ${i}`);
    }
  });
});
