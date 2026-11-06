// 経理の日報：オーナーがその日の売上を自分で入れる（このブラウザだけ。どこにも送らない）。
// 数の確かめ・入れる・直す・消す・月の選び・「まだ」の日・保存できなかった時・最初に戻す。
// ブラウザの置き場所（localStorage）は、テストの中だけの物に置きかえる（日報だけ「いっぱい」にできる）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, test } from "node:test";
import { BOOK_KEY, BROWSER_PREFIX, DAILY_KEY, JOURNAL_KEY, readBrowser, SAVE_FAILED_MESSAGE, writeBrowser, type BrowserWrite } from "../../browser";
import { calDay } from "../../calendar";
import { getAccounting } from "../../data/seed";
import { parseJournal } from "../../journal";
import { resetAll } from "../../reset";
import { emptyBook } from "../../book/state";
import { getAccountingSettings, getShop, type DailyLimits } from "../../settings";
import {
  checkDaily,
  commitDaily,
  DAILY_RESET_MESSAGE,
  dailyOf,
  draftFor,
  EMPTY_DAILY,
  initialMonth,
  monthAfterRemove,
  monthSales,
  parseCount,
  parseDaily,
  salesMonths,
  summarizeMonth,
  withDaily,
  withoutDaily,
  type DailyAction,
  type DailyDeps,
  type DailyDraft,
  type DailyReport,
  type DailyState,
} from "../daily";
import { browserDailyDeps, readDaily } from "../dailyStore";
import { summarizeSales } from "../sales";

const seed = getAccounting().sales;
const shop = getShop();
const limits = getAccountingSettings().daily;
const methods = seed.methods;
const TODAY = "2026-11-06"; // 金曜
const ctx = { today: TODAY, methods, limits, shop };

const draft = (date: string, visits: string, cash = "", card = "", code = ""): DailyDraft => ({ date, visits, pay: { cash, card, code } });
const report = (date: string, visits: number, cash = 0, card = 0, code = 0): DailyReport => ({ date, visits, pay: { cash, card, code }, at: "2026-11-06T09:00:00.000Z" });
const stateOf = (...r: DailyReport[]): DailyState => ({ v: 1, days: [...r].sort((a, b) => a.date.localeCompare(b.date)) });

/** テストの中だけで書く所。fail = 書けない */
function memDeps(start: DailyState = EMPTY_DAILY, epoch: string | undefined = "e1") {
  const box = { state: start, fail: false as false | "full" | "denied", epoch, lines: [] as string[], writes: 0 };
  const deps: DailyDeps = {
    read: () => box.state,
    write: (s): BrowserWrite => {
      if (box.fail) return { ok: false, why: box.fail };
      box.writes += 1;
      box.state = s;
      return { ok: true };
    },
    journal: (...l) => box.lines.push(...l.map((x) => `${x.who}：${x.text}`)),
    epochNow: () => box.epoch,
    nowIso: () => "2026-11-06T09:00:00.000Z",
  };
  const run = (action: DailyAction, openedEpoch: string | undefined = "e1") => commitDaily(deps, { ...ctx, epoch: openedEpoch, action });
  return { box, deps, run };
}

// ── テストの中だけのブラウザ ───────────────────────────────
const store = new Map<string, string>();
let dailyFails = false;
const g = globalThis as { window?: unknown; fetch?: unknown };
let had: unknown;
let hadFetch: unknown;
let fetched = 0;
before(() => {
  had = g.window;
  hadFetch = g.fetch;
  g.window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (k === BROWSER_PREFIX + DAILY_KEY && dailyFails) {
          const e = new Error("The quota has been exceeded.");
          e.name = "QuotaExceededError";
          throw e;
        }
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  // どこにも送らない：fetch が呼ばれたら数える
  g.fetch = () => {
    fetched += 1;
    return Promise.reject(new Error("送らない"));
  };
});
after(() => {
  g.window = had;
  g.fetch = hadFetch;
});
beforeEach(() => {
  store.clear();
  dailyFails = false;
  fetched = 0;
});

