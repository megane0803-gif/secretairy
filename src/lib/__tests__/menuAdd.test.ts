// オーナーがメニューを足す・消す（ルールのタブの「メニュー」。menuEdits.ts）と、メニューの欄を畳むテスト。Claude と LINE は呼ばず、決まった返事に置きかえる。
// - 名前・時間・値段・最終受付・色・数の上限の確かめ／id は使い回さない
// - サーバーが足したメニューの形を確かめる（おかしい物・知らない id の形・includes つき・上限越えを断る）
// - 足したメニューで、予約チャット・料金の答え・LINE の一言・AI の仕事・ルールの試し・承認BOX・予約サイトが動く（画面とサーバー）
// - 台帳で使われている間は消せない／保存できなかった時／日誌／メニューの印／「最初に戻す」で足したメニューとそれを使った予約が消える
// - 開き直しで足したメニューが戻る・直しF の形の保存が読める／畳んだ行の中身と、直しかけの印

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MenuPanel, MenuRowHead } from "../../app/rules/MenuPanel";
import { runReserve } from "../ai/agent";
import { at, bookedAt, chat } from "../ai/__tests__/helpers";
import { MENU_DATA_NOTE } from "../ai/menuData";
import { priceAnswer } from "../ai/prices";
import { contextFor, parseReserveRequest } from "../ai/request";
import { reserveSystem } from "../ai/reservePrompt";
import { holdInto } from "../ai/reserveStream";
import { scriptModel } from "../ai/script";
import { judgeSlot } from "../ai/slots";
import type { ReserveEvent } from "../ai/wire";
import { EMPTY_ACCOUNTING } from "../accounting/state";
import { EMPTY_ADS } from "../ads/state";
import { getBookData, type BookData } from "../book/data";
import { ledgerView, siteBook } from "../book/site";
import { emptyBook, parseBook, pendingApprovals, withHold, type BookState } from "../book/state";
import { BOOK_KEY, BROWSER_PREFIX, JOURNAL_KEY, readBrowser, writeBrowser } from "../browser";
import { calDay } from "../calendar";
import { resolveMenu } from "../combo";
import { getCustomers } from "../data/seed";
import { runJob, type JobAsk, type JobEnv } from "../jobs/run";
import { EMPTY_JOBS } from "../jobs/state";
import { parseJournal } from "../journal";
import { parseLineAskRequest, runLineAsk } from "../line/ask";
import { maskNames, scriptSortModel, sortSystem } from "../line/sort";
import {
  commitMenus,
  defaultMenuColor,
  isOwnMenuId,
  menuChanges,
  menuColorChoices,
  menuEditsRaw,
  menuJournalLines,
  menuLimitsOf,
  menuNameProblem,
  MENUS_KEY,
  menusMark,
  menuUses,
  nextOwnId,
  ownMenuProblem,
  ownNamesProblem,
  parseMenuEdits,
  readMenus,
  readMenuStore,
} from "../menuEdits";
import { resetAll, resetAllWrites } from "../reset";
import { judge } from "../rules/judge";
import { getRules } from "../rules/store";
import type { Rule } from "../rules/types";
import { ruleWordsSystem, runRuleWords, scriptRuleReader } from "../rules/words";
import { getAiSettings, getJobsSettings, getLineSettings, getMenus, getShop, type Menu } from "../settings";
import { rescheduleTitle } from "../todo/reschedule";

const ROOT = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const shop = getShop();
const base = getMenus();
const customers = getCustomers();
const ai = getAiSettings();
const lim = menuLimitsOf(shop);
// 水曜の朝（開店前）に開いた。11/6（金）は 10:30 パーマ（大橋様）・16:00 カット（加藤様）
const NOW = at("2026-11-04", "08:30");
const NOW_SHOP = { date: "2026-11-04", time: "08:30" };

/** 足したトリートメント（30分・3,000円・最終受付 19:00） */
const TREAT: Menu = { id: "own-1", name: "トリートメント", minutes: 30, price: 3000, lastStart: "19:00", color: "sky" };
const WITH = [...base, TREAT];
const dataWith = (menus: Menu[]): BookData => ({ ...getBookData(), menus });
const sent = (menus: Menu[]) => JSON.parse(JSON.stringify(menus)) as Record<string, unknown>[];

// ── テストの中だけのブラウザ（書けない置き場所を選べる） ───────────────────
const store = new Map<string, string>();
let failKey: string | null = null;
const g = globalThis as { window?: unknown };
let had: unknown;
before(() => {
  had = g.window;
  g.window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (failKey && k === BROWSER_PREFIX + failKey) {
          const e = new Error("The quota has been exceeded.");
          e.name = "QuotaExceededError";
          throw e;
        }
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    },
    addEventListener() {},
    removeEventListener() {},
  };
});
after(() => {
  g.window = had;
});
beforeEach(() => {
  store.clear();
  failKey = null;
});

