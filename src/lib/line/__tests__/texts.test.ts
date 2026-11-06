// オーナーが LINE で読む文を固定するテスト（頼み「LINE：オーナーが読む LINE の文を直す」の 1〜14）。
// Claude と LINE は呼ばない（決まった返事の振り分け・置きかえた LINE・このプロセスの中の置き場所）。
// 予約の隙間に1分で読む文なので、短く・1回で分かる形を文ごと固定する。

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { EMPTY_ADS, pendingAd, withProposal, type AdsState } from "../../ads/state";
import { buildTable } from "../../ads/report";
import { emptyBook, pendingApprovals, withHold } from "../../book/state";
import { addDays, shopToday } from "../../calendar";
import { getAds } from "../../data/seed";
import { findSlots } from "../../ai/slots";
import { comboOwnerReason, runTool } from "../../ai/tools";
import { NO_REAL_NAMES_NOTE } from "../../notices";
import { getRules } from "../../rules/store";
import type { Customer } from "../../data/types";
import type { Rule } from "../../rules/types";
import { getAdSettings, getAiSettings, getLineSettings } from "../../settings";
import { at, bookedAt, ctxAt, customers, menus, shop } from "../../ai/__tests__/helpers";
import type { LineClient } from "../api";
import { applyAsk, applyPress, karteTargetFor, refusalReply, reservationCard } from "../apply";
import { parseLineAskRequest, runLineAsk, searchedAlternatives, type LineAskResponse } from "../ask";
import { handleWebhook, pollScreen, sendFromScreen, startLink, type BridgeDeps } from "../bridge";
import { LINE_TEXT, sentStatus, withPeriod } from "../messages";
import { morningText } from "../morning";
import { maskNames, scriptSortModel } from "../sort";
import { memoryStore } from "../store";
import type { ScreenEvent } from "../wire";

const now = at("2026-11-04", "09:00"); // 水曜 9:00
const nowIso = now.toISOString();
const today = shopToday(shop, now).today;
const model = scriptSortModel({ menus, today });

/** 「縮毛矯正とヘッドスパは同じ日に受けない」（チェック無し＝お客様に伝えない） */
const PAIR: Rule = { id: "own-pair", level: "menu", menuId: "straight", label: "縮毛矯正とヘッドスパは同じ日に受けない", check: { kind: "notTogether", with: "headspa" } };
/** 同じルールで「お客様に伝える」にチェック有り */
const PAIR_TOLD: Rule = { ...PAIR, tellCustomer: true };
const PAIR_ASK = "明日10時に青木さん縮毛矯正とヘッドスパで仮押さえ";

async function ask(text: string, extra: Rule[] = []) {
  const { masked, found } = maskNames(text, customers);
  const parsed = parseLineAskRequest(
    {
      mode: "script",
      text: masked,
      customer: found.length === 1 ? found[0] : null,
      booked: bookedAt(now),
      rules: [...getRules().filter((r) => !r.locked), ...extra],
      dayOffset: 0,
    },
    menus,
    getAiSettings(),
    getLineSettings().maxTextChars,
  );
  assert.ok(parsed.ok);
  const res = await runLineAsk({ req: parsed.value, shop, menus, model, maxTokens: 300, now });
  assert.ok(res.ok, JSON.stringify(res));
  return { res, found };
}

function applyCtx(found: Customer[], karte: ReturnType<typeof karteTargetFor> = null) {
  return { shop, menus, customers, nowIso, today: today.date, adSettings: getAdSettings(), found, karte, memoMax: 1500 };
}

/** 一言を送って、LINE に返す文（と、いっしょに付くカード）を得る */
async function replyTo(text: string, extra: Rule[] = []) {
  const { res, found } = await ask(text, extra);
  const ev: ScreenEvent = { id: "e1", at: nowIso, kind: "text", text };
  return { res, out: applyAsk(ev, res as Extract<LineAskResponse, { ok: true }>, emptyBook(today.date), EMPTY_ADS, applyCtx(found)) };
}