describe("日報 1：数の確かめ（プログラム）", () => {
  test("0 以上の整数だけ。空欄は 0。負の数・小数・数でない物は断る", () => {
    assert.equal(parseCount(""), 0);
    assert.equal(parseCount("  "), 0);
    assert.equal(parseCount("32400"), 32400);
    assert.equal(parseCount("32,400"), 32400, "桁の「,」は読む");
    assert.equal(parseCount("３２４００"), 32400, "全角の数字は読む");
    assert.equal(parseCount("0"), 0);
    for (const bad of ["-1", "1.5", "0.0", "1e3", "abc", "１.５", "+3", "3人"]) assert.equal(parseCount(bad), null, bad);
  });

  test("空欄は 0 として入れられる（売上も来店も 0 の日も「入れた日」）", () => {
    const c = checkDaily(draft("2026-11-06", ""), ctx);
    assert.ok(c.ok);
    assert.deepEqual(c.report, { date: "2026-11-06", visits: 0, pay: { cash: 0, card: 0, code: 0 } });
    assert.equal(c.total, 0);
  });

  test("負の数・小数は、どの欄でも断る", () => {
    assert.equal(checkDaily(draft(TODAY, "-1"), ctx).ok, false);
    assert.equal(checkDaily(draft(TODAY, "2.5"), ctx).ok, false);
    const c = checkDaily(draft(TODAY, "3", "1000.5", "-200"), ctx);
    assert.equal(c.ok, false);
    assert.deepEqual(c.errors.map((e) => e.field).sort(), ["card", "cash"]);
    assert.equal(c.total, null, "足せない時は合計を出さない");
  });

  test("上限：1日の売上の合計は 1,000,000円まで、来店は 50人まで", () => {
    assert.equal(limits.maxTotalYen, 1_000_000);
    assert.equal(limits.maxVisits, 50);
    assert.equal(limits.maxDays, 400);
    assert.ok(checkDaily(draft(TODAY, "50", "500000", "300000", "200000"), ctx).ok, "ちょうど上限は通る");
    const over = checkDaily(draft(TODAY, "4", "500000", "300000", "200001"), ctx);
    assert.equal(over.ok, false);
    assert.equal(over.errors[0].field, "total");
    assert.match(over.errors[0].text, /1,000,000円まで/);
    const many = checkDaily(draft(TODAY, "51"), ctx);
    assert.equal(many.ok, false);
    assert.match(many.errors[0].text, /50人まで/);
  });

  test("先の日と、本当にない日付は断る。過ぎた日は入れられる", () => {
    assert.match(checkDaily(draft("2026-11-07", "1"), ctx).errors[0].text, /先の日/);
    for (const d of ["2026-02-30", "2026-13-01", "2026-11-31", "", "2026/11/06", "2026-11-6"]) {
      const c = checkDaily(draft(d, "1"), ctx);
      assert.equal(c.ok, false, d);
      assert.equal(c.errors[0].field, "date", d);
    }
    assert.ok(checkDaily(draft("2026-09-15", "1"), ctx).ok, "過ぎた日");
    assert.ok(checkDaily(draft("2028-02-29".replace("2028", "2024"), "1"), ctx).ok, "うるう年の 2/29");
  });

  test("合計はプログラムが足す", () => {
    const c = checkDaily(draft(TODAY, "4", "8,000", "16400", "8000"), ctx);
    assert.ok(c.ok);
    assert.equal(c.total, 32400);
  });

  test("決まった上限は config/accounting.json にあり、コードに直に書かない", () => {
    const cfg = JSON.parse(readFileSync("config/accounting.json", "utf8"));
    assert.deepEqual(cfg.daily, { maxTotalYen: 1000000, maxVisits: 50, maxDays: 400 });
    const src = readFileSync("src/lib/accounting/daily.ts", "utf8");
    assert.doesNotMatch(src, /1_?000_?000|\b400\b|\b50\b/);
  });
});