describe("1. 足すメニューの名前・数・色の確かめ", () => {
  test("名前のおかしい値を断る：空・21字・改行・同じ名前（設定の物・足した物・全角半角ちがい）・「＋」", () => {
    for (const bad of ["", "   ", "あ".repeat(21), "トリート\nメント", "トリート\rメント", "カット", " カラー ", "トリートメント", "ﾄﾘｰﾄﾒﾝﾄ", "カット＋スパ", "cut+spa", 12, null])
      assert.ok(menuNameProblem(bad, WITH, lim), JSON.stringify(bad));
    assert.match(menuNameProblem("あ".repeat(21), base, lim)!, /20字/);
    assert.match(menuNameProblem("トリート\nメント", base, lim)!, /改行/);
    assert.match(menuNameProblem("カット", base, lim)!, /同じ名前/);
    for (const ok of ["トリートメント", "あ".repeat(20), "  眉カット  ", "炭酸スパ", "SPA", "Aライン"]) assert.equal(menuNameProblem(ok, base, lim), null, ok);
  });

  test("英字が長く続く名前（返事の門と同じ目安）と、店の中の決まりの言葉が入った名前を断る", () => {
    assert.ok(menuNameProblem("Deep Repair Treatment", base, lim), "英字の単語が3つ続く");
    assert.ok(menuNameProblem("TREATMENTSPECIALCARE", base, lim), "英字が20字");
    assert.ok(menuNameProblem("15分あけるスパ", base, lim), "何分あけるかの形");
    const rules: Rule[] = [{ id: "own-buf", level: "global", label: "準備に手間取る", check: { kind: "text" } }];
    assert.match(menuNameProblem("準備に手間取るケア", base, lim, rules)!, /店の中の決まり/);
    assert.equal(menuNameProblem("準備に手間取るケア", base, lim, []), null);
    assert.ok(ownNamesProblem([...base, { ...TREAT, name: "準備に手間取るケア" }], rules));
    assert.equal(ownNamesProblem(WITH, rules), null);
  });

  test("時間・値段・最終受付は直しF と同じ幅ときざみ・色は今あるメニューの色から", () => {
    const ok = (over: Partial<Menu> & Record<string, unknown>) => ownMenuProblem({ ...TREAT, ...over }, base, base, lim);
    assert.equal(ok({}), null);
    for (const over of [{ minutes: 45 }, { minutes: 330 }, { minutes: 0 }, { price: -1 }, { price: 100001 }, { price: 1.5 }, { lastStart: "21:00" }, { lastStart: "18:10" }, { lastStart: undefined }])
      assert.ok(ok(over), JSON.stringify(over));
    assert.ok(ok({ color: "gold" }), "知らない色");
    assert.ok(ok({ color: undefined }), "色なし");
    assert.deepEqual(menuColorChoices(base), ["sky", "purple", "pink", "green", "rose", "olive"]);
    // 最初の色：まだ使われていない色。全部使われていれば一覧の最初の色
    assert.equal(defaultMenuColor(base, base), "sky");
    assert.equal(defaultMenuColor(base, base.filter((m) => m.color !== "green")), "green");
  });

  test("足せるのは単品だけ（includes は作らない）・id の形は own-数", () => {
    assert.match(ownMenuProblem({ ...TREAT, includes: ["cut"] }, base, base, lim)!, /組み合わせ/);
    for (const id of ["own-0", "own-x", "own-", "own-01", "treat", "own-1+cut", "cut"]) assert.ok(!isOwnMenuId(id) || id === "cut", id);
    assert.ok(isOwnMenuId("own-1") && isOwnMenuId("own-12"));
    assert.ok(ownMenuProblem({ ...TREAT, id: "own-x" }, base, base, lim));
  });

  test("数の上限（config/shop.json の menuLimits.maxAdded）", () => {
    assert.equal(lim.maxAdded, 10);
    assert.equal(lim.maxNameChars, 20);
    assert.match(read("config/shop.json"), /"maxAdded": 10, "maxNameChars": 20/);
  });

  test("設定に無い組み合わせは、足したメニューとも作れる（時間と値段を足す）", () => {
    const m = resolveMenu(WITH, "cut+own-1");
    assert.equal(m?.name, "カット＋トリートメント");
    assert.equal(m?.minutes, 90);
    assert.equal(m?.price, 7800);
  });
});

