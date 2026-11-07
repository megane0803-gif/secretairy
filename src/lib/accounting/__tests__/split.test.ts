// 経理の日報の「1日の売上の内訳」（1日の売上・技術売上・店販売上。直しK）。
// 空欄のまま保存できる・1つだけは断る・ずれた円を出して保存しない・前の形の日報を読めて直せる・売上の画面の内訳の数・日誌の1行。
// どれもプログラムの確かめ（AI は使わない・どこにも送らない）。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BrowserWrite } from "../../browser";
import { getAccounting } from "../../data/seed";
import { getAccountingSettings, getShop } from "../../settings";
import {
  checkDaily,
  commitDaily,
  dailyJournalText,
  dailyOf,
  draftFor,
  EMPTY_DAILY,
  parseDaily,
  SPLIT_FIELD,
  summarizeMonth,
  type DailyDeps,
  type DailyDraft,
  type DailyState,
} from "../daily";

const seed = getAccounting().sales;
const shop = getShop();
const limits = getAccountingSettings().daily;
const TODAY = "2026-11-06";
const ctx = { today: TODAY, methods: seed.methods, limits, shop };

/** 支払いで合計 30,000円（現金 10,000・カード 20,000）の1枚 */
const sheet = (total = "", tech = "", retail = "", date = TODAY): DailyDraft => ({
  date,
  visits: "4",
  pay: { cash: "10000", card: "20000", code: "" },
  split: { total, tech, retail },
});

function memDeps(start: DailyState = EMPTY_DAILY) {
  const box = { state: start, writes: 0, lines: [] as string[] };
  const deps: DailyDeps = {
    read: () => box.state,
    write: (s): BrowserWrite => {
      box.writes += 1;
      box.state = s;
      return { ok: true };
    },
    journal: (...l) => box.lines.push(...l.map((x) => `${x.who}：${x.text}`)),
    epochNow: () => "e1",
    nowIso: () => "2026-11-06T09:00:00.000Z",
  };
  const save = (draft: DailyDraft) => commitDaily(deps, { ...ctx, epoch: "e1", action: { kind: "save", draft } });
  return { box, save };
}

describe("内訳 1：空欄のまま保存できる（今の日報のまま）", () => {
  test("3つとも空欄なら内訳なしで保存し、日誌は「内訳なし」", () => {
    const m = memDeps();
    const r = m.save(sheet());
    assert.equal(r.ok, true);
    const d = dailyOf(m.box.state, TODAY)!;
    assert.equal(d.split, undefined);
    assert.deepEqual(m.box.lines, ["オーナー：日報を入れた（11/6（金） 売上 30,000円・来店 4人・内訳なし）"]);
  });
  test("内訳の欄が無い1枚（split なし）も同じに保存できる", () => {
    const m = memDeps();
    const { split: _drop, ...noSplit } = sheet();
    assert.equal(m.save(noSplit).ok, true);
    assert.equal(dailyOf(m.box.state, TODAY)!.split, undefined);
  });
  test("空白だけの欄は空欄と同じ", () => {
    assert.equal(checkDaily(sheet(" ", "　".trim(), ""), ctx).ok, true);
  });
});

describe("内訳 2：1つでも入れたら3つとも要る", () => {
  test("1日の売上だけ入れた時は断り、技術売上・店販売上の欄に理由を出す。書かない・日誌も無し", () => {
    const m = memDeps();
    const r = m.save(sheet("30000"));
    assert.equal(r.ok, false);
    if (r.ok) return;
    const fields = r.errors!.map((e) => e.field);
    assert.deepEqual(fields, [SPLIT_FIELD.tech, SPLIT_FIELD.retail]);
    assert.match(r.errors![0].text, /3つとも要ります/);
    assert.equal(m.box.writes, 0);
    assert.deepEqual(m.box.lines, []);
  });
  test("店販だけ入れた時も断る（0 を入れたのは「入れた」と数える）", () => {
    const c = checkDaily(sheet("", "", "0"), ctx);
    assert.equal(c.ok, false);
    if (c.ok) return;
    assert.deepEqual(
      c.errors.map((e) => e.field),
      [SPLIT_FIELD.total, SPLIT_FIELD.tech],
    );
  });
});