describe("日報 2：400日に達した時は、新しい日だけ断り、直す・消すはできる", () => {
  const full = (): DailyState => {
    const days: DailyReport[] = [];
    let d = new Date(Date.UTC(2025, 0, 1));
    for (let i = 0; i < limits.maxDays; i++) {
      days.push(report(d.toISOString().slice(0, 10), 1, 1000));
      d = new Date(d.getTime() + 86_400_000);
    }
    return { v: 1, days };
  };

  test("新しい日は断り、古い日報は消さない（理由を出す）", () => {
    const s = full();
    const r = withDaily(s, report(TODAY, 2, 5000), limits);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /400日分まで/);
    const m = memDeps(s);
    const c = m.run({ kind: "save", draft: draft(TODAY, "2", "5000") });
    assert.equal(c.ok, false);
    assert.equal(m.box.state.days.length, limits.maxDays, "古い日報はそのまま");
    assert.equal(m.box.state.days[0].date, "2025-01-01");
    assert.equal(m.box.lines.length, 0);
  });

  test("すでにある日は直せる・消せる", () => {
    const s = full();
    const m = memDeps(s);
    const edit = m.run({ kind: "save", draft: draft("2025-01-01", "3", "9000") });
    assert.ok(edit.ok && edit.kind === "edit");
    assert.equal(dailyOf(m.box.state, "2025-01-01")?.pay.cash, 9000);
    const rm = m.run({ kind: "remove", date: "2025-01-02" });
    assert.ok(rm.ok && rm.kind === "remove");
    assert.equal(m.box.state.days.length, limits.maxDays - 1);
    // 1日空いたので、新しい日を入れられる
    assert.ok(m.run({ kind: "save", draft: draft(TODAY, "1") }).ok);
  });

  test("読み込みは本当にない日付・負の数・同じ日の2つ目を捨てる", () => {
    const raw = JSON.stringify({
      v: 1,
      days: [report("2026-11-02", 2, 100), report("2026-11-02", 9, 900), report("2026-02-30", 1), { ...report("2026-11-03", 1), visits: -1 }, { ...report("2026-11-04", 1), pay: { cash: 1.5 } }],
    });
    const s = parseDaily(raw);
    assert.deepEqual(s.days.map((d) => d.date), ["2026-11-02"]);
    assert.equal(s.days[0].visits, 2);
    assert.deepEqual(parseDaily("こわれた"), EMPTY_DAILY);
    assert.deepEqual(parseDaily(null), EMPTY_DAILY);
  });
});