describe("2. id はプログラムが付け、消しても使い回さない", () => {
  test("own-1, own-2 と付き、own-2 を消しても次は own-3。「最初に戻す」の後は own-1 から", () => {
    assert.equal(nextOwnId(base, 0), "own-1");
    const one = [...base, TREAT];
    commitMenus(one, base, base, shop);
    const two = [...one, { ...TREAT, id: nextOwnId(one, readMenuStore(readBrowser(MENUS_KEY), base, shop).seq), name: "炭酸スパ" }];
    assert.equal(two.at(-1)!.id, "own-2");
    commitMenus(two, one, base, shop);
    // own-2 を消す
    commitMenus(one, two, base, shop);
    const back = readMenuStore(readBrowser(MENUS_KEY), base, shop);
    assert.deepEqual(back.menus.map((m) => m.id).slice(-1), ["own-1"]);
    assert.equal(back.seq, 2);
    assert.equal(nextOwnId(back.menus, back.seq), "own-3");
    // 全部消しても番号は残す
    commitMenus(base, one, base, shop);
    const none = readMenuStore(readBrowser(MENUS_KEY), base, shop);
    assert.equal(none.menus, base);
    assert.equal(nextOwnId(none.menus, none.seq), "own-3");
    resetAll("2026-11-04");
    const reset = readMenuStore(readBrowser(MENUS_KEY), base, shop);
    assert.equal(nextOwnId(reset.menus, reset.seq), "own-1");
  });
});

describe("3. サーバー：足したメニューは形を確かめてから受ける（readMenus）", () => {
  test("正しい足したメニューは受け、設定のメニューの後ろに並ぶ（edited: true）", () => {
    const r = readMenus(sent(WITH), base, shop);
    assert.ok(r.ok && r.edited);
    if (r.ok) assert.deepEqual(r.value.at(-1), TREAT);
  });

  test("おかしい物・知らない id の形・includes つき・上限越え・名前の重なり・色の外を断る", () => {
    const one = (over: Record<string, unknown>) => readMenus([...sent(base), { ...TREAT, ...over }], base, shop);
    assert.equal(readMenus([...sent(base), { ...TREAT, id: "treat" }], base, shop).ok, false, "own- でない知らない id");
    for (const over of [
      { id: "own-0" },
      { id: "own-a" },
      { includes: ["cut"] },
      { name: "カット" },
      { name: " トリートメント" },
      { name: "" },
      { name: "あ".repeat(21) },
      { name: "a\nb" },
      { name: "Deep Repair Treatment" },
      { name: "15分あけるケア" },
      { color: "gold" },
      { minutes: 45 },
      { price: -1 },
      { lastStart: "20:30" },
      { lastStart: undefined },
    ])
      assert.equal(one(over).ok, false, JSON.stringify(over));
    assert.equal(readMenus([...sent(base), TREAT, { ...TREAT }], base, shop).ok, false, "同じ id が2つ");
    assert.equal(readMenus([...sent(base), TREAT, { ...TREAT, id: "own-2" }], base, shop).ok, false, "同じ名前が2つ");
    const many = Array.from({ length: lim.maxAdded + 1 }, (_, i) => ({ ...TREAT, id: `own-${i + 1}`, name: `ケア${i + 1}` }));
    assert.equal(readMenus([...sent(base), ...many], base, shop).ok, false, "上限越え");
    assert.equal(readMenus([...sent(base), ...many.slice(0, lim.maxAdded)], base, shop).ok, true, "上限ちょうどは受ける");
    // 設定のメニューがそろっていない（足したメニューで数を合わせても断る）
    assert.equal(readMenus([...sent(base).slice(1), TREAT], base, shop).ok, false);
  });

  test("予約チャットの窓口：ルールの文の言葉が入った名前は、ルールを読んだ後にも断る", () => {
    const body = (menus: unknown, rules: unknown[] = []) => ({
      mode: "script",
      messages: [{ role: "user", text: "トリートメント" }],
      candidates: [],
      customer: { id: "c04", surname: "江口", firstVisit: false },
      booked: [],
      rules,
      visits: [],
      dayOffset: 0,
      menus,
    });
    const rule = { id: "own-x", level: "global", label: "準備に手間取る", check: { kind: "text" } };
    assert.ok(parseReserveRequest(body(sent(WITH), [rule]), base, ai).ok);
    assert.equal(parseReserveRequest(body([...sent(base), { ...TREAT, name: "準備に手間取るケア" }], [rule]), base, ai).ok, false);
    const p = parseReserveRequest(body(sent(WITH)), base, ai);
    assert.ok(p.ok);
    if (p.ok) assert.ok(contextFor(p.value, shop, base, NOW).menus.some((m) => m.id === "own-1"));
  });
});