const refusals = (s: string) => (s.match(/受けられません|お受けできません/g) ?? []).length;

describe("1. 組み合わせのルールの断り（「お客様に伝える」のチェック有り・無し）", () => {
  test("チェック無し：オーナー向けの理由は「「…」という決まりがあるので、この組み合わせではお受けできません。」で、代わりは1行に1つ", async () => {
    const { res, out } = await replyTo(PAIR_ASK, [PAIR]);
    assert.ok(res.kind === "hold-no");
    assert.equal(res.reason, "「縮毛矯正とヘッドスパは同じ日に受けない」という決まりがあるので、この組み合わせではお受けできません。");
    assert.equal(res.searched, true);
    assert.equal(
      out.reply,
      [
        "✗ 11/5（木） 10:00–13:30 縮毛矯正＋ヘッドスパ：「縮毛矯正とヘッドスパは同じ日に受けない」という決まりがあるので、この組み合わせではお受けできません。",
        "代わり：",
        "・11/5（木） 10:00–10:30 ヘッドスパ",
        "・11/5（木） 10:00–13:00 縮毛矯正",
      ].join("\n"),
    );
  });

  test("チェック有り：オーナー向けの理由はチェック無しと同じ文。代わりは探していないので「代わりは見つかりませんでした」と書かない", async () => {
    const { res, out } = await replyTo(PAIR_ASK, [PAIR_TOLD]);
    assert.ok(res.kind === "hold-no");
    assert.equal(res.reason, comboOwnerReason(PAIR.label));
    assert.equal(res.searched, false);
    assert.deepEqual(res.alternatives, []);
    assert.equal(
      out.reply,
      "✗ 11/5（木） 10:00–13:30 縮毛矯正＋ヘッドスパ：「縮毛矯正とヘッドスパは同じ日に受けない」という決まりがあるので、この組み合わせではお受けできません。",
    );
    assert.doesNotMatch(out.reply, /代わり/);
  });

  test("お客様に出す理由と候補は変えない（チェック有りは候補を出さない・AI に返す content にオーナー向けの理由は入れない）", () => {
    const ctx = ctxAt(now, { rules: [...getRules(), PAIR_TOLD] });
    const o = runTool(ctx, "check_rules", { menu_ids: ["straight", "headspa"], date: addDays(today.date, 1), start: "10:00" });
    const content = JSON.parse(o.content) as { ok: boolean; reason: string; candidates: unknown[] };
    assert.equal(content.ok, false);
    assert.deepEqual(content.candidates, []);
    assert.equal(o.hidden, undefined);
    assert.notEqual(content.reason, o.ownerReason);
    assert.ok(!o.content.includes("という決まりがあるので"));
  });

  test("「探していない」「探したが0件」「候補あり」の3つを分ける", async () => {
    // 探していない（チェック有りの組み合わせ）
    const none = await replyTo(PAIR_ASK, [PAIR_TOLD]);
    assert.ok(none.res.kind === "hold-no" && !none.res.searched && none.res.alternatives.length === 0);
    assert.doesNotMatch(none.out.reply, /代わり/);

    // 探したが0件（カットはどこにも入らないルール）
    const NO_CUT: Rule = { id: "own-ls", level: "menu", menuId: "cut", label: "カットは9:00まで", check: { kind: "lastStart", time: "09:00" } };
    const zero = await replyTo("明日15時に青木さんカットで仮押さえ", [NO_CUT]);
    assert.ok(zero.res.kind === "hold-no" && zero.res.searched && zero.res.alternatives.length === 0);
    assert.equal(
      zero.out.reply,
      "✗ 11/5（木） 15:00–16:00 カット：「カットは9:00まで」という決まりがあるので、お受けできません（15:00は最終受付（09:00）を過ぎています）。\n代わりは見つかりませんでした。",
    );

    // 候補あり
    const some = await replyTo("今日11時に石田さんカットで仮押さえ");
    assert.ok(some.res.kind === "hold-no" && some.res.searched && some.res.alternatives.length > 0);
    assert.match(some.out.reply, /\n代わり：\n・/);
  });

  test("道具の答えの形から「探したか」を読む（入力がおかしい時も探していない）", () => {
    assert.equal(searchedAlternatives({}), true);
    assert.equal(searchedAlternatives({ combo: true, hidden: true }), true);
    assert.equal(searchedAlternatives({ combo: true }), false);
    assert.equal(searchedAlternatives({ isError: true }), false);
  });
});