describe("日報 3：入れる・直す・消す。10月の日を置き換え、消すと元の10月の数に戻る", () => {
  test("入れる → 直す → 消す。日誌は保存できた時に1行ずつ", () => {
    const m = memDeps();
    const add = m.run({ kind: "save", draft: draft(TODAY, "4", "8000", "16400", "8000") });
    assert.ok(add.ok && add.kind === "add" && add.month === "2026-11");
    assert.deepEqual(m.box.lines, ["オーナー：日報を入れた（11/6（金） 売上 32,400円・来店 4人）"]);
    const edit = m.run({ kind: "save", draft: draft(TODAY, "5", "10000", "16400", "8000") });
    assert.ok(edit.ok && edit.kind === "edit");
    assert.equal(m.box.state.days.length, 1, "同じ日は1つのまま（書き換える）");
    assert.equal(m.box.lines[1], "オーナー：日報を直した（11/6（金） 売上 34,400円・来店 5人）");
    const rm = m.run({ kind: "remove", date: TODAY });
    assert.ok(rm.ok && rm.kind === "remove");
    assert.equal(m.box.state.days.length, 0);
    assert.equal(m.box.lines[2], "オーナー：日報を消した（11/6（金））");
  });

  test("無い日は消せない", () => {
    const m = memDeps();
    const r = m.run({ kind: "remove", date: TODAY });
    assert.equal(r.ok, false);
    assert.equal(m.box.writes, 0);
    assert.equal(withoutDaily(EMPTY_DAILY, TODAY).ok, false);
  });

  test("10月の日の日報は、来店とすべての支払い方法をまるごと置き換える（足さない）", () => {
    const base = seed.days.find((d) => d.date === "2026-10-01")!;
    assert.ok(base.pay.card > 0 && base.pay.code > 0);
    const s = stateOf(report("2026-10-01", 1, 5000, 0, 0));
    const oct = monthSales("2026-10", seed, s);
    const row = oct.days.find((d) => d.date === "2026-10-01")!;
    assert.deepEqual(row, { date: "2026-10-01", visits: 1, pay: { cash: 5000, card: 0, code: 0 } });
    assert.equal(oct.days.length, seed.days.length, "日の数は変わらない");
    const before = summarizeSales(seed, shop);
    const after = summarizeMonth("2026-10", seed, s, shop, TODAY);
    const baseTotal = Object.values(base.pay).reduce((a, b) => a + b, 0);
    assert.equal(after.total, before.total - baseTotal + 5000);
    assert.equal(after.visits, before.visits - base.visits + 1);
  });

  test("10月の日の日報を消すと、最初から入っている10月の数に戻る", () => {
    const m = memDeps(stateOf(report("2026-10-01", 1, 5000)));
    assert.ok(m.run({ kind: "remove", date: "2026-10-01" }).ok);
    const back = summarizeMonth("2026-10", seed, m.box.state, shop, TODAY);
    const orig = summarizeSales(seed, shop);
    assert.equal(back.total, orig.total);
    assert.equal(back.visits, orig.visits);
    assert.deepEqual(back.methods, orig.methods);
  });

  test("日付を変えた時に読み直す順：その日の日報 → 最初から入っている10月の数 → 空欄", () => {
    const s = stateOf(report("2026-10-01", 1, 5000), report("2026-11-02", 3, 0, 21000));
    // 日報がある10月の日 → 日報
    const a = draftFor("2026-10-01", s, seed);
    assert.equal(a.from, "daily");
    assert.deepEqual(a.draft, draft("2026-10-01", "1", "5000", "0", "0"));
    // 日報が無い10月の日 → 最初から入っている数
    const b = draftFor("2026-10-02", s, seed);
    assert.equal(b.from, "seed");
    assert.deepEqual(b.draft, draft("2026-10-02", "3", "9600", "3300", "0"));
    // 日報がある11月の日 → 日報
    assert.equal(draftFor("2026-11-02", s, seed).from, "daily");
    // 何も無い日（11月・10月の定休日）→ 空欄
    const c = draftFor("2026-11-04", s, seed);
    assert.equal(c.from, "empty");
    assert.deepEqual(c.draft, draft("2026-11-04", ""));
    assert.equal(draftFor("2026-10-06", s, seed).from, "empty", "10/6（火）は定休日で、最初の数が無い");
  });

  test("休業日にも入れられる（臨時の営業）", () => {
    assert.equal(calDay(shop, "2026-11-03").open, false, "11/3 は火曜（定休日）");
    const m = memDeps();
    assert.ok(m.run({ kind: "save", draft: draft("2026-11-03", "2", "12000") }).ok);
  });
});

