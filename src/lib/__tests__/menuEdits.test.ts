// オーナーがメニューの時間・値段・最終受付を直す（ルールのタブの「メニュー」。menuEdits.ts）のテスト。Claude と LINE は呼ばず、決まった返事に置きかえる。
// - おかしい値（時間・値段・最終受付）を断る。サーバーは id の足りない・重なる・知らない物と、名前・色・includes の違いを断る
// - 直したメニューで、予約チャット・LINE の一言・AI の仕事・台帳から入れる・予約を直す・予約サイト・承認の箱の判定が変わる（画面とサーバー）
// - 設定にある組み合わせ（cut_color）は自分の時間のまま、設定に無い組み合わせ（cut+headspa）は中を足す
// - 保存の前の一覧（重なり・閉店越え・最終受付）・もう一度押す・その間に予約が変わった時
// - 保存できなかった時（日誌を書かない・もう一度押せば書ける）・直す前に始まった予約チャットの返事を入れない・「最初に戻す」で戻る・日誌

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { runReserve } from "../ai/agent";
import { at, bookedAt, chat } from "../ai/__tests__/helpers";
import { contextFor, parseReserveRequest } from "../ai/request";
import { holdInto } from "../ai/reserveStream";
import { scriptModel } from "../ai/script";
import { judgeSlot } from "../ai/slots";
import type { ReserveEvent } from "../ai/wire";
import { EMPTY_ACCOUNTING } from "../accounting/state";
import { EMPTY_ADS } from "../ads/state";
import { changeCheck } from "../book/change";
import { getBookData, type BookData } from "../book/data";
import { ownerCheck, ownerSlotContext, type OwnerContext } from "../book/owner";
import { ledgerView, siteBook } from "../book/site";
import { emptyBook, pendingApprovals, withHold, type BookState } from "../book/state";
import { BROWSER_PREFIX, JOURNAL_KEY, readBrowser, writeBrowser } from "../browser";
import { calDay } from "../calendar";
import { resolveMenu } from "../combo";
import { getCustomers } from "../data/seed";
import { runJob, type JobAsk, type JobEnv } from "../jobs/run";
import { EMPTY_JOBS } from "../jobs/state";
import { parseJournal } from "../journal";
import { parseLineAskRequest, runLineAsk } from "../line/ask";
import { maskNames, scriptSortModel } from "../line/sort";
import {
  commitMenus,
  fieldsProblem,
  lastStartChoices,
  lastStartProblem,
  MENUS_KEY,
  menuChanges,
  menuConflicts,
  menuEditsRaw,
  menuJournal,
  menuLimitsOf,
  menusMark,
  minuteChoices,
  minutesProblem,
  parseMenuEdits,
  priceProblem,
  readMenus,
  saveStep,
} from "../menuEdits";
import { resetAll, resetAllWrites } from "../reset";
import { ruleWordsSystem } from "../rules/words";
import { getRules } from "../rules/store";
import { getAiSettings, getJobsSettings, getLineSettings, getMenus, getShop, type Menu } from "../settings";

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

/** 設定のメニューの一部の数を変えた物（id・名前・色・includes はそのまま） */
const edit = (over: Record<string, Partial<Pick<Menu, "minutes" | "price" | "lastStart">>>): Menu[] => base.map((m) => (over[m.id] ? { ...m, ...over[m.id] } : m));
/** カラーを 60分にした（90分 → 60分） */
const COLOR60 = edit({ color: { minutes: 60 } });
const dataWith = (menus: Menu[]): BookData => ({ ...getBookData(), menus });