describe("2. 断りの返事：「✗ {日時 メニュー}：{理由}」で、断りの言葉は1回だけ", () => {
  test("3時間前", async () => {
    const { out } = await replyTo("今日11時に石田さんカットで仮押さえ");
    assert.equal(
      out.reply,
      [
        "✗ 11/4（水） 11:00–12:00 カット：「予約は来店の3時間前まで」という決まりがあるので、お受けできません（来店まで2時間しかありません）。",
        "代わり：",
        "・11/4（水） 12:00–13:00 カット",
        "・11/4（水） 18:30–19:30 カット",
      ].join("\n"),
    );
    assert.equal(refusals(out.reply), 1);
  });

  test("営業時間（理由が「。」で終わらないので「。」を足す）", async () => {
    const { out } = await replyTo("明日19:30に青木さんカットで仮押さえ");
    assert.equal(
      out.reply,
      [
        "✗ 11/5（木） 19:30–20:30 カット：営業時間に収まらないので、お受けできません（閉店（20:00）までに終わりません）。",
        "代わり：",
        "・11/6（金） 17:30–18:30 カット",
        "・11/6（金） 19:00–20:00 カット",
      ].join("\n"),
    );
    assert.equal(refusals(out.reply), 1);
  });

  test("定休日", async () => {
    const { out } = await replyTo("11月10日15時に青木さんカットで仮押さえ");
    assert.equal(
      out.reply,
      ["✗ 11/10（火） 15:00–16:00 カット：その日はお休み（定休日）なので、お受けできません。", "代わり：", "・11/11（水） 15:00–16:00 カット", "・11/11（水） 16:30–17:30 カット"].join(
        "\n",
      ),
    );
    assert.equal(refusals(out.reply), 1);
  });

  test("形だけ：「。」を2つにしない・代わりは1行に1つ", () => {
    assert.equal(refusalReply("11/6（金） 10:00–11:00 カット", "その時間はお受けできません。", [], true), "✗ 11/6（金） 10:00–11:00 カット：その時間はお受けできません。\n代わりは見つかりませんでした。");
    assert.equal(refusalReply("X", "お受けできません（理由）", ["A", "B"], true), "✗ X：お受けできません（理由）。\n代わり：\n・A\n・B");
    assert.equal(refusalReply("X", "お受けできません。", [], false), "✗ X：お受けできません。");
    assert.equal(withPeriod("あ。"), "あ。");
    assert.equal(withPeriod("あ"), "あ。");
  });
});