describe("日報 4：月の数は日報と合い、ほかの月の行が混ざらない。休業日の日報も棒と表に出る", () => {
  const s = stateOf(
    report("2026-11-02", 3, 6000, 12000, 0),
    report("2026-11-03", 2, 0, 0, 11000), // 火曜（定休日）に臨時の営業
    report("2026-11-04", 0), // 0円で入れた日
    report("2026-10-01", 1, 5000),
    report("2026-12-01", 9, 99999), // 先の月（混ざらないか見るためだけ）
  );

  test("11月：売上・来店・客単価・支払い方法の割合が日報だけから出る", () => {
    const n = summarizeMonth("2026-11", seed, s, shop, TODAY);
    assert.equal(n.key, "2026-11");
    assert.equal(n.year, 2026);
    assert.equal(n.month, 11);
    assert.equal(n.total, 6000 + 12000 + 11000);
    assert.equal(n.visits, 5);
    assert.equal(n.perVisit, Math.round(29000 / 5));
    assert.deepEqual(
      n.methods.map((m) => [m.id, m.amount, m.pct]),
      [
        ["cash", 6000, Math.round((6000 / 29000) * 100)],
        ["card", 12000, Math.round((12000 / 29000) * 100)],
        ["code", 11000, Math.round((11000 / 29000) * 100)],
      ],
    );
    assert.equal(n.days.length, 30);
  });

  test("ほかの月の行が混ざらない（10月の数・12月の数は11月に入らない）", () => {
    const n = monthSales("2026-11", seed, s);
    assert.ok(n.days.every((d) => d.date.startsWith("2026-11-")));
    const oct = monthSales("2026-10", seed, s);
    assert.ok(oct.days.every((d) => d.date.startsWith("2026-10-")));
    const dec = summarizeMonth("2026-12", seed, s, shop, TODAY);
    assert.equal(dec.total, 99999);
  });

  test("休業日の日報は、棒と表に数を出す", () => {
    const n = summarizeMonth("2026-11", seed, s, shop, TODAY);
    const tue = n.days.find((d) => d.date === "2026-11-03")!;
    assert.equal(tue.open, false);
    assert.equal(tue.shown, true);
    assert.equal(tue.daily, true);
    assert.equal(tue.sales, 11000);
    assert.equal(tue.visits, 2);
    // 日報の無い定休日は今まで通り点
    const tue2 = n.days.find((d) => d.date === "2026-11-10")!;
    assert.equal(tue2.shown, false);
  });

  test("日報から入った日には印（daily）が付く", () => {
    const n = summarizeMonth("2026-11", seed, s, shop, TODAY);
    assert.deepEqual(n.days.filter((d) => d.daily).map((d) => d.date), ["2026-11-02", "2026-11-03", "2026-11-04"]);
    const oct = summarizeMonth("2026-10", seed, s, shop, TODAY);
    assert.deepEqual(oct.days.filter((d) => d.daily).map((d) => d.date), ["2026-10-01"]);
  });

  test("日報が1つも無い時の10月は、今の summarizeSales とまったく同じ数", () => {
    const now = summarizeSales(seed, shop);
    const m = summarizeMonth("2026-10", seed, EMPTY_DAILY, shop, TODAY);
    assert.equal(m.total, now.total);
    assert.equal(m.visits, now.visits);
    assert.equal(m.perVisit, now.perVisit);
    assert.deepEqual(m.methods, now.methods);
    assert.equal(m.maxDay, now.maxDay);
    assert.deepEqual(
      m.days.map((d) => [d.date, d.sales, d.visits, d.open, d.shown, d.daily, d.missing]),
      now.days.map((d) => [d.date, d.sales, d.visits, d.open, d.open, false, false]),
    );
    assert.equal(m.missingCount, 0, "10月は「まだ」の日が無い（今の表のまま）");
  });
});

describe("日報 5：開いた時の月・保存した後の月・最後の1件を消した後の月", () => {
  test("選べる月は、最初から入っている10月と、日報が入っている月", () => {
    assert.deepEqual(salesMonths(EMPTY_DAILY, seed.month), ["2026-10"]);
    assert.deepEqual(salesMonths(stateOf(report("2026-11-02", 1), report("2026-09-30", 1)), seed.month), ["2026-09", "2026-10", "2026-11"]);
  });

  test("開いた時：日報が入っている一番新しい月（無ければ10月）", () => {
    assert.equal(initialMonth(EMPTY_DAILY, seed.month), "2026-10");
    assert.equal(initialMonth(stateOf(report("2026-09-30", 1)), seed.month), "2026-09");
    assert.equal(initialMonth(stateOf(report("2026-09-30", 1), report("2026-11-02", 1), report("2026-10-03", 1)), seed.month), "2026-11");
  });

  test("保存した後：その日の月", () => {
    const m = memDeps(stateOf(report("2026-11-02", 1)));
    const r = m.run({ kind: "save", draft: draft("2026-09-12", "2", "3000") });
    assert.ok(r.ok);
    assert.equal(r.ok && r.month, "2026-09");
  });

  test("最後の1件を消した後：見ていた月に日報が無くなったら「日報が入っている一番新しい月 → 10月」", () => {
    const s = stateOf(report("2026-09-30", 1), report("2026-11-02", 1));
    const noNov = withoutDaily(s, "2026-11-02");
    assert.ok(noNov.ok);
    if (noNov.ok) assert.equal(monthAfterRemove("2026-11", noNov.state, seed.month), "2026-09");
    const none = withoutDaily(stateOf(report("2026-11-02", 1)), "2026-11-02");
    if (none.ok) assert.equal(monthAfterRemove("2026-11", none.state, seed.month), "2026-10");
    // まだ日報が残る月・10月は、そのまま
    assert.equal(monthAfterRemove("2026-11", stateOf(report("2026-11-02", 1)), seed.month), "2026-11");
    assert.equal(monthAfterRemove("2026-10", EMPTY_DAILY, seed.month), "2026-10");
  });
});