describe("4. 足したメニューで、どの判定も動く（画面とサーバー）", () => {
  const c04 = customers.find((c) => c.id === "c04")!;
  const reserveCtx = (menus: Menu[]) => {
    const p = parseReserveRequest(
      {
        mode: "script",
        messages: [{ role: "user", text: "x" }],
        candidates: [],
        customer: { id: c04.id, surname: c04.surname, firstVisit: false },
        booked: bookedAt(NOW),
        rules: getRules().filter((r) => !r.locked),
        visits: [],
        dayOffset: 0,
        menus: sent(menus),
      },
      base,
      ai,
    );
    assert.ok(p.ok, p.ok ? "" : p.reason);
    let n = 0;
    return contextFor(p.value, shop, base, NOW, () => `h-add-${++n}`);
  };

  test("予約チャット（サーバー・決まった返事）：「トリートメントできますか」→ 候補 →「1つ目で」で 30分の仮押さえ", async () => {
    const ctx = reserveCtx(WITH);
    const first = await chat(ctx, [{ role: "user", text: "トリートメントできますか" }]);
    assert.ok(first.candidates?.length, first.text);
    assert.ok(first.candidates!.every((c) => c.menuId === "own-1"));
    assert.match(first.text, /トリートメント/);
    assert.doesNotMatch(first.text, /own-1/);
    const held = await chat({ ...ctx, shown: first.candidates! }, [
      { role: "user", text: "トリートメントできますか" },
      { role: "assistant", text: first.text },
      { role: "user", text: "1つ目で" },
    ]);
    assert.equal(held.holds.length, 1);
    assert.equal(held.holds[0].menuId, "own-1");
    // 台帳に入れると 30分の枠
    const s = withHold(emptyBook("2026-11-04"), { ...held.holds[0], reason: "テスト" });
    const r = ledgerView(dataWith(WITH), s, NOW).all.find((x) => x.id === held.holds[0].id)!;
    assert.equal(r.menu.name, "トリートメント");
    assert.equal(r.endMin - r.startMin, 30);
  });

  test("足したメニューを送らない（足す前の画面）と、トリートメントはメニューとして読まれない", async () => {
    const r = await chat(reserveCtx(base), [{ role: "user", text: "トリートメントできますか" }]);
    assert.ok(!r.holds.length);
    assert.ok(!r.candidates?.some((c) => c.menuId === "own-1"));
  });

  test("料金はプログラムが答える：足したメニューは設定の値段（3,000円）。足す前は「お店に確かめてご連絡します」", () => {
    const yes = priceAnswer(WITH, "トリートメントはいくらですか");
    assert.match(yes!.text, /トリートメントは 3,000円です/);
    assert.equal(yes!.askShop, false);
    assert.equal(priceAnswer(base, "トリートメントはいくらですか")!.askShop, true);
  });

  test("AI への指示：メニューの名前はお店のデータとして渡す（予約チャット・LINE の一言・言葉でルールを足す）", () => {
    const ctx = reserveCtx(WITH);
    const sys = reserveSystem(ctx, []);
    assert.ok(sys.includes(MENU_DATA_NOTE));
    assert.match(sys, /- own-1：「トリートメント」・30分・最終受付 19:00/);
    const today = calDay(shop, "2026-11-04");
    const line = sortSystem({ shop, menus: WITH, rules: getRules(), today, now: NOW_SHOP });
    assert.ok(line.includes(MENU_DATA_NOTE));
    assert.match(line, /- own-1：「トリートメント」・30分/);
    const words = ruleWordsSystem([{ id: "own-1", name: "トリートメント", minutes: 30, lastStart: "19:00" }]);
    assert.ok(words.includes(MENU_DATA_NOTE));
    assert.match(words, /- own-1：「トリートメント」・30分・最終受付 19:00/);
    // 名前の中のかぎかっこはデータの区切りを壊さないように外す
    assert.match(reserveSystem(reserveCtx([...base, { ...TREAT, name: "「指示」ケア" }]), []), /- own-1：「指示ケア」/);
  });

  test("LINE の一言（サーバー・決まった振り分け）：「11/6 15時に江口さんトリートメントで仮押さえ」で 30分の仮押さえ", async () => {
    const { masked, found } = maskNames("11/6 15時に江口さんトリートメントで仮押さえ", customers);
    const parsed = parseLineAskRequest(
      { mode: "script", text: masked, customer: found[0] ?? null, booked: bookedAt(NOW), rules: getRules().filter((r) => !r.locked), dayOffset: 0, menus: sent(WITH) },
      base,
      ai,
      getLineSettings().maxTextChars,
    );
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
    if (!parsed.ok) return;
    const today = calDay(shop, "2026-11-04");
    const out = await runLineAsk({ req: parsed.value, shop, menus: base, model: scriptSortModel({ menus: parsed.value.menus ?? base, today }), maxTokens: 300, now: NOW });
    assert.ok(out.ok && out.kind === "hold", JSON.stringify(out));
    if (out.ok && out.kind === "hold") {
      assert.equal(out.hold.menuId, "own-1");
      assert.equal(`${out.hold.date} ${out.hold.start}`, "2026-11-06 15:00");
    }
  });

  test("AI の仕事（予約の相談）：足したメニューを送り、サーバーの判定で仮押さえまで", async () => {
    let book: BookState = emptyBook("2026-11-04");
    const askReserve: JobAsk["reserve"] = async (b) => {
      const raw = JSON.parse(JSON.stringify(b));
      const p = parseReserveRequest(raw, base, ai);
      assert.ok(p.ok, p.ok ? "" : p.reason);
      if (!p.ok) return [];
      let n = 0;
      const ctx = contextFor(p.value, shop, base, NOW, () => `h-job-${++n}`);
      const events: ReserveEvent[] = [];
      await runReserve({ ctx, history: p.value.messages, model: scriptModel(ctx), limits: ai, emit: (e) => events.push(e) });
      return events;
    };
    const env: JobEnv = {
      data: dataWith(WITH),
      rules: getRules(),
      mode: "script",
      store: {
        book: () => book,
        setBook: (f) => void (book = f(book)),
        ads: () => EMPTY_ADS,
        setAds: () => {},
        accounting: () => EMPTY_ACCOUNTING,
        jobs: () => EMPTY_JOBS,
        setJobs: () => {},
      },
      ask: { reserve: askReserve } as JobAsk,
      journal: () => {},
      now: () => NOW,
      adSettings: {} as JobEnv["adSettings"],
      seeds: [{ id: "reserve", customerId: "c04", menuId: "own-1", day: 2, start: "15:00" }],
    };
    await runJob("reserve", env, { left: getJobsSettings().maxAiCallsPerPress });
    const rows = pendingApprovals(book, NOW.toISOString());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reservation.menuId, "own-1");
  });

  test("ルールの試し（judge）：足したメニューの最終受付と、足したメニューに付けたルールが効く", () => {
    const hours = calDay(shop, "2026-11-06").hours!;
    const j = (start: string, rules: Rule[] = []) =>
      judge({ rules, booking: { date: "2026-11-06", start, menuIds: ["own-1"], newCustomer: false }, now: NOW_SHOP, hours, seats: 1, menus: WITH, existing: [] });
    assert.equal(j("19:00").ok, true);
    assert.equal(j("19:30").ok, false);
    assert.match(j("19:30").base.find((b) => !b.ok)?.reason ?? "", /トリートメントの最終受付（19:00）を過ぎています/);
    const rule: Rule = { id: "own-r", level: "menu", menuId: "own-1", label: "トリートメントは18時まで", check: { kind: "lastStart", time: "18:00" } };
    assert.equal(j("18:30", [rule]).ok, false);
    assert.equal(j("17:30", [rule]).ok, true);
    assert.match(read("src/app/rules/RuleSide.tsx"), /const menus = book\.data\.menus;/);
  });

  test("言葉でルールを足す（決まった読み）：足したメニューの名前を読み、欄に入れる", async () => {
    const menus = WITH.map((m) => ({ id: m.id, name: m.name, minutes: m.minutes, lastStart: m.lastStart }));
    const out = await runRuleWords({ text: "トリートメントは最終受付18時", reader: scriptRuleReader(menus), menus, maxTokens: 300 });
    assert.equal(out.result.status, "filled", JSON.stringify(out.result));
    if (out.result.status === "filled") {
      assert.equal(out.result.draft.kind, "lastStart");
      assert.equal(out.result.draft.scope.level, "menu");
      assert.equal((out.result.draft.scope as { menuId: string }).menuId, "own-1");
      assert.doesNotMatch(out.result.label + (out.result.readback ?? ""), /own-1/);
    }
  });

  test("承認BOX（画面の judgeSlot）：足したメニューの仮押さえを、確定の前に台帳とルールで確かめる", () => {
    const hold = { id: "h-ap", customerId: "c04", menuId: "own-1", date: "2026-11-06", start: "15:00", heldAt: NOW.toISOString(), expiresAt: "2026-12-31T00:00:00.000Z", reason: "テスト" };
    const s = withHold(emptyBook("2026-11-04"), hold);
    const view = ledgerView(dataWith(WITH), s, NOW);
    const ctx = (menus: Menu[]) => ({
      shop,
      menus,
      rules: getRules(),
      booked: view.all.filter((r) => r.id !== hold.id).map((r) => ({ id: r.id, customerId: r.customer.id, menuId: r.menu.id, date: r.date, start: r.start, status: r.status, newCustomer: false })),
      customer: { id: "c04", surname: "江口", firstVisit: false },
      now: NOW_SHOP,
      today: calDay(shop, "2026-11-04"),
    });
    assert.equal(judgeSlot(ctx(WITH), hold).ok, true);
    // 60分にすると 16:00 のカットに重なる
    assert.equal(judgeSlot(ctx([...base, { ...TREAT, minutes: 90 }]), hold).ok, false);
    const row = pendingApprovals(s, NOW.toISOString())[0];
    assert.equal(row.reservation.menuId, "own-1");
    assert.equal(view.all.find((r) => r.id === hold.id)?.menu.name, "トリートメント");
  });

  test("予約サイト：足したメニューの仮押さえと同じ枠に、足したメニューで入る（名前・30分）", () => {
    const hold = { id: "h-site", customerId: "c04", menuId: "own-1", date: "2026-11-06", start: "15:00", heldAt: NOW.toISOString(), expiresAt: "2026-12-31T00:00:00.000Z", reason: "テスト" };
    const s = withHold(emptyBook("2026-11-04"), hold);
    const out = siteBook(s, { data: dataWith(WITH), rules: getRules(), now: NOW, stops: [] }, "onHold");
    assert.ok(out.ok, out.ok ? "" : out.note);
    if (!out.ok) return;
    const placed = ledgerView(dataWith(WITH), out.state, NOW).all.find((r) => r.id === out.placed.id)!;
    assert.equal(placed.menu.name, "トリートメント");
    assert.equal(placed.endMin - placed.startMin, 30);
  });

  test("ToDo の文（休みの日・見送り）も、このブラウザに足したメニューの名前で出す（id のまま出ない）", () => {
    const from = { date: "2026-11-06", start: "15:00", menuId: "own-1" };
    assert.match(rescheduleTitle("江口", from), /15:00 own-1の代わり/);
    writeBrowser(MENUS_KEY, menuEditsRaw(WITH, base, shop));
    assert.equal(rescheduleTitle("江口", from), "江口様に別の日時を案内（11/6（金） 15:00 トリートメントの代わり）");
  });
});