describe("3〜6. カルテのメモ・朝の要点・仮押さえ・いっしょに届くカード", () => {
  test("3. カルテのメモの返事はオーナーに向けた言い方", async () => {
    const booked = bookedAt(now);
    const todays = booked.filter((b) => b.date === today.date && b.status === "confirmed");
    const c = customers.find((x) => x.id === todays[0].customerId)!;
    const text = `${c.surname}さん カルテのメモ：前髪は眉の上`;
    const { res, found } = await ask(text);
    const karte = karteTargetFor(found, todays.map((b) => ({ customerId: b.customerId, date: b.date, status: b.status })), emptyBook(today.date));
    const ev: ScreenEvent = { id: "e1", at: nowIso, kind: "text", text };
    const out = applyAsk(ev, res as Extract<LineAskResponse, { ok: true }>, emptyBook(today.date), EMPTY_ADS, applyCtx(found, karte));
    assert.equal(out.reply, `カルテのメモに入れました：${c.surname}様（今日）。カルテにして保存するのは、画面のカルテのタブでどうぞ。`);
    assert.doesNotMatch(out.reply, /人が押します/);
  });

  test("4. 朝の要点：空きの数え方を1回で・次回提案が空なら「なし」", () => {
    const text = morningText({
      shopName: "omochi",
      todayLabel: "11/4（水）",
      items: [
        { start: "10:00", end: "11:00", surname: "青木", menu: "カット", hold: false, next: [] },
        { start: "13:00", end: "14:30", surname: "石田", menu: "カラー", hold: true, next: ["前髪を短く"] },
      ],
      open: true,
      free: { ranges: [{ start: "17:00", end: "20:00", free: 1 }], seatSlots: 6 },
      slotMinutes: 30,
    });
    assert.equal(
      text,
      [
        "omochi 朝の要点（11/4（水））",
        "",
        "■ 今日の予約 2件",
        "・10:00–11:00 青木様 カット",
        "　前回の次回提案：なし",
        "・13:00–14:30 石田様 カラー（仮押さえ）",
        "　前回の次回提案：前髪を短く",
        "",
        "■ 今日の空き（これから）：30分の枠が合わせて6つ",
        "・17:00–20:00 空き1席",
        "",
        "✓ 台帳と席の数からプログラムが数えました",
      ].join("\n"),
    );
    const many = morningText({ shopName: "omochi", todayLabel: "x", items: [], open: true, free: { ranges: [{ start: "10:00", end: "20:00", free: 1 }], seatSlots: 20 }, slotMinutes: 30 });
    assert.match(many, /\n■ 今日の空き（これから）：30分の枠が合わせて20個\n/);
    const full = morningText({ shopName: "omochi", todayLabel: "x", items: [], open: true, free: { ranges: [], seatSlots: 0 }, slotMinutes: 30 });
    assert.match(full, /\n■ 今日の空き（これから）：ありません\n/);
    const closed = morningText({ shopName: "omochi", todayLabel: "x", items: [], open: false, free: { ranges: [], seatSlots: 0 }, slotMinutes: 30 });
    assert.match(closed, /\n■ 今日の空き：今日はお休みです\n/);
    assert.doesNotMatch(text + many + full, /× 席|（空でした）/);
  });

  test("5・6. 仮押さえの返事と、いっしょに届くカードの最後の行（作った直後なので「でも」は付けない）", async () => {
    const { out } = await replyTo("明日15時に青木さんカットで仮押さえ");
    assert.equal(out.reply, "仮押さえしました：青木様 11/5（木） 15:00–16:00 カット。確定はまだです。下のボタンか、画面の承認の箱で決めてください。");
    assert.equal(out.card?.check, "✓ いまの台帳とルールで受けられます");
  });

  test("6. 後から画面が LINE に届けるカードは「いまの台帳とルールでも」のまま", () => {
    const ctx = ctxAt(now);
    const slot = findSlots(ctx, "cut", { date: addDays(ctx.today.date, 1) }).slots[0];
    const book = withHold(emptyBook(ctx.today.date), { id: "h1", customerId: "c01", ...slot, heldAt: nowIso, expiresAt: new Date(now.getTime() + 3600_000).toISOString(), reason: "r" });
    const row = pendingApprovals(book, nowIso)[0];
    assert.equal(reservationCard(row, { shop, menus, customers }, true).check, "✓ いまの台帳とルールでも受けられます");
    assert.equal(reservationCard(row, { shop, menus, customers }, false).check, "✗ いまの台帳・ルールでは受けられません。画面で確かめてください");
    assert.equal(reservationCard(row, { shop, menus, customers }).check, "承認＝確定して台帳に入ります。見送り＝仮押さえを外します");
  });
});