describe("日報 6：「まだ」の日", () => {
  test("今日までの営業日で、日報も最初の数も無い日。0円の日は入れた日、先の日と休業日は数えない", () => {
    const s = stateOf(report("2026-11-02", 3, 6000), report("2026-11-04", 0));
    const n = summarizeMonth("2026-11", seed, s, shop, TODAY);
    // 11/1（日）まだ・11/2（月）入れた・11/3（火）定休日・11/4（水）0円で入れた・11/5（木）まだ・11/6（金）今日でまだ・11/7 から先の日
    assert.deepEqual(n.days.filter((d) => d.missing).map((d) => d.date), ["2026-11-01", "2026-11-05", "2026-11-06"]);
    assert.equal(n.missingCount, 3);
    assert.ok(n.days.filter((d) => d.date > TODAY).every((d) => !d.missing && d.ahead));
    assert.equal(n.days.find((d) => d.date === "2026-11-03")!.missing, false, "定休日は数えない");
  });

  test("「翌日へ」で進めた今日までを数える（今日が変われば変わる）", () => {
    const n = summarizeMonth("2026-11", seed, EMPTY_DAILY, shop, "2026-11-09");
    assert.equal(n.missingCount, 8, "11/1〜11/9 の9日から 11/3（火・定休日）を除いた8日");
    assert.equal(summarizeMonth("2026-11", seed, EMPTY_DAILY, shop, TODAY).missingCount, 5, "11/6 までなら 5日");
  });
});

describe("日報 7：保存できなかった時は、画面の数も日誌も変わらず、1枚に数が残る", () => {
  test("入れる・直す・消すのどれも、書けなければ SAVE_FAILED_MESSAGE（日誌は書かない）", () => {
    const start = stateOf(report("2026-11-02", 3, 6000));
    const m = memDeps(start);
    m.box.fail = "full";
    const d = draft(TODAY, "4", "32400");
    for (const action of [{ kind: "save", draft: d }, { kind: "save", draft: draft("2026-11-02", "1") }, { kind: "remove", date: "2026-11-02" }] as DailyAction[]) {
      const r = m.run(action);
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.message, SAVE_FAILED_MESSAGE);
        assert.equal(r.written, false, "1枚は閉じずに数を残す");
        assert.ok(!r.reset);
      }
    }
    assert.deepEqual(m.box.state, start, "数は変わらない");
    assert.equal(m.box.lines.length, 0, "日誌は書かない");
    assert.deepEqual(d, draft(TODAY, "4", "32400"), "入れた数はそのまま");
    // もう一度押せば保存でき、日誌は1回だけ
    m.box.fail = false;
    assert.ok(m.run({ kind: "save", draft: d }).ok);
    assert.equal(m.box.lines.length, 1);
  });

  test("このブラウザの置き場所がいっぱいの時も同じ（画面と同じ書き方）", () => {
    dailyFails = true;
    const r = commitDaily(browserDailyDeps, { ...ctx, epoch: undefined, action: { kind: "save", draft: draft(TODAY, "4", "32400") } });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.message, SAVE_FAILED_MESSAGE);
    assert.equal(readBrowser(DAILY_KEY), null);
    assert.deepEqual(parseJournal(readBrowser(JOURNAL_KEY)), []);
    dailyFails = false;
    const ok = commitDaily(browserDailyDeps, { ...ctx, epoch: undefined, action: { kind: "save", draft: draft(TODAY, "4", "32400") } });
    assert.ok(ok.ok);
    assert.equal(readDaily().days.length, 1);
    const j = parseJournal(readBrowser(JOURNAL_KEY));
    assert.equal(j.length, 1);
    assert.equal(j[0].who, "オーナー");
    assert.equal(j[0].text, "日報を入れた（11/6（金） 売上 32,400円・来店 4人）");
  });

  test("決まりで断った時（数の確かめ）も書かない・日誌も書かない", () => {
    const m = memDeps();
    const r = m.run({ kind: "save", draft: draft(TODAY, "1.5") });
    assert.equal(r.ok, false);
    assert.equal(m.box.writes, 0);
    assert.equal(m.box.lines.length, 0);
  });
});