// ── テストの中だけのブラウザ（書けない時も作れる） ───────────────────
const store = new Map<string, string>();
let menusFail = false;
const g = globalThis as { window?: unknown };
let had: unknown;
before(() => {
  had = g.window;
  g.window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (k === BROWSER_PREFIX + MENUS_KEY && menusFail) {
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
  menusFail = false;
});

describe("1. おかしい値を断る（時間 30〜300分・30分きざみ／値段 0〜100,000円の整数／最終受付 開店〜閉店・30分きざみ）", () => {
  test("幅は設定から（config/shop.json の menuLimits・slotMinutes・営業時間）", () => {
    assert.deepEqual(lim, { minMinutes: 30, maxMinutes: 300, maxPrice: 100000, step: 30, firstOpen: "10:00", lastClose: "20:00" });
    assert.equal(minuteChoices(lim)[0], 30);
    assert.equal(minuteChoices(lim).at(-1), 300);
    assert.equal(minuteChoices(lim).length, 10);
    assert.deepEqual([lastStartChoices(lim)[0], lastStartChoices(lim).at(-1)], ["10:00", "20:00"]);
  });

  test("時間", () => {
    for (const ok of [30, 60, 300]) assert.equal(minutesProblem(ok, lim), null, String(ok));
    for (const bad of [0, 29, 45, 330, 1.5, "60", null, NaN]) assert.ok(minutesProblem(bad, lim), String(bad));
  });

  test("値段", () => {
    for (const ok of [0, 4800, 100000]) assert.equal(priceProblem(ok, lim), null, String(ok));
    for (const bad of [-1, 100001, 4800.5, "4800", NaN, undefined]) assert.ok(priceProblem(bad, lim), String(bad));
  });

  test("最終受付", () => {
    for (const ok of ["10:00", "17:30", "20:00"]) assert.equal(lastStartProblem(ok, lim), null, ok);
    for (const bad of ["09:30", "20:30", "18:15", "25:00", "1800", 1800, ""]) assert.ok(lastStartProblem(bad, lim), String(bad));
  });

  test("まとめて（最初に当たった1文）", () => {
    assert.equal(fieldsProblem({ minutes: 60, price: 6800, lastStart: "18:00" }, lim), null);
    assert.match(fieldsProblem({ minutes: 45, price: 6800, lastStart: "18:00" }, lim) ?? "", /30分 きざみ/);
    assert.match(fieldsProblem({ minutes: 60, price: 200000, lastStart: "18:00" }, lim) ?? "", /100,000円/);
  });
});

describe("2. ブラウザに残す形（このブラウザだけ。設定と違う所だけ書く）", () => {
  test("書く・読む：違うメニューだけ残し、読むと設定に重なる。同じなら消す（null）", () => {
    const raw = menuEditsRaw(COLOR60, base, shop);
    assert.deepEqual(JSON.parse(raw!), { menus: [{ id: "color", minutes: 60, price: 6800, lastStart: "18:00" }] });
    const back = parseMenuEdits(raw, base, shop);
    assert.equal(back.find((m) => m.id === "color")?.minutes, 60);
    assert.equal(back.find((m) => m.id === "cut"), base.find((m) => m.id === "cut"), "直していないメニューは設定の物そのまま");
    assert.equal(menuEditsRaw(base, base, shop), null);
    assert.equal(parseMenuEdits(null, base, shop), base);
  });

  test("形のおかしい物・幅の外・知らない id・壊れた文字は落とし、そのメニューは設定のまま", () => {
    const raw = JSON.stringify({
      menus: [
        { id: "color", minutes: 45, price: 6800, lastStart: "18:00" },
        { id: "nail", minutes: 60, price: 1000, lastStart: "18:00" },
        { id: "cut", minutes: 30, price: 4000, lastStart: "19:00" },
      ],
    });
    const m = parseMenuEdits(raw, base, shop);
    assert.equal(m.find((x) => x.id === "color")?.minutes, 90);
    assert.equal(m.find((x) => x.id === "cut")?.minutes, 30);
    assert.equal(m.length, base.length);
    assert.equal(parseMenuEdits("{", base, shop), base);
  });

  test("メニューの設定の印：直していなければ \"\"、直せば変わる（予約チャットの返事を入れるかに使う）", () => {
    assert.equal(menusMark(base, base, shop), "");
    assert.notEqual(menusMark(COLOR60, base, shop), "");
    assert.notEqual(menusMark(COLOR60, base, shop), menusMark(edit({ color: { minutes: 120 } }), base, shop));
  });
});

describe("3. サーバー：形と数を確かめてから使う（readMenus。予約チャット・LINE の一言・言葉でルールを足す）", () => {
  const sent = (menus: Menu[]) => JSON.parse(JSON.stringify(menus)) as Record<string, unknown>[];

  test("無ければ設定のまま。設定と同じなら edited: false。直した数は受け取る", () => {
    assert.deepEqual(readMenus(undefined, base, shop), { ok: true, value: base, edited: false });
    const same = readMenus(sent(base), base, shop);
    assert.ok(same.ok && !same.edited);
    const r = readMenus(sent(COLOR60), base, shop);
    assert.ok(r.ok && r.edited);
    if (r.ok) assert.equal(r.value.find((m) => m.id === "color")?.minutes, 60);
  });

  test("id の足りない・重なる・知らない物は断る", () => {
    const list = sent(base);
    assert.equal(readMenus(list.slice(1), base, shop).ok, false, "足りない");
    assert.equal(readMenus([...list, list[0]], base, shop).ok, false, "重なる");
    assert.equal(readMenus([...list.slice(1), { ...list[0], id: "nail" }], base, shop).ok, false, "知らない");
    assert.equal(readMenus("cut", base, shop).ok, false, "配列でない");
    assert.equal(readMenus([...list.slice(1), null], base, shop).ok, false);
  });

  test("id・名前・色・includes は設定と同じでないと断る", () => {
    const list = sent(base);
    const swap = (i: number, over: Record<string, unknown>) => list.map((m, j) => (j === i ? { ...m, ...over } : m));
    const ci = list.findIndex((m) => m.id === "cut_color");
    assert.equal(readMenus(swap(0, { name: "カット（特別）" }), base, shop).ok, false, "名前");
    assert.equal(readMenus(swap(0, { color: "rose" }), base, shop).ok, false, "色");
    assert.equal(readMenus(swap(ci, { includes: ["cut"] }), base, shop).ok, false, "組み合わせの中身");
    assert.equal(readMenus(swap(0, { includes: ["color"] }), base, shop).ok, false, "組み合わせでない物に中身");
  });

  test("数が幅の外なら断る（時間・値段・最終受付）", () => {
    for (const over of [{ minutes: 330 }, { minutes: 45 }, { price: -100 }, { price: 100001 }, { lastStart: "21:00" }, { lastStart: "18:10" }]) {
      const r = readMenus(sent(edit({ color: over })), base, shop);
      assert.equal(r.ok, false, JSON.stringify(over));
      if (!r.ok) assert.match(r.reason, /^カラー：/);
    }
  });

  const body = (menus: unknown) => ({
    mode: "script",
    messages: [{ role: "user", text: "カット" }],
    candidates: [],
    customer: { id: "c04", surname: "江口", firstVisit: false },
    booked: [],
    rules: [],
    visits: [],
    dayOffset: 0,
    menus,
  });

  test("予約チャットの窓口：おかしいメニューは断る。正しければ道具の形に重ねる", () => {
    assert.equal(parseReserveRequest(body(sent(base).slice(1)), base, ai).ok, false);
    const p = parseReserveRequest(body(sent(COLOR60)), base, ai);
    assert.ok(p.ok);
    if (!p.ok) return;
    assert.equal(contextFor(p.value, shop, base, NOW).menus.find((m) => m.id === "color")?.minutes, 60);
    const none = parseReserveRequest(body(undefined), base, ai);
    assert.ok(none.ok && !none.value.menus);
    if (none.ok) assert.equal(contextFor(none.value, shop, base, NOW).menus, base);
  });

  test("LINE の一言の窓口：おかしいメニューは断る（受け取る途中で落とさない）", () => {
    const q = (menus: unknown) =>
      parseLineAskRequest({ mode: "script", text: "シャンプー発注", customer: null, booked: [], rules: [], dayOffset: 0, menus }, base, ai, getLineSettings().maxTextChars);
    assert.equal(q([...sent(base), sent(base)[0]]).ok, false);
    const ok = q(sent(COLOR60));
    assert.ok(ok.ok);
    if (ok.ok) assert.equal(ok.value.menus?.find((m) => m.id === "color")?.minutes, 60);
  });

  test("言葉でルールを足す窓口（/api/ai/rules）：同じ確かめ方で読み、AI への一覧に今の時間を添える", () => {
    const route = read("src/app/api/ai/rules/route.ts");
    assert.match(route, /readMenus\(\(body as Record<string, unknown>\)\.menus, getMenus\(\), getShop\(\)\)/);
    assert.match(route, /if \(!own\.ok\) return reply\(\{ ok: false, code: "bad-request"/);
    const s = ruleWordsSystem([{ id: "color", name: "カラー", minutes: 60, lastStart: "18:00" }]);
    assert.match(s, /- color：カラー・60分・最終受付 18:00/);
    assert.match(read("src/app/rules/RuleWords.tsx"), /void ask\(\{ mode: "ai", text: sentence, menus \}\)/);
  });
});

describe("4. 直したメニューで判定が変わる（カラー 90分 → 60分。11/6 15:00 のカラーは 16:00 のカットに重ならなくなる）", () => {
  const c04 = customers.find((c) => c.id === "c04")!;
  const reserveCtx = (menus?: Menu[]) => {
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
        ...(menus ? { menus: JSON.parse(JSON.stringify(menus)) } : {}),
      },
      base,
      ai,
    );
    assert.ok(p.ok, p.ok ? "" : p.reason);
    let n = 0;
    return contextFor(p.value, shop, base, NOW, () => `h-menu-${++n}`);
  };
  const SLOT = { menuId: "color", date: "2026-11-06", start: "15:00" };

  test("予約チャット（サーバー・決まった返事）：60分なら 11/6 15:00 を候補に出す。90分なら出さない", async () => {
    const want = (r: Awaited<ReturnType<typeof chat>>) => !!r.candidates?.some((c) => c.date === SLOT.date && c.start === SLOT.start && c.menuId === "color");
    assert.equal(want(await chat(reserveCtx(), [{ role: "user", text: "11/6の15時にカラー" }])), false);
    const ctx = reserveCtx(COLOR60);
    const r = await chat(ctx, [{ role: "user", text: "11/6の15時にカラー" }]);
    assert.ok(want(r), JSON.stringify(r.candidates));
    // 「1つ目で」で、その枠に 60分で仮押さえ
    const held = await chat({ ...ctx, shown: r.candidates! }, [
      { role: "user", text: "11/6の15時にカラー" },
      { role: "assistant", text: r.text },
      { role: "user", text: "1つ目で" },
    ]);
    assert.equal(held.holds.length, 1);
    assert.equal(held.holds[0].date, SLOT.date);
    assert.equal(held.holds[0].start, SLOT.start);
  });

  test("予約チャットの判定（judgeSlot）：終わる時刻も新しい時間で", () => {
    const v60 = judgeSlot(reserveCtx(COLOR60), SLOT);
    assert.equal(v60.ok, true);
    assert.match(v60.base.find((b) => b.id === "hours")?.reason ?? "", /16:00に終わります/);
    assert.equal(judgeSlot(reserveCtx(), SLOT).base.find((b) => b.id === "seats")?.ok, false);
  });

  test("LINE の一言（サーバー・決まった振り分け）：60分なら仮押さえ、90分なら断って代わりを出す", async () => {
    const ask = async (menus?: Menu[]) => {
      const { masked, found } = maskNames("11/6 15時に江口さんカラーで仮押さえ", customers);
      const parsed = parseLineAskRequest(
        {
          mode: "script",
          text: masked,
          customer: found[0] ?? null,
          booked: bookedAt(NOW),
          rules: getRules().filter((r) => !r.locked),
          dayOffset: 0,
          ...(menus ? { menus: JSON.parse(JSON.stringify(menus)) } : {}),
        },
        base,
        ai,
        getLineSettings().maxTextChars,
      );
      assert.ok(parsed.ok);
      if (!parsed.ok) throw new Error("bad");
      const today = calDay(shop, "2026-11-04");
      return runLineAsk({ req: parsed.value, shop, menus: base, model: scriptSortModel({ menus: parsed.value.menus ?? base, today }), maxTokens: 300, now: NOW });
    };
    const no = await ask();
    assert.ok(no.ok && no.kind === "hold-no", JSON.stringify(no));
    const yes = await ask(COLOR60);
    assert.ok(yes.ok && yes.kind === "hold", JSON.stringify(yes));
    if (yes.ok && yes.kind === "hold") assert.equal(`${yes.hold.date} ${yes.hold.start}`, "2026-11-06 15:00");
  });

  test("AI の仕事（予約の相談）：画面の data.menus を送り、サーバーの判定に効く", async () => {
    const run = async (menus: Menu[]) => {
      let book: BookState = emptyBook("2026-11-04");
      const sentMenus: unknown[] = [];
      const askReserve: JobAsk["reserve"] = async (b) => {
        const raw = JSON.parse(JSON.stringify(b));
        sentMenus.push(raw.menus);
        const p = parseReserveRequest(raw, base, ai);
        assert.ok(p.ok);
        if (!p.ok) return [];
        let n = 0;
        const ctx = contextFor(p.value, shop, base, NOW, () => `h-job-${++n}`);
        const events: ReserveEvent[] = [];
        await runReserve({ ctx, history: p.value.messages, model: scriptModel(ctx), limits: ai, emit: (e) => events.push(e) });
        return events;
      };
      const env: JobEnv = {
        data: dataWith(menus),
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
        seeds: [{ id: "reserve", customerId: "c04", menuId: "color", day: 2, start: "15:00" }],
      };
      await runJob("reserve", env, { left: getJobsSettings().maxAiCallsPerPress });
      return { rows: pendingApprovals(book, NOW.toISOString()), sentMenus };
    };
    const a = await run(COLOR60);
    assert.equal((a.sentMenus[0] as Menu[]).find((m) => m.id === "color")?.minutes, 60, "直したメニューを送る");
    assert.equal(a.rows.length, 1);
    assert.equal(`${a.rows[0].reservation.date} ${a.rows[0].reservation.start}`, "2026-11-06 15:00");
    const b = await run(base);
    assert.ok(b.rows.every((r) => `${r.reservation.date} ${r.reservation.start}` !== "2026-11-06 15:00"), "90分なら 11/6 15:00 には入らない");
  });

  const start = emptyBook("2026-11-04");
  const owner = (menus: Menu[]): OwnerContext => ({ data: dataWith(menus), rules: getRules(), now: NOW, newId: () => "own-m1" });

  test("台帳から入れる（ownerCheck）：60分なら入れられる。90分は重なりで入れない", () => {
    const c = (menus: Menu[]) => ownerCheck(ownerSlotContext(start, owner(menus), "c04")!, SLOT);
    assert.ok(c(base).blocked.some((l) => l.key === "base:seats"));
    const ok = c(COLOR60);
    assert.equal(ok.blocked.length, 0, JSON.stringify(ok.blocked));
    assert.equal(ok.end, "16:00");
  });

  test("予約を直す（changeCheck）：木村様のカラー（11/8）を 11/6 15:00 に。60分なら変えられる", () => {
    assert.ok(changeCheck(start, owner(base), "r07", SLOT)?.blocked.some((l) => l.key === "base:seats"));
    const ok = changeCheck(start, owner(COLOR60), "r07", SLOT);
    assert.equal(ok?.blocked.length, 0, JSON.stringify(ok?.blocked));
  });

  test("台帳の終わる時刻（ledgerView・useBook と同じ assembleBook）：カラーの予約は 60分で終わる。過ぎた予約も新しい時間で出る", () => {
    const all = ledgerView(dataWith(COLOR60), start, NOW).all;
    assert.equal(all.find((r) => r.id === "r07")?.end, "12:00");
    assert.equal(all.find((r) => r.id === "p04")?.end, "11:30", "過ぎた予約（10/7 10:30 カラー）も新しい時間で");
    assert.equal(ledgerView(getBookData(), start, NOW).all.find((r) => r.id === "r07")?.end, "12:30");
  });

  test("予約サイト：入った予約の終わる時刻と重なりの判定も直したメニューで（全部 300分にすると、入るのは空いた日だけ）", () => {
    const long = base.map((m) => ({ ...m, minutes: 300, lastStart: "15:00" }));
    const out = siteBook(start, { data: dataWith(long), rules: getRules(), now: NOW, stops: [] }, "free");
    assert.ok(out.ok);
    if (!out.ok) return;
    const placed = ledgerView(dataWith(long), out.state, NOW).all.find((r) => r.id === out.placed.id)!;
    assert.equal(placed.endMin - placed.startMin, 300);
    const others = ledgerView(dataWith(long), out.state, NOW).all.filter((r) => r.date === placed.date && r.id !== placed.id);
    assert.ok(others.every((o) => o.endMin <= placed.startMin || placed.endMin <= o.startMin), "重ならない枠に入る（同じ時間に受けるのは1人）");
  });

  test("承認の箱（画面の judgeSlot）：60分の仮押さえは、90分に戻すと重なりで確定の前に止まる", () => {
    const hold = { id: "h-ap", customerId: "c04", menuId: "color", date: SLOT.date, start: SLOT.start, heldAt: NOW.toISOString(), expiresAt: "2026-12-31T00:00:00.000Z", reason: "テスト" };
    const s = withHold(start, hold);
    const view = (menus: Menu[]) => ledgerView(dataWith(menus), s, NOW);
    const ctx = (menus: Menu[]) => ({
      shop,
      menus,
      rules: getRules(),
      booked: view(menus).all.filter((r) => r.id !== hold.id).map((r) => ({ id: r.id, customerId: r.customer.id, menuId: r.menu.id, date: r.date, start: r.start, status: r.status, newCustomer: false })),
      customer: { id: "c04", surname: "江口", firstVisit: false },
      now: NOW_SHOP,
      today: calDay(shop, "2026-11-04"),
    });
    assert.equal(judgeSlot(ctx(COLOR60), hold).ok, true);
    assert.equal(judgeSlot(ctx(base), hold).ok, false);
    assert.match(read("src/components/ApprovalBox.tsx"), /menus: book\.data\.menus,/);
  });
});

describe("5. 組み合わせ：設定にある物は自分の時間のまま、設定に無い物は中を足す", () => {
  const cut30 = edit({ cut: { minutes: 30, price: 4000 } });

  test("設定にある組み合わせ（カット＋カラー）は、カットを直しても 120分・10,800円のまま。自分の欄で直す", () => {
    assert.equal(resolveMenu(cut30, "cut_color")?.minutes, 120);
    assert.equal(resolveMenu(cut30, "cut_color")?.price, 10800);
    const own = edit({ cut_color: { minutes: 150, price: 12000 } });
    assert.equal(resolveMenu(own, "cut_color")?.minutes, 150);
  });

  test("設定に無い組み合わせ（カット＋ヘッドスパ）は、中を足すので変わる（30＋30分・4,000＋3,300円）", () => {
    assert.equal(resolveMenu(base, "cut+headspa")?.minutes, 90);
    assert.equal(resolveMenu(cut30, "cut+headspa")?.minutes, 60);
    assert.equal(resolveMenu(cut30, "cut+headspa")?.price, 7300);
  });

  test("画面の欄にも一行で書く", () => {
    const p = read("src/app/rules/MenuPanel.tsx");
    assert.match(p, /COMBO_EDIT_NOTE/);
    assert.match(p, /設定に無い組み合わせ（カット＋ヘッドスパのように選んだメニューを足す物）は、中のメニューの時間と値段を足して決まります/);
  });
});

describe("6. 保存の前の一覧（予約は動かさない）・もう一度押す・その間に予約が変わった時", () => {
  const start = emptyBook("2026-11-04");
  const view = (s: BookState = start, now = NOW) => ledgerView(getBookData(), s, now).all;
  const conflicts = (menus: Menu[], s: BookState = start, nowShop = NOW_SHOP, now = NOW) => menuConflicts({ shop, menus, all: view(s, now), now: nowShop });

  test("変えなければ当たる予約は無い。値段だけ変えても無い", () => {
    assert.deepEqual(conflicts(base), []);
    assert.deepEqual(conflicts(edit({ color: { price: 6000 } })), []);
  });

  test("重なり：縮毛矯正を 240分にすると、11/9 の久保様（13:30 の青木様のヘッドスパに重なる）が出る", () => {
    const list = conflicts(edit({ straight: { minutes: 240 } }));
    const r09 = list.find((c) => c.id === "r09");
    assert.ok(r09, JSON.stringify(list));
    assert.match(r09!.label, /^11\/9（月） 10:00–14:00 縮毛矯正 久保様（確定）$/);
    assert.match(r09!.reasons.join(), /同じ時間に受ける人数（1人）を超えて重なります/);
  });

  test("閉店越え：カラーを 150分にすると、11/12 18:00 の大橋様が 20:30 に終わる", () => {
    const r13 = conflicts(edit({ color: { minutes: 150 } })).find((c) => c.id === "r13");
    assert.match(r13?.reasons.join() ?? "", /閉店（20:00）までに終わりません（20:30に終わります）/);
  });

  test("最終受付：カラーを 17:30 までにすると、11/12 18:00 の大橋様が出る（11/4 17:00 の石田様は出ない）", () => {
    const list = conflicts(edit({ color: { lastStart: "17:30" } }));
    assert.deepEqual(list.map((c) => c.id), ["r13"]);
    assert.match(list[0].reasons.join(), /カラーの最終受付（17:30）を過ぎています/);
  });

  test("もう過ぎた予約・始まった予約は出さない（11/4 15:00 なら、14:00 からの上野様は出ない）", () => {
    const now = at("2026-11-04", "15:00");
    const list = conflicts(edit({ straight: { minutes: 240 } }), start, { date: "2026-11-04", time: "15:00" }, now);
    assert.ok(!list.some((c) => c.id === "r03"));
    assert.ok(list.some((c) => c.id === "r02"), "上野様に重なる 17:00 の石田様は、これから先なので出る");
  });

  const hold = (id: string, start: string, expiresAt = "2026-12-31T00:00:00.000Z") =>
    ({ id, customerId: "c04", menuId: "color", date: "2026-11-12", start, heldAt: NOW.toISOString(), expiresAt, reason: "テスト" });

  test("期限の切れていない仮押さえも確かめる。期限の切れた物は出さない", () => {
    const s = withHold(start, hold("h-ok", "15:00"));
    const list = conflicts(edit({ color: { lastStart: "14:30" } }), s);
    assert.ok(list.find((c) => c.id === "h-ok")?.label.endsWith("（仮押さえ）"));
    const old = withHold(start, hold("h-old", "15:00", "2026-11-01T00:00:00.000Z"));
    assert.ok(!conflicts(edit({ color: { lastStart: "14:30" } }), old).some((c) => c.id === "h-old"));
  });

  test("もう一度押した時だけ保存。その間に予約が変わったら一覧を出し直す（印が違う）", () => {
    const menus = edit({ color: { lastStart: "17:30" } });
    const mark = menusMark(menus, base, shop);
    const first = saveStep(conflicts(menus), mark, null);
    assert.equal(first.kind, "show");
    if (first.kind !== "show") return;
    assert.deepEqual(saveStep(conflicts(menus), mark, first.mark), { kind: "save" }, "同じ一覧なら、もう一度押せば保存");
    // 間に仮押さえが1件入った（11/12 19:00 のカラー）
    const s = withHold(start, hold("h-new", "19:00"));
    const again = saveStep(conflicts(menus, s), mark, first.mark);
    assert.equal(again.kind, "show", "予約が変わったので出し直す");
    // 直す中身が変わっても出し直す
    const other = edit({ color: { lastStart: "17:00" } });
    assert.equal(saveStep(conflicts(other), menusMark(other, base, shop), first.mark).kind, "show");
    // 当たる予約が無ければ、そのまま保存
    assert.deepEqual(saveStep([], mark, null), { kind: "save" });
  });

  test("画面：保存の前に一覧・もう一度押す・最初に戻した後は前の一覧を使わない・人が押した時だけ", () => {
    const p = read("src/app/rules/MenuPanel.tsx");
    assert.match(p, /menuConflicts\(\{ shop: book\.shop, menus: next, all: book\.all, now: book\.now \}\)/);
    assert.match(p, /ask && sameEpoch\(book\.state, ask\.epoch\) \? ask\.mark : null/);
    assert.match(p, /if \(!e\.nativeEvent\.isTrusted\) return;/);
    assert.match(p, /保存しても予約は動かしません/);
    assert.match(p, /MENU_EDIT_NOTE/);
    assert.match(read("src/lib/menuEdits.ts"), /このブラウザだけに保存します。最初に戻すと設定の値に戻ります/);
  });
});

describe("7. 保存・日誌・保存できなかった時・最初に戻す", () => {
  const journal = () => parseJournal(readBrowser(JOURNAL_KEY));

  test("日誌の1行：「オーナー：メニューを直した（カラー 90分 → 60分）」", () => {
    assert.equal(menuJournal(menuChanges(base, COLOR60, shop)), "メニューを直した（カラー 90分 → 60分）");
    assert.equal(
      menuJournal(menuChanges(base, edit({ color: { minutes: 60, price: 6000, lastStart: "17:30" } }), shop)),
      "メニューを直した（カラー 90分 → 60分・カラー 6,800円 → 6,000円・カラー 最終受付 18:00 → 17:30）",
    );
  });

  test("保存できた時だけ日誌に1行。書けなかった時は前のまま・日誌なし。もう一度押せば書け、日誌は1回だけ", () => {
    menusFail = true;
    const bad = commitMenus(COLOR60, base, base, shop);
    assert.deepEqual(bad.write, { ok: false, why: "full" });
    assert.equal(parseMenuEdits(readBrowser(MENUS_KEY), base, shop), base);
    assert.equal(journal().length, 0);
    menusFail = false;
    const ok = commitMenus(COLOR60, base, base, shop);
    assert.deepEqual(ok.write, { ok: true });
    assert.equal(parseMenuEdits(readBrowser(MENUS_KEY), base, shop).find((m) => m.id === "color")?.minutes, 60);
    const j = journal();
    assert.equal(j.length, 1);
    assert.equal(j[0].who, "オーナー");
    assert.equal(j[0].text, "メニューを直した（カラー 90分 → 60分）");
    const p = read("src/app/rules/MenuPanel.tsx");
    assert.match(p, /if \(!write\.ok\) return setNote\(SAVE_FAILED_MESSAGE\)/);
  });

  test("「最初に戻す」で設定の値（カラー 90分）に戻る", () => {
    assert.deepEqual(resetAllWrites("2026-11-04").find((w) => w.key === MENUS_KEY), { key: MENUS_KEY, value: null });
    writeBrowser(MENUS_KEY, menuEditsRaw(COLOR60, base, shop));
    assert.equal(parseMenuEdits(readBrowser(MENUS_KEY), base, shop).find((m) => m.id === "color")?.minutes, 60);
    const out = resetAll("2026-11-04");
    assert.equal(out.written, true);
    assert.equal(readBrowser(MENUS_KEY), null);
    assert.equal(parseMenuEdits(readBrowser(MENUS_KEY), base, shop).find((m) => m.id === "color")?.minutes, 90);
  });
});

describe("8. 直す前に始まった予約チャットの返事は、直した後の台帳に入れない（epoch と同じ考え方）", () => {
  const h = { id: "h-1", customerId: "c04", menuId: "color", date: "2026-11-06", start: "15:00", heldAt: NOW.toISOString(), expiresAt: "2026-12-31T00:00:00.000Z", reason: "テスト" };

  test("holdInto：メニューの設定の印が違えば入れない（台帳は変えない）。同じなら入れる", () => {
    let s = emptyBook("2026-11-04");
    const update = (f: (x: BookState) => BookState) => {
      s = f(s);
      return { ok: true as const };
    };
    assert.equal(holdInto(update, h, s.epoch, () => false), false);
    assert.equal(s.chat.length, 0);
    assert.equal(holdInto(update, h, s.epoch, () => true), true);
    assert.equal(s.chat.length, 1);
  });

  test("画面：返事を始めた時の印を持ち、違えば知らせを使わない。直したら流れている返事を止めて会話を最初に戻す", () => {
    const p = read("src/app/reservations/ReserveChat.tsx");
    assert.match(p, /const menusAt = currentMenusMark\(\);/);
    assert.match(p, /sameEpoch\(\{ epoch: currentEpoch\(\) \}, epoch\) && sameMenus\(\)/);
    assert.match(p, /holdInto\(book\.update, h, epoch, sameMenus\)/);
    assert.match(p, /メニューを直したので、流れていた返事を止めた/);
    assert.match(p, /menus: book\.data\.menus,/);
    // LINE の一言も、待つ間に直したら仮押さえを入れない
    const l = read("src/components/LineBridge.tsx");
    assert.match(l, /latest\.current\.book\.menusMark !== menusAt/);
    assert.match(l, /menus: L\.book\.data\.menus,/);
  });
});

describe("9. 直したメニューを読む入口は1つ（useBook の data.menus）", () => {
  test("useBook が重ね、台帳を組み立てる所に渡す", () => {
    const u = read("src/lib/book/useBook.ts");
    assert.match(u, /const \{ menus, mark: menusMark \} = useMenus\(\);/);
    assert.match(u, /assembleBook\(\{ shop, menus, customers: data\.customers \}/);
    assert.match(u, /\{ \.\.\.data, shop, menus \}/);
  });

  test("画面の部品は元の data.menus を直に読まない（book.data.menus を通す）", () => {
    const files = [
      "src/components/ApprovalBox.tsx",
      "src/components/LineBridge.tsx",
      "src/app/reservations/ReservationSheet.tsx",
      "src/app/reservations/OwnerBookSheet.tsx",
      "src/app/reservations/ReserveChat.tsx",
      "src/app/reservations/MenuTable.tsx",
      "src/app/rules/RuleSide.tsx",
      "src/app/home/HomeSummary.tsx",
      "src/app/home/LinePanel.tsx",
      "src/app/home/BriefNotes.tsx",
      "src/app/karte/CustomerList.tsx",
      "src/app/karte/KarteBoard.tsx",
      // 直しG（カレンダーで休みを決める）で増えた画面
      "src/app/reservations/HolidayFlow.tsx",
      "src/app/reservations/HolidayList.tsx",
      "src/app/reservations/MonthCalendar.tsx",
    ];
    for (const f of files) assert.ok(!/(?<![.\w])data\.menus/.test(read(f)), `${f} が data.menus を直に読んでいる`);
    assert.ok(!/data\.menus\.map/.test(read("src/app/reservations/page.tsx")), "予約のページの表も直した値で（MenuTable）");
  });

  test("ルールの試しも直したメニューで判定する", () => {
    const r = read("src/app/rules/RuleSide.tsx");
    assert.match(r, /const menus = book\.data\.menus;/);
    assert.match(r, /<MenuPanel data=\{props\.data\} \/>/);
  });
});

describe("10. 直しG（カレンダーで休みを決める）と通しで：直したメニュー → 休みを決める → 一覧と ToDo → 戻す → 最初に戻す", () => {
  test("パーマを 150分にして 11/6 を休みにする：一覧の終わる時刻は 150分で、ToDo の文は今までどおり。戻すとメニューを直す前の一覧にまた出る", async () => {
    const { holidayPress, applyHoliday } = await import("../book/holidayFlow");
    const { withHolidays } = await import("../holidays");
    const perm150 = edit({ perm: { minutes: 150 } });
    let book = emptyBook("2026-11-04");
    const all = () => ledgerView(dataWith(perm150), book, NOW).all;
    // 1. 直したメニュー：11/6 10:30 の大橋様のパーマは 13:00 に終わる
    assert.equal(all().find((r) => r.id === "r05")?.end, "13:00");
    // 2. カレンダーで 11/6 を押す：予約がある日なので、まず一覧（終わる時刻も直したメニューで）
    const p = holidayPress({ shop, nowDate: "2026-11-04", dates: [], all: all(), date: "2026-11-06", epoch: book.epoch }, "calendar");
    assert.equal(p.kind, "ask");
    if (p.kind !== "ask") return;
    assert.deepEqual(p.ask.list.map((r) => `${r.start}–${r.end} ${r.menu.name}`), ["10:30–13:00 パーマ", "16:00–17:00 カット"]);
    // 3. 「それでも休みにする」：ToDo の文は日時とメニューの名前（名前は直せないので同じ文）
    let dates: string[] = [];
    const lines: string[] = [];
    const out = applyHoliday(
      {
        setHoliday: (d, on) => ((dates = on ? [...dates, d] : dates.filter((x) => x !== d)), { ok: true }),
        update: (f) => ((book = f(book)), { ok: true }),
        journal: (e) => void lines.push(e.text),
      },
      { shop, state: book, dates, date: "2026-11-06", on: true, list: p.ask.list, ask: p.ask, nowIso: NOW.toISOString(), todayDate: "2026-11-04" },
    );
    assert.ok(out.close);
    assert.deepEqual(book.todos.map((t) => t.title), ["大橋様に別の日時を案内（11/6（金） 10:30 パーマの代わり）", "加藤様に別の日時を案内（11/6（金） 16:00 カットの代わり）"]);
    // 休みの日の予約は、メニューを直す時の一覧には出さない（休みの日の ToDo で扱う）
    const longer = edit({ perm: { minutes: 150, lastStart: "10:00" } });
    const holShop = withHolidays(shop, dates);
    assert.ok(!menuConflicts({ shop: holShop, menus: longer, all: ledgerView({ ...dataWith(perm150), shop: holShop }, book, NOW).all, now: NOW_SHOP }).some((c) => c.id === "r05"));
    // 4. 休みを戻す：また営業日なので、パーマの最終受付を 10:00 にすると 11/6 10:30 の大橋様が一覧に出る
    const back = holidayPress({ shop: holShop, nowDate: "2026-11-04", dates, all: all(), date: "2026-11-06" }, "list");
    assert.deepEqual(back, { kind: "apply", on: false });
    dates = [];
    assert.match(menuConflicts({ shop, menus: longer, all: all(), now: NOW_SHOP }).find((c) => c.id === "r05")?.reasons.join() ?? "", /パーマの最終受付（10:00）を過ぎています/);
    // 5. 「最初に戻す」：直したメニューも休みの日も消える
    const w = resetAllWrites("2026-11-04");
    assert.equal(w.find((x) => x.key === MENUS_KEY)?.value, null);
    assert.equal(w.find((x) => x.key === "holidays")?.value, null);
  });
});