describe("内訳 3：合わない時は、どの欄が何円ずれているかを出して保存しない", () => {
  test("技術＋店販が1日の売上と合わない（店販 4,000円）→ 1,000円少ない", () => {
    const m = memDeps();
    const r = m.save(sheet("30000", "25000", "4000"));
    assert.equal(r.ok, false);
    if (r.ok) return;
    const e = r.errors!.find((x) => x.field === SPLIT_FIELD.parts)!;
    assert.equal(e.text, "技術売上と店販売上を足すと 29,000円で、1日の売上（30,000円）より 1,000円少ないです。");
    assert.equal(m.box.writes, 0);
    assert.deepEqual(m.box.lines, []);
  });
  test("多い時は「多い」", () => {
    const c = checkDaily(sheet("30000", "26000", "5000"), ctx);
    assert.equal(c.ok, false);
    if (c.ok) return;
    assert.match(c.errors.find((x) => x.field === SPLIT_FIELD.parts)!.text, /1,000円多いです/);
  });
  test("1日の売上が支払い方法ごとの合計と合わない → 1日の売上の欄に、ずれた円", () => {
    const m = memDeps();
    const r = m.save(sheet("32000", "27000", "5000"));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(
      r.errors!.map((e) => e.field),
      [SPLIT_FIELD.total],
    );
    assert.equal(r.errors![0].text, "1日の売上（32,000円）が、支払い方法ごとの合計（30,000円）より 2,000円多いです。");
    assert.equal(m.box.writes, 0);
  });
  test("両方ずれている時は両方出す", () => {
    const c = checkDaily(sheet("29000", "20000", "5000"), ctx);
    assert.equal(c.ok, false);
    if (c.ok) return;
    assert.deepEqual(c.errors.map((e) => e.field).sort(), [SPLIT_FIELD.parts, SPLIT_FIELD.total].sort());
  });
  test("数は 0 以上の整数で、上限は日報の売上と同じ", () => {
    const neg = checkDaily(sheet("30000", "-1", "5000"), ctx);
    assert.equal(neg.ok, false);
    const dec = checkDaily(sheet("30000", "25000.5", "5000"), ctx);
    assert.equal(dec.ok, false);
    const big = checkDaily(sheet(String(limits.maxTotalYen + 1), "0", "0"), ctx);
    assert.equal(big.ok, false);
    if (big.ok) return;
    assert.ok(big.errors.some((e) => e.field === SPLIT_FIELD.total && e.text.includes("までです")));
  });
  test("全角の数字・桁の「,」も読む", () => {
    const c = checkDaily(sheet("３０,０００", "25,000", "5000"), ctx);
    assert.equal(c.ok, true);
    if (!c.ok) return;
    assert.deepEqual(c.report.split, { total: 30000, tech: 25000, retail: 5000 });
  });
});

describe("内訳 4：合っていれば保存し、日誌は「内訳あり」。開き直しても戻る", () => {
  test("1日 30,000円／技術 25,000円／店販 5,000円 → 保存", () => {
    const m = memDeps();
    const r = m.save(sheet("30000", "25000", "5000"));
    assert.equal(r.ok, true);
    assert.deepEqual(dailyOf(m.box.state, TODAY)!.split, { total: 30000, tech: 25000, retail: 5000 });
    assert.deepEqual(m.box.lines, ["オーナー：日報を入れた（11/6（金） 売上 30,000円・来店 4人・内訳あり）"]);
    // ページを開き直す（ブラウザに書いた文字から読み直す）と内訳が戻り、1枚にも出る
    const again = parseDaily(JSON.stringify(m.box.state));
    assert.deepEqual(dailyOf(again, TODAY)!.split, { total: 30000, tech: 25000, retail: 5000 });
    assert.deepEqual(draftFor(TODAY, again, seed).draft.split, { total: "30000", tech: "25000", retail: "5000" });
  });
  test("日誌の1行（直した時・消した時）", () => {
    const rep = { visits: 4, pay: { cash: 30000 }, split: { total: 30000, tech: 25000, retail: 5000 } };
    assert.equal(dailyJournalText("edit", TODAY, shop, rep), "日報を直した（11/6（金） 売上 30,000円・来店 4人・内訳あり）");
    assert.equal(dailyJournalText("remove", TODAY, shop), "日報を消した（11/6（金））");
  });
  test("内訳を空欄に直すと、内訳なしになる", () => {
    const m = memDeps();
    m.save(sheet("30000", "25000", "5000"));
    const r = m.save(sheet());
    assert.equal(r.ok, true);
    assert.equal(dailyOf(m.box.state, TODAY)!.split, undefined);
    assert.match(m.box.lines[1], /日報を直した（.*・内訳なし）/);
  });
});