describe("5. 台帳で使われている間は消せない", () => {
  const hold = (id: string, menuId: string, expiresAt = "2026-12-31T00:00:00.000Z") =>
    ({ id, customerId: "c04", menuId, date: "2026-11-06", start: "15:00", heldAt: NOW.toISOString(), expiresAt, reason: "テスト" });
  const uses = (s: BookState, extra: Parameters<typeof menuUses>[1] = { menus: WITH, all: [] }) =>
    menuUses("own-1", { ...extra, menus: WITH, all: ledgerView(dataWith(WITH), s, NOW).all, dayLabel: (d) => calDay(shop, d).label });

  test("使っていなければ消せる。期限の切れていない仮押さえ・組み合わせの中・確定・過ぎた予約で使っていれば消せない（どの予約かを出す）", () => {
    assert.deepEqual(uses(emptyBook("2026-11-04")), []);
    const u = uses(withHold(emptyBook("2026-11-04"), hold("h-1", "own-1")));
    assert.equal(u.length, 1);
    assert.equal(u[0].label, "11/6（金） 15:00 トリートメント 江口様（仮押さえ）");
    assert.equal(uses(withHold(emptyBook("2026-11-04"), hold("h-2", "cut+own-1"))).length, 1, "組み合わせの中");
    assert.deepEqual(uses(withHold(emptyBook("2026-11-04"), hold("h-3", "own-1", "2026-11-01T00:00:00.000Z"))), [], "期限の切れた仮押さえは数えない");
    // 確定（台帳から入れた予約）と、その日が過ぎた後も
    const s: BookState = { ...emptyBook("2026-11-04"), chat: [{ ...hold("o-1", "own-1"), status: "confirmed", via: "owner" }] };
    assert.match(uses(s)[0].label, /（確定）$/);
    const later = at("2026-11-20", "10:00");
    const past = menuUses("own-1", { menus: WITH, all: ledgerView(dataWith(WITH), s, later).all });
    assert.equal(past.length, 1, "過ぎた予約も");
  });

  test("カルテ・ルールで使っていても消せない。設定のファイルのメニューには消すボタンを出さない", () => {
    const k = menuUses("own-1", { menus: WITH, all: [], kartes: [{ menuId: "own-1", date: "2026-11-02", customerId: "c04" }], surnameOf: () => "江口" });
    assert.equal(k[0].kind, "karte");
    const r = menuUses("own-1", { menus: WITH, all: [], rules: [{ id: "x", level: "menu", menuId: "own-1", label: "トリートメントは18時まで", check: { kind: "lastStart", time: "18:00" } }] });
    assert.equal(r[0].label, "ルール「トリートメントは18時まで」");
    const p = read("src/app/rules/MenuPanel.tsx");
    assert.match(p, /\{own && !gone && \(/);
    assert.match(p, /使っている所があるので、消せません/);
    // 押した時にも、もう一度確かめる
    assert.match(p, /for \(const id of removing\) \{\n\s+const uses = usesOf\(id\);/);
  });
});

describe("6. 保存・日誌・保存できなかった時・メニューの印", () => {
  const journal = () => parseJournal(readBrowser(JOURNAL_KEY));

  test("日誌：「メニューを足した（トリートメント 30分・3,000円）」「メニューを消した（トリートメント）」", () => {
    assert.deepEqual(menuJournalLines(menuChanges(base, WITH, shop), WITH, shop), ["メニューを足した（トリートメント 30分・3,000円）"]);
    assert.deepEqual(menuJournalLines(menuChanges(WITH, base, shop), base, shop), ["メニューを消した（トリートメント）"]);
    const both = [...WITH.map((m) => (m.id === "own-1" ? { ...m, minutes: 60 } : m))];
    assert.deepEqual(menuJournalLines(menuChanges(WITH, both, shop), both, shop), ["メニューを直した（トリートメント 30分 → 60分）"]);
  });

  test("保存できなかった時は前のまま・日誌なし。もう一度押せば書け、日誌は1回だけ", () => {
    failKey = MENUS_KEY;
    const bad = commitMenus(WITH, base, base, shop);
    assert.deepEqual(bad.write, { ok: false, why: "full" });
    assert.equal(parseMenuEdits(readBrowser(MENUS_KEY), base, shop), base);
    assert.equal(journal().length, 0);
    failKey = null;
    assert.deepEqual(commitMenus(WITH, base, base, shop).write, { ok: true });
    assert.deepEqual(parseMenuEdits(readBrowser(MENUS_KEY), base, shop).at(-1), TREAT);
    assert.deepEqual(journal().map((j) => `${j.who}：${j.text}`), ["オーナー：メニューを足した（トリートメント 30分・3,000円）"]);
    commitMenus(base, WITH, base, shop);
    assert.equal(journal()[0].text, "メニューを消した（トリートメント）");
    assert.match(read("src/app/rules/MenuPanel.tsx"), /if \(!write\.ok\) return setNote\(SAVE_FAILED_MESSAGE\)/);
  });

  test("メニューの印：足すと変わり、消すと戻る。違えば予約チャットの返事を台帳に入れない", () => {
    const m0 = menusMark(base, base, shop);
    const m1 = menusMark(WITH, base, shop);
    assert.equal(m0, "");
    assert.notEqual(m1, m0);
    assert.notEqual(menusMark([...base, { ...TREAT, name: "炭酸スパ" }], base, shop), m1, "名前が違えば違う印");
    assert.notEqual(menusMark([...base, { ...TREAT, id: "own-2" }], base, shop), m1, "番号が違えば違う印");
    assert.equal(menusMark(base, base, shop), m0, "消せば元の印");
    let s = emptyBook("2026-11-04");
    const update = (f: (x: BookState) => BookState) => ((s = f(s)), { ok: true as const });
    const h = { id: "h-1", customerId: "c04", menuId: "own-1", date: "2026-11-06", start: "15:00", heldAt: NOW.toISOString(), expiresAt: "2026-12-31T00:00:00.000Z", reason: "テスト" };
    const sameMenus = () => menusMark(WITH, base, shop) === m0;
    assert.equal(holdInto(update, h, s.epoch, sameMenus), false);
    assert.equal(s.chat.length, 0);
  });
});

describe("7. 開き直し・前の形・「最初に戻す」", () => {
  test("開き直しても足したメニューが戻る。直しF の形の保存（足したメニューが無い物）もそのまま読める", () => {
    const edited = WITH.map((m) => (m.id === "color" ? { ...m, minutes: 60 } : m));
    writeBrowser(MENUS_KEY, menuEditsRaw(edited, base, shop));
    const again = parseMenuEdits(readBrowser(MENUS_KEY), base, shop);
    assert.deepEqual(again, edited);
    // 直しF の形
    const old = JSON.stringify({ menus: [{ id: "color", minutes: 60, price: 6800, lastStart: "18:00" }] });
    const f = parseMenuEdits(old, base, shop);
    assert.equal(f.find((m) => m.id === "color")?.minutes, 60);
    assert.equal(f.length, base.length);
    // 壊れた足したメニューは落とす（設定のメニューはそのまま）
    const broken = JSON.stringify({ menus: [], added: [{ ...TREAT, name: "カット" }, { ...TREAT, id: "own-2", minutes: 45 }, "x", { ...TREAT, id: "own-3" }], seq: 5 });
    const b = readMenuStore(broken, base, shop);
    assert.deepEqual(b.menus.map((m) => m.id).slice(base.length), ["own-3"]);
    assert.equal(b.seq, 5);
  });

  test("「最初に戻す」：台帳を先に書き、足したメニューとそれを使った予約が一緒に消える（取り残されない）", () => {
    const writes = resetAllWrites("2026-11-04");
    assert.ok(writes.findIndex((w) => w.key === BOOK_KEY) < writes.findIndex((w) => w.key === MENUS_KEY), "台帳が先");
    writeBrowser(MENUS_KEY, menuEditsRaw(WITH, base, shop));
    const h = { id: "h-r", customerId: "c04", menuId: "own-1", date: "2026-11-06", start: "15:00", heldAt: NOW.toISOString(), expiresAt: "2026-12-31T00:00:00.000Z", reason: "テスト" };
    writeBrowser(BOOK_KEY, JSON.stringify(withHold(emptyBook("2026-11-04"), h)));
    // 台帳が書けなければ、足したメニューも残す（予約だけ残ってメニューが消える、を作らない）
    failKey = BOOK_KEY;
    assert.equal(resetAll("2026-11-04").written, false);
    assert.ok(parseMenuEdits(readBrowser(MENUS_KEY), base, shop).some((m) => m.id === "own-1"));
    failKey = null;
    const out = resetAll("2026-11-04");
    assert.equal(out.written, true);
    assert.equal(readBrowser(MENUS_KEY), null);
    assert.equal(parseMenuEdits(readBrowser(MENUS_KEY), base, shop), base);
    const book = parseBook(readBrowser(BOOK_KEY))!;
    assert.ok(book);
    assert.ok(!book.chat.some((r) => r.menuId.includes("own-")), "足したメニューを使った予約も消える");
    assert.ok(!ledgerView(getBookData(), book, NOW).all.some((r) => r.menu.id.includes("own-")));
  });
});

describe("8. メニューの欄を、メニューごとに畳む", () => {
  test("最初は全部畳んだ状態：1行に「名前・時間・値段・最終受付」。入れる欄は出さない。「＋ メニューを足す」も1行", () => {
    writeBrowser(MENUS_KEY, menuEditsRaw(WITH, base, shop));
    const html = renderToStaticMarkup(createElement(MenuPanel, { data: getBookData() }));
    assert.equal((html.match(/class="menu-edit-head"/g) ?? []).length, base.length + 1, "メニューごと＋足す欄（開いた前の画面は設定のメニューだけ）");
    assert.ok(!/aria-expanded="true"/.test(html), "どれも畳んである");
    assert.ok(!/<select/.test(html), "入れる欄は出さない");
    assert.match(html, /<strong class="menu-edit-title">カット<\/strong><span class="menu-edit-sum num">60分・4,800円・最終受付 19:00<\/span>/);
    assert.match(html, /＋ メニューを足す/);
  });

  test("畳んだ行の中身と札：足した・直した・直しかけ（畳んでも見える）・消す（保存前）", () => {
    const head = (half: "直しかけ" | "消す（保存前）" | null, own = false, changed = false) =>
      renderToStaticMarkup(createElement(MenuRowHead, { menu: TREAT, text: "30分・3,000円・最終受付 19:00", own, changed, half, open: false, bodyId: "b", onToggle: () => {} }));
    const h = head("直しかけ", true);
    assert.match(h, /aria-expanded="false"/);
    assert.match(h, /トリートメント/);
    assert.match(h, /30分・3,000円・最終受付 19:00/);
    assert.match(h, /<span class="tag own">足した<\/span>/);
    assert.match(h, /<span class="tag warn">直しかけ<\/span>/);
    assert.match(head("消す（保存前）"), /消す（保存前）/);
    assert.doesNotMatch(head(null), /tag warn/);
    assert.match(head(null, false, true), /直した/);
    assert.match(h, /menu-c-sky/);
    // 画面：直しかけは draft か消す途中の欄。足す欄も、押した後は畳んでも直しかけ
    const p = read("src/app/rules/MenuPanel.tsx");
    assert.match(p, /const half = !!draft\?\.\[m\.id\] \|\| gone;/);
    assert.match(p, /\{adding && <span className="tag warn">直しかけ<\/span>\}/);
    assert.match(p, /const \[open, setOpen\] = useState<string\[\]>\(\[\]\);/);
  });

  test("スマホの幅で横にはみ出さない形（折り返す・最小幅 0）", () => {
    const css = read("src/app/globals.css");
    assert.match(css, /\.menu-edit-head \{[^}]*flex-wrap: wrap;[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/s);
    assert.match(css, /\.menu-edit-fields\.menu-edit-addname \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  });
});

describe("8b. メニューの欄の入力欄は 44px 以上・値段の欄は矢印なしでそろえる", () => {
  test("`.menu-edit` の中の select と input に min-height: 44px。値段（number）の増減の矢印は出さない", () => {
    const css = read("src/app/globals.css");
    assert.match(css, /\.menu-edit select,\n\.menu-edit input \{ box-sizing: border-box; min-height: 44px; \}/);
    assert.match(css, /\.menu-edit input\[type="number"\] \{ appearance: textfield; -moz-appearance: textfield; \}/);
    assert.match(css, /\.menu-edit input\[type="number"\]::-webkit-inner-spin-button,\n\.menu-edit input\[type="number"\]::-webkit-outer-spin-button \{ -webkit-appearance: none; margin: 0; \}/);
    // 足す欄（名前・色・時間・値段・最終受付）も、直しF からある行も、同じ .menu-edit の中
    const p = read("src/app/rules/MenuPanel.tsx");
    assert.match(p, /<div className="menu-edit">/);
    assert.match(p, /aria-label="足すメニューの名前"/);
    assert.match(p, /aria-label="足すメニューの色"/);
  });
});

describe("9. 読む入口は1つ（useBook の data.menus）", () => {
  test("ルールの一覧（RuleBoard）も台帳の data.menus から、メニューの名前を引く", () => {
    const b = read("src/app/rules/RuleBoard.tsx");
    assert.match(b, /const menus = useBook\(data\)\.data\.menus;/);
    assert.ok(!/getMenus/.test(read("src/app/rules/page.tsx")));
    assert.match(read("src/lib/useMenus.ts"), /readMenuStore\(raw, getMenus\(\), getShop\(\)\)/);
  });
});