describe("日報 8：「最初に戻す」で消える。開いている1枚の数は、戻した後に保存しない", () => {
  test("最初に戻すと日報は消え、売上の欄は10月に戻る", () => {
    writeBrowser(BOOK_KEY, JSON.stringify(emptyBook(TODAY, "e-old")));
    assert.ok(commitDaily(browserDailyDeps, { ...ctx, epoch: "e-old", action: { kind: "save", draft: draft(TODAY, "4", "32400") } }).ok);
    assert.equal(initialMonth(readDaily(), seed.month), "2026-11");
    const r = resetAll(TODAY);
    assert.ok(r.written);
    assert.equal(readBrowser(DAILY_KEY), null);
    assert.deepEqual(readDaily(), EMPTY_DAILY);
    assert.equal(initialMonth(readDaily(), seed.month), "2026-10");
  });

  test("戻す前に開いた1枚の数は、戻した後に保存しない（印が違う）", () => {
    writeBrowser(BOOK_KEY, JSON.stringify(emptyBook(TODAY, "e-old")));
    const opened = "e-old"; // 1枚を開いた時の印
    resetAll(TODAY);
    const r = commitDaily(browserDailyDeps, { ...ctx, epoch: opened, action: { kind: "save", draft: draft(TODAY, "4", "32400") } });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reset, true);
      assert.equal(r.message, DAILY_RESET_MESSAGE);
    }
    assert.equal(readBrowser(DAILY_KEY), null);
    assert.ok(!parseJournal(readBrowser(JOURNAL_KEY)).some((e) => e.text.startsWith("日報を")));
    // 消すも同じ
    const m = memDeps(stateOf(report(TODAY, 1)), "e-new");
    assert.equal(m.run({ kind: "remove", date: TODAY }, "e-old").ok, false);
    assert.equal(m.box.state.days.length, 1);
  });

  test("画面は台帳の印が変わったのを見て、開いている1枚を閉じる", () => {
    const src = readFileSync("src/app/accounting/SalesReport.tsx", "utf8");
    assert.match(src, /book\.state\.epoch/);
    assert.match(src, /setSheet\(null\)/);
    const sheet = readFileSync("src/app/accounting/DailySheet.tsx", "utf8");
    assert.match(sheet, /currentEpoch\(\)/);
  });
});

describe("日報 9：freee・会計（架空）・AI に何も送らない", () => {
  test("入れる・直す・消すの間に fetch を呼ばない", () => {
    writeBrowser(BOOK_KEY, JSON.stringify(emptyBook(TODAY)));
    const e = undefined;
    commitDaily(browserDailyDeps, { ...ctx, epoch: e, action: { kind: "save", draft: draft(TODAY, "4", "32400") } });
    commitDaily(browserDailyDeps, { ...ctx, epoch: e, action: { kind: "save", draft: draft(TODAY, "5", "40000") } });
    commitDaily(browserDailyDeps, { ...ctx, epoch: e, action: { kind: "remove", date: TODAY } });
    assert.equal(fetched, 0);
  });

  test("日報の所は、freee・会計（架空）・AI の窓口と道具を読み込まない", () => {
    for (const f of ["src/lib/accounting/daily.ts", "src/lib/accounting/dailyStore.ts", "src/app/accounting/DailySheet.tsx", "src/app/accounting/SalesReport.tsx"]) {
      const src = readFileSync(f, "utf8");
      assert.doesNotMatch(src, /fetch\(|postAi|\/api\/|from "@?\/?.*freee|from "\.\.\/ai|accounting\/state|register\(/, f);
    }
  });

  test("会計（架空）の登録の記録（accounting）には日報を書かない", () => {
    writeBrowser(BOOK_KEY, JSON.stringify(emptyBook(TODAY)));
    commitDaily(browserDailyDeps, { ...ctx, epoch: undefined, action: { kind: "save", draft: draft(TODAY, "4", "32400") } });
    assert.deepEqual([...store.keys()].sort(), [BROWSER_PREFIX + BOOK_KEY, BROWSER_PREFIX + DAILY_KEY, BROWSER_PREFIX + JOURNAL_KEY].sort());
  });
});