describe("内訳 5：前に入れた日報（内訳なしの形）も、そのまま読めて直せる", () => {
  const old = JSON.stringify({ v: 1, days: [{ date: "2026-11-05", visits: 2, pay: { cash: 15000 }, at: "2026-11-05T09:00:00.000Z" }] });
  test("読める（内訳なし・数はそのまま）。1枚の内訳は空欄", () => {
    const s = parseDaily(old);
    assert.equal(s.days.length, 1);
    assert.deepEqual(s.days[0], { date: "2026-11-05", visits: 2, pay: { cash: 15000 }, at: "2026-11-05T09:00:00.000Z" });
    const d = draftFor("2026-11-05", s, seed);
    assert.equal(d.from, "daily");
    assert.deepEqual(d.draft.split, { total: "", tech: "", retail: "" });
  });
  test("直して内訳を足せる", () => {
    const m = memDeps(parseDaily(old));
    const d = draftFor("2026-11-05", m.box.state, seed).draft;
    const r = m.save({ ...d, split: { total: "15000", tech: "12000", retail: "3000" } });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.kind, "edit");
    assert.deepEqual(dailyOf(m.box.state, "2026-11-05")!.split, { total: 15000, tech: 12000, retail: 3000 });
  });
  test("内訳の形がおかしい時は、内訳だけ読まない（その日の日報は残す）", () => {
    const bad = JSON.stringify({
      v: 1,
      days: [
        { date: "2026-11-02", visits: 1, pay: { cash: 1000 }, split: { total: 1000, tech: 900, retail: 50 }, at: "" },
        { date: "2026-11-03", visits: 1, pay: { cash: 1000 }, split: { total: "1000", tech: 1000, retail: 0 }, at: "" },
        { date: "2026-11-05", visits: 1, pay: { cash: 1000 }, split: "x", at: "" },
      ],
    });
    const s = parseDaily(bad);
    assert.equal(s.days.length, 3);
    assert.ok(s.days.every((d) => d.split === undefined));
  });
});

describe("内訳 6：売上の画面の内訳の数（プログラムが日ごとの数から出す）", () => {
  const state: DailyState = {
    v: 1,
    days: [
      { date: "2026-11-02", visits: 3, pay: { cash: 30000 }, split: { total: 30000, tech: 25000, retail: 5000 }, at: "" },
      { date: "2026-11-03", visits: 2, pay: { card: 12000 }, at: "" },
      { date: "2026-11-05", visits: 1, pay: { code: 8000 }, split: { total: 8000, tech: 8000, retail: 0 }, at: "" },
    ],
  };
  const s = summarizeMonth("2026-11", seed, state, shop, TODAY);
  test("その日：内訳を入れた日だけ技術・店販", () => {
    assert.deepEqual(s.days.find((d) => d.date === "2026-11-02")!.split, { tech: 25000, retail: 5000 });
    assert.equal(s.days.find((d) => d.date === "2026-11-03")!.split, null);
    assert.deepEqual(s.days.find((d) => d.date === "2026-11-05")!.split, { tech: 8000, retail: 0 });
  });
  test("月の1行：内訳を入れた日の分だけ足し、日数も数える", () => {
    assert.deepEqual(s.split, { tech: 33000, retail: 5000, days: 2 });
    // 売上の大きい数字は今まで通り（内訳の無い日も入る）
    assert.equal(s.total, 50000);
  });
  test("最初から入っている10月には内訳が無い（0日分）", () => {
    const oct = summarizeMonth(seed.month, seed, EMPTY_DAILY, shop, TODAY);
    assert.deepEqual(oct.split, { tech: 0, retail: 0, days: 0 });
    assert.ok(oct.days.every((d) => d.split === null));
  });
});