describe("7・12. ボタンの返事（承認・見送り・もう決まった行）", () => {
  const actx = { shop, menus, customers, nowIso, today: today.date, adSettings: getAdSettings() };
  const press = (approvalId: string, target: "reservation" | "ad", how: "approve" | "skip"): Extract<ScreenEvent, { kind: "press" }> => ({
    id: `p-${approvalId}-${how}`,
    at: nowIso,
    kind: "press",
    approvalId,
    target,
    how,
  });

  function withAd(): AdsState {
    const table = buildTable(getAds(), getAdSettings());
    const row = table.keywords[0];
    return withProposal(EMPTY_ADS, { action: "stop", no: row.no, text: row.text, reason: "予約につながっていません。" }, table, { id: "ad1", checks: [], nowIso, mode: "script" }, getAdSettings());
  }

  test("7. 広告の案の承認：「で」の後に空白を入れない", () => {
    const ads = withAd();
    const p = pendingAd(ads)!;
    const out = applyPress(press(p.id, "ad", "approve"), emptyBook(today.date), ads, actx);
    assert.equal(out.reply, `✓ ${getAdSettings().channel}で${p.no}番「${p.text}」を止めました`);
    const skip = applyPress(press(p.id, "ad", "skip"), emptyBook(today.date), ads, actx);
    assert.equal(skip.reply, `見送りました：広告の案「${p.no}番「${p.text}」を止める」を閉じました`);
  });

  test("承認と見送り（予約の仮押さえ）", () => {
    const ctx = ctxAt(now);
    const slot = findSlots(ctx, "cut", { date: addDays(ctx.today.date, 1) }).slots[0];
    const book = withHold(emptyBook(ctx.today.date), { id: "h1", customerId: "c01", ...slot, heldAt: nowIso, expiresAt: new Date(now.getTime() + 3600_000).toISOString(), reason: "r" });
    const ok = applyPress(press("ap-h1", "reservation", "approve"), book, EMPTY_ADS, actx);
    assert.equal(ok.reply, "✓ 確定しました：青木様 11/5（木） 10:00–11:00 カット");
    const skip = applyPress(press("ap-h1", "reservation", "skip"), book, EMPTY_ADS, actx);
    assert.equal(skip.reply, "見送りました：仮押さえを外し、ToDo に「青木様に別の日時を案内」を足しました");
  });

  test("12. もう決まった行：何の行かが分かる言い方（予約と広告で同じ形）", () => {
    const r = applyPress(press("ap-none", "reservation", "approve"), emptyBook(today.date), EMPTY_ADS, actx);
    assert.equal(r.reply, "この仮押さえは、もう決まっているか、期限が切れています。今の様子は画面で確かめてください。");
    const a = applyPress(press("ad-none", "ad", "approve"), emptyBook(today.date), EMPTY_ADS, actx);
    assert.equal(a.reply, "この広告の案は、もう決まっているか、期限が切れています。今の様子は画面で確かめてください。");
  });
});

describe("8・9・11・14. 決まった文", () => {
  test("8. 振り分けられなかった時は「短くして」と言わない・「。。」にしない", () => {
    assert.equal(LINE_TEXT.retry("送る物が大きすぎます"), "うまくいきませんでした。送る物が大きすぎます。もう一度送ってください。");
    assert.equal(LINE_TEXT.retry("つながりませんでした。"), "うまくいきませんでした。つながりませんでした。もう一度送ってください。");
    assert.doesNotMatch(LINE_TEXT.retry("x"), /短く/);
  });

  test("9. つながった時：何の時間かが分かる（数は設定の linkHours）", () => {
    const h = getLineSettings().linkHours;
    assert.equal(LINE_TEXT.linked(h), `LINE とつながりました（${h}時間有効です）。画面を開いている間だけ動きます。例：「明日15時に青木さんカットで仮押さえ」「シャンプー発注」`);
  });

  test("11. LINE に送る6けたの印は「つなぐ番号」。オーナー用の合言葉と言葉を分ける", () => {
    assert.equal(LINE_TEXT.askCode, "つなぐ番号を送ってください（画面のホームの「LINE とつなぐ」に出ます）。");
    assert.equal(LINE_TEXT.wrongCode, "つなぐ番号が違うか、期限が切れています。画面の「LINE とつなぐ」で新しいつなぐ番号を出してください。");
    assert.equal(LINE_TEXT.tooMany, "つなぐ番号を何回も試したので、10分ほど待ってから送ってください。");
    assert.equal(LINE_TEXT.followHello, `${NO_REAL_NAMES_NOTE}。\nつなぐ番号を送ってください（画面のホームの「LINE とつなぐ」に出ます）。`);
    for (const v of Object.values(LINE_TEXT)) assert.doesNotMatch(typeof v === "string" ? v : v.toString(), /合言葉/);
    // ホームの「LINE とつなぐ」と、画面の働き手の文（説明の行は除く）：合言葉は「オーナー用の合言葉」だけ
    for (const f of ["src/app/home/LinePanel.tsx", "src/components/LineBridge.tsx"]) {
      const code = readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
        .join("\n")
        .replaceAll("オーナー用の合言葉", "");
      assert.doesNotMatch(code, /合言葉/, f);
    }
    assert.match(readFileSync("src/app/home/LinePanel.tsx", "utf8"), /このつなぐ番号を送ってください/);
  });

  test("14. 画面の LINE の様子：何を数えるかが分かる", () => {
    assert.equal(sentStatus("push", "朝の要点"), "LINE に送りました（今日の送信数に数えます）：朝の要点");
    assert.equal(sentStatus("reply", "ToDo に足しました"), "LINE に返事しました：ToDo に足しました");
  });
});

describe("10. LINE の文から「（架空）」を外す（友だち追加の注意の1行は残す）", () => {
  const files = [
    ...readdirSync("src/lib/line")
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join("src/lib/line", f)),
    "src/components/LineBridge.tsx",
    "src/app/home/LinePanel.tsx",
  ];

  test("LINE の文を作るファイルに「（架空）」「（架空の店）」が無い", () => {
    for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), /（架空(の店)?）/, f);
  });

  test("友だち追加の時の注意の1行（架空の店のデモです。本名や連絡先は入れないでください）は残す", () => {
    assert.equal(LINE_TEXT.noRealNames, "架空の店のデモです。本名や連絡先は入れないでください。");
    assert.ok(LINE_TEXT.followHello.startsWith("架空の店のデモです。本名や連絡先は入れないでください。\n"));
  });
});

describe("13. 送る上限の文（数は設定のまま）", () => {
  let clock = Date.parse("2026-11-04T09:00:00+09:00");
  let seq = 0;
  let status = 200;
  const line: LineClient = {
    reply: async () => ({ ok: true, status: 200 }),
    push: async () => ({ ok: status === 200, status }),
  };
  let d: BridgeDeps;

  beforeEach(() => {
    clock = Date.parse("2026-11-04T09:00:00+09:00");
    seq = 0;
    status = 200;
    d = {
      store: memoryStore(() => clock),
      line,
      settings: { ...getLineSettings(), dailyPushLimit: 1 },
      timezone: shop.timezone,
      now: () => new Date(clock),
      random: (n) => {
        seq += 1;
        const b = Buffer.alloc(n);
        for (let i = 0; i < n; i++) b[i] = (seq * 31 + i * 7) & 0xff;
        return b;
      },
    };
  });

  async function linkedToken(): Promise<string> {
    const s = await startLink(d);
    assert.ok(s.ok);
    await handleWebhook(d, { events: [{ type: "message", replyToken: "rt", webhookEventId: "we", source: { type: "user", userId: "U-owner" }, message: { type: "text", text: s.code } }] });
    const p = await pollScreen(d, s.token);
    assert.ok(p.ok && p.linked);
    return s.token;
  }

  test("今日の上限・今月の上限", async () => {
    const token = await linkedToken();
    const send = () => sendFromScreen(d, { token, messages: [{ type: "text", text: "朝の要点" }] });
    status = 429;
    const month = await send();
    assert.deepEqual(month, { ok: false, code: "limit", message: "LINE の今月の送信が上限に達しました" });
    status = 200;
    const day = await send();
    assert.deepEqual(day, { ok: false, code: "limit", message: "今日の LINE の送信が上限（1通）に達しました" });
  });
});
