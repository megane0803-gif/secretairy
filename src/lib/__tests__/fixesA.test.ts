// 直しA：混んだ時・失敗した時・日付の境目で、画面の文が壊れる・成功していないのに成功と出る・日付が食い違う所の直し。
// ブラウザの置き場所（localStorage）は、テストの中だけの物に置きかえる（台帳だけ「いっぱい」「断られた」にできる）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, test } from "node:test";
import { BOOK_KEY, BROWSER_PREFIX, JOURNAL_KEY, readBrowser, SAVE_FAILED_MESSAGE, writeBrowser } from "../browser";
import type { HoldOffer, ReserveEvent } from "../ai/wire";
import { createChatRuns } from "../ai/chatRuns";
import { cutNotice, holdInto, readReserveStream } from "../ai/reserveStream";
import { canNextDay, emptyBook, LAST_DEMO_DAY, nextDayStep, parseBook, sameEpoch } from "../book/state";
import { currentEpoch, readBook, updateBook } from "../book/store";
import { resetAllWrites } from "../reset";
import { businessDayAt, calDay, dayDiff as calDiff, demoClock, demoInstant, MAX_DAY_OFFSET, realDayNote, shopToday } from "../calendar";
import { EMPTY_ACCOUNTING } from "../accounting/state";
import { buildTable } from "../ads/report";
import { runReview } from "../ads/review";
import { scriptAdsModel } from "../ads/script";
import { canPropose, EMPTY_ADS, withProposal, type AdsState } from "../ads/state";
import { getBookData } from "../book/data";
import { getAds, getTodos } from "../data/seed";
import { runJob, type JobEnv } from "../jobs/run";
import { EMPTY_JOBS } from "../jobs/state";
import { getRules } from "../rules/store";
import { parseJournal, writeJournal } from "../journal";
import type { SavedKarte } from "../karte/record";
import { commitKarteSave } from "../karte/save";
import { getAdSettings, getAiSettings, getKarteHeadings, getMenus, getSavedMemoMaxChars, getShop } from "../settings";
import { readRequest } from "../ai/script";
import { at, chat, ctxAt } from "../ai/__tests__/helpers";
import { scriptSortModel } from "../line/sort";
import { resolveSeedTodos } from "../todo/items";
import { commitMemoTodo } from "../todo/throw";

const shop = getShop();
const headings = getKarteHeadings();
const today = "2026-11-04"; // 水曜

// ── テストの中だけのブラウザ ───────────────────────────────
const store = new Map<string, string>();
/** 台帳（book）を書く時だけの失敗：full = いっぱい / denied = 断られた / null = 普通に書ける */
let bookFails: "full" | "denied" | null = null;
const g = globalThis as { window?: unknown };
let had: unknown;
before(() => {
  had = g.window;
  g.window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (k === BROWSER_PREFIX + BOOK_KEY && bookFails === "full") {
          const e = new Error("The quota has been exceeded.");
          e.name = "QuotaExceededError";
          throw e;
        }
        if (k === BROWSER_PREFIX + BOOK_KEY && bookFails === "denied") {
          const e = new Error("The operation is insecure.");
          e.name = "SecurityError";
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
  bookFails = null;
  writeBrowser(BOOK_KEY, JSON.stringify(emptyBook(today)));
});

const journal = () => parseJournal(readBrowser(JOURNAL_KEY));

describe("直しA 1：保存できなかった時は「保存しました」「足しました」と出さない", () => {
  test("writeBrowser は書けたかを返す（いっぱい・断られた・普通）。例外は外へ投げない", () => {
    assert.deepEqual(writeBrowser("x", "1"), { ok: true });
    bookFails = "full";
    assert.deepEqual(writeBrowser(BOOK_KEY, "{}"), { ok: false, why: "full" });
    bookFails = "denied";
    assert.deepEqual(writeBrowser(BOOK_KEY, "{}"), { ok: false, why: "denied" });
    // 失敗した時は前の中身のまま
    assert.equal(parseBook(readBrowser(BOOK_KEY))?.anchor, today);
    assert.deepEqual(updateBook((s) => ({ ...s, dayOffset: 3 }), today), { ok: false, why: "denied" });
    assert.equal(readBook(today).dayOffset, 0);
  });

  const karte = (n: number): SavedKarte => ({
    id: `k-${today}-c01-${n}`,
    customerId: "c01",
    date: today,
    menuId: "cut",
    memo: "根元が伸びていた",
    sections: { next: ["次は2か月後にカット"], treatment: ["カット"] },
    savedAt: `${today}T08:00:0${n}.000Z`,
  });

  /** 画面と同じつなぎ方：書く・日誌・案を消す */
  const saveKarte = (n: number, draft: { has: boolean }) =>
    commitKarteSave(
      { update: (f) => updateBook(f, today), journal: writeJournal, dropDraft: () => (draft.has = false) },
      { karte: karte(n), surname: "青木", headings, dayLabel: "11/4（水）", menuName: "カット", editedNames: [] },
    );

  for (const why of ["full", "denied"] as const) {
    test(`カルテの保存：${why === "full" ? "置き場所がいっぱい" : "書き込みを断られた"}の時は、案を残し、成功の文と日誌を出さない。その後もう一度押すと保存でき、日誌は1回だけ`, () => {
      const draft = { has: true };
      bookFails = why;
      const r = saveKarte(1, draft);
      assert.equal(r.ok, false);
      assert.equal(r.message, SAVE_FAILED_MESSAGE);
      assert.ok(!r.message.includes("保存しました"));
      assert.equal(draft.has, true, "案は残す");
      assert.equal(readBook(today).kartes.length, 0);
      assert.equal(journal().length, 0, "日誌は書かない");

      bookFails = null;
      const again = saveKarte(2, draft);
      assert.equal(again.ok, true);
      assert.ok(again.message.startsWith("✓ 保存しました"));
      assert.equal(draft.has, false, "書けたら案を消す");
      assert.equal(readBook(today).kartes.length, 1);
      assert.equal(readBook(today).todos.filter((t) => t.kind === "next-talk").length, 1);
      assert.equal(journal().filter((e) => e.text.startsWith("人が保存：")).length, 1, "成功の日誌は1回だけ");
    });
  }

  test("カルテの保存：普通に書ける時は1回で保存・日誌1行・案を消す", () => {
    const draft = { has: true };
    const r = saveKarte(1, draft);
    assert.equal(r.ok, true);
    assert.equal(draft.has, false);
    assert.equal(journal().filter((e) => e.text.startsWith("人が保存：")).length, 1);
    // 同じ日の2回目は決まりで保存しない（書けなかった、とは言わない）
    const second = saveKarte(2, { has: true });
    assert.equal(second.ok, false);
    assert.ok(!second.ok && second.written === true && second.message !== SAVE_FAILED_MESSAGE);
  });

  const seedItems = resolveSeedTodos(shop, calDay(shop, today), getTodos());
  const throwMemo = () =>
    commitMemoTodo(
      { update: (f) => updateBook(f, today), journal: writeJournal },
      { title: "カラー剤の7番を発注", memo: "カラー剤の7番が少ない", due: null, category: "supply", via: "program", how: "script", seedItems, shop, nowIso: `${today}T01:00:00.000Z` },
    );

  for (const why of ["full", "denied"] as const) {
    test(`メモを投げる：${why === "full" ? "置き場所がいっぱい" : "書き込みを断られた"}の時は「足しました」と日誌を出さない。もう一度で足せて、日誌は1回だけ`, () => {
      bookFails = why;
      const r = throwMemo();
      assert.deepEqual(r, { ok: false, why: "write", message: SAVE_FAILED_MESSAGE });
      assert.equal(readBook(today).todos.length, 0);
      assert.equal(journal().length, 0);
      bookFails = null;
      const again = throwMemo();
      assert.equal(again.ok, true);
      assert.ok(again.message.startsWith("✓ 足しました"));
      assert.equal(readBook(today).todos.length, 1);
      assert.equal(journal().filter((e) => e.text.startsWith("メモを ToDo に足した")).length, 1);
    });
  }

  test("メモを投げる：普通に書ける時は1回で足し、日誌1行", () => {
    const r = throwMemo();
    assert.equal(r.ok, true);
    assert.equal(readBook(today).todos.length, 1);
    assert.equal(journal().filter((e) => e.text.startsWith("メモを ToDo に足した")).length, 1);
  });
});

// ── 予約チャットの返事（2・9） ─────────────────────────────
const hold = (id: string, over: Partial<HoldOffer> = {}): HoldOffer => ({
  id,
  customerId: "c01",
  menuId: "cut",
  date: "2026-11-07",
  start: "15:00",
  heldAt: `${today}T01:00:00.000Z`,
  expiresAt: `${today}T13:00:00.000Z`,
  reason: "空いていてルールに合う",
  ...over,
});
const enc = new TextEncoder();
const line = (e: ReserveEvent) => enc.encode(JSON.stringify(e) + "\n");
/** 手で流す返事（push で1行ずつ・end で閉じる） */
function manualStream() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
  return { body, push: (b: Uint8Array) => ctl.enqueue(b), end: () => ctl.close(), fail: () => ctl.error(new Error("network")) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
/** 画面（ReserveChat）と同じつなぎ方：始めた時の印・止めたか・仮押さえを入れる */
function chatRun(runs: ReturnType<typeof createChatRuns>) {
  const epoch = currentEpoch();
  const run = runs.start("c01", epoch);
  const live = () => runs.isCurrent(run.id) && sameEpoch({ epoch: currentEpoch() }, epoch);
  const held: string[] = [];
  const onEvent = (e: ReserveEvent) => {
    if (!live()) return;
    if (e.t === "hold" && holdInto((f) => updateBook(f, today), e.hold, epoch)) {
      held.push(e.hold.id);
      writeJournal({ who: "AI", text: `仮押さえした：${e.hold.id}` });
    }
  };
  return { epoch, live, onEvent, held };
}

describe("直しA 2：返事を待っている間に「最初に戻す」を押したら、戻す前の相談の仮押さえは入れない", () => {
  test("返事を止めたまま最初に戻し、後から返事を届けても、戻した後の台帳に仮押さえは入らない（日誌も書かない）", async () => {
    const runs = createChatRuns();
    const s = manualStream();
    const c = chatRun(runs);
    const reading = readReserveStream(s.body, c.onEvent, c.live);
    s.push(line({ t: "text", d: "お調べします" }));
    await tick();
    // 最初に戻す（ResetBook と同じ書き方）→ 画面は印が変わったのを見て止める
    for (const w of resetAllWrites(today)) writeBrowser(w.key, w.value);
    writeJournal({ who: "オーナー", text: "最初に戻した" });
    const newEpoch = currentEpoch();
    assert.ok(newEpoch && newEpoch !== c.epoch, "戻すと印が変わる");
    assert.equal(runs.stopIfReset(newEpoch), "c01", "流れていた返事を止める");
    // 後から届いた返事
    s.push(line({ t: "hold", hold: hold("h-late") }));
    s.push(line({ t: "done" }));
    s.end();
    assert.equal(await reading, "stopped");
    assert.equal(readBook(today).chat.length, 0);
    assert.equal(readBook(today).approvals.length, 0);
    assert.equal(journal()[0].text, "最初に戻した", "「最初に戻した」の後に「仮押さえした」が並ばない");
  });

  test("止められなかった（ほかの窓で戻した）時も、印が違うので仮押さえは入れない", () => {
    const epoch = currentEpoch();
    for (const w of resetAllWrites(today)) writeBrowser(w.key, w.value);
    assert.equal(holdInto((f) => updateBook(f, today), hold("h-other"), epoch), false);
    assert.equal(readBook(today).chat.length, 0);
    // 戻した後に始めた相談は入る
    assert.equal(holdInto((f) => updateBook(f, today), hold("h-new"), currentEpoch()), true);
    assert.equal(readBook(today).chat.length, 1);
  });

  test("印は読み込み直しても残り、戻すたびに変わる", () => {
    const a = resetAllWrites(today).find((w) => w.key === BOOK_KEY)!.value!;
    const b = resetAllWrites(today).find((w) => w.key === BOOK_KEY)!.value!;
    assert.ok(parseBook(a)?.epoch);
    assert.notEqual(parseBook(a)?.epoch, parseBook(b)?.epoch);
  });
});

describe("直しA 9：予約チャットの返事が途中で切れたら知らせる。送り直しても仮押さえを2つにしない", () => {
  test("終わりの印の無い返事は cut（「返事が途中で切れました。もう一度送ってください。」）", async () => {
    const runs = createChatRuns();
    const s = manualStream();
    const c = chatRun(runs);
    const reading = readReserveStream(s.body, c.onEvent, c.live);
    s.push(line({ t: "text", d: "空いている時間は" }));
    s.end();
    assert.equal(await reading, "cut");
    assert.equal(cutNotice(c.held), "返事が途中で切れました。もう一度送ってください。");
  });

  test("最後の行が途中で切れている・読んでいる途中で通信が切れた も cut。終わりの印まで来れば done", async () => {
    const half = manualStream();
    const r1 = readReserveStream(half.body, () => {}, () => true);
    half.push(enc.encode('{"t":"text","d":"お調'));
    half.end();
    assert.equal(await r1, "cut");

    const broken = manualStream();
    const r2 = readReserveStream(broken.body, () => {}, () => true);
    broken.push(line({ t: "text", d: "お調べします" }));
    await tick();
    broken.fail();
    assert.equal(await r2, "cut");

    const ok = manualStream();
    const r3 = readReserveStream(ok.body, () => {}, () => true);
    ok.push(line({ t: "text", d: "どうぞ" }));
    ok.push(enc.encode(JSON.stringify({ t: "done" })));
    ok.end();
    assert.equal(await r3, "done");
  });

  test("仮押さえを受け取った後に切れて送り直しても、仮押さえは1つのまま（承認の箱も1行）", async () => {
    const runs = createChatRuns();
    const first = manualStream();
    const c1 = chatRun(runs);
    const r1 = readReserveStream(first.body, c1.onEvent, c1.live);
    first.push(line({ t: "hold", hold: hold("h-1") }));
    first.end();
    assert.equal(await r1, "cut");
    runs.finish(1);
    assert.deepEqual(c1.held, ["h-1"]);
    assert.ok(cutNotice(["11/7（土）15:00 カット"]).includes("仮押さえは、もう承認の箱に入っています"));

    // 送り直し：AI がもう一度同じ枠を仮押さえしようとする（別の id）
    const second = manualStream();
    const c2 = chatRun(runs);
    const r2 = readReserveStream(second.body, c2.onEvent, c2.live);
    second.push(line({ t: "hold", hold: hold("h-2", { heldAt: `${today}T01:05:00.000Z` }) }));
    second.push(line({ t: "done" }));
    second.end();
    assert.equal(await r2, "done");
    assert.deepEqual(c2.held, [], "同じ枠の承認待ちがもうあるので入れない");
    const b = readBook(today);
    assert.equal(b.chat.length, 1);
    assert.equal(b.approvals.filter((a) => a.state === "pending").length, 1);
    assert.equal(journal().filter((e) => e.text.startsWith("仮押さえした")).length, 1);
  });

  test("ほかの日時・ほかのメニューの仮押さえは、同じお客様でも入る", () => {
    const put = (h: HoldOffer) => holdInto((f) => updateBook(f, today), h, currentEpoch());
    assert.equal(put(hold("h-a")), true);
    assert.equal(put(hold("h-b", { start: "16:00" })), true);
    assert.equal(put(hold("h-c", { menuId: "color" })), true);
    assert.equal(put(hold("h-d")), false);
    assert.equal(readBook(today).chat.length, 3);
  });
});

describe("直しA 3：録音から作ったメモ（6,000字まで）は、保存して読み込み直しても切れない", () => {
  const karteOf = (memo: string): SavedKarte => ({
    id: `k-${today}-c02-1`,
    customerId: "c02",
    date: today,
    menuId: "cut",
    memo,
    sections: { treatment: ["カット"] },
    savedAt: `${today}T08:00:00.000Z`,
  });
  test("保存と読み込みの上限は、入力できる上限（録音の要点）にそろう", () => {
    assert.equal(getSavedMemoMaxChars(), Math.max(getAiSettings().karte.maxMemoChars, getAiSettings().karte.maxRecordingMemoChars));
    assert.equal(getSavedMemoMaxChars(), 6000);
  });
  for (const n of [4000, 4001, 6000])
    test(`${n.toLocaleString("ja-JP")}字のメモは、保存して読み込み直しても${n.toLocaleString("ja-JP")}字のまま`, () => {
      const memo = "あ".repeat(n - 1) + "🙂";
      const r = commitKarteSave(
        { update: (f) => updateBook(f, today), journal: writeJournal, dropDraft: () => {} },
        { karte: karteOf(memo), surname: "石田", headings, dayLabel: "11/4（水）", menuName: "カット", editedNames: [] },
      );
      assert.equal(r.ok, true);
      const back = readBook(today).kartes[0];
      assert.equal([...back.memo].length, n);
      assert.equal(back.memo, memo);
    });
  test("入力できる上限より長い物（ブラウザの中で書きかえられた物）は、上限で切る", () => {
    const s = { ...emptyBook(today), kartes: [karteOf("い".repeat(6001))] };
    assert.equal([...parseBook(JSON.stringify(s))!.kartes[0].memo].length, 6000);
  });
});

describe("直しA 5：「翌日へ」の上限（60営業日）に来たら押せなくし、日誌とお知らせを作らない", () => {
  test("59 → 60 は進む。60 からは進まない（moved: false）", () => {
    const s59 = { ...emptyBook(today), dayOffset: MAX_DAY_OFFSET - 1 };
    assert.equal(canNextDay(s59), true);
    const a = nextDayStep(s59);
    assert.equal(a.moved, true);
    assert.equal(a.state.dayOffset, MAX_DAY_OFFSET);
    assert.equal(canNextDay(a.state), false);
    const b = nextDayStep(a.state);
    assert.equal(b.moved, false);
    assert.equal(b.state, a.state, "台帳は変えない");
    assert.equal(LAST_DEMO_DAY, "デモで進められるのはここまでです");
  });

  test("上限では画面の日付も進まない（demoClock も 60 で止まる）", () => {
    const now = new Date("2026-11-04T09:00:00+09:00");
    assert.equal(demoClock(shop, now, MAX_DAY_OFFSET).today.date, demoClock(shop, now, MAX_DAY_OFFSET + 1).today.date);
  });

  test("ホームの「翌日へ」は、上限で押せなくし、進まなかった時は日誌・お知らせの前に戻る", () => {
    const src = readFileSync("src/app/home/HomeSummary.tsx", "utf8");
    assert.match(src, /disabled=\{!canNext\}/);
    assert.match(src, /LAST_DEMO_DAY/);
    const handler = src.slice(src.indexOf("const nextDay = "), src.indexOf("return (", src.indexOf("const nextDay = ")));
    const stop = handler.indexOf("if (!moved) return;");
    assert.ok(stop > 0, "進まなかったらやめる");
    assert.ok(stop < handler.indexOf("dayBeforeReminders(") && stop < handler.indexOf("writeJournal("), "お知らせと日誌はその後");
  });
});

describe("直しA 6：定休日に開いた時、「本当の今日は」に次の営業日を出さない", () => {
  test("定休日（火曜）に開いて「翌日へ」で進めた時：本当の日付と、次の営業日を分けて書く", () => {
    const tue = new Date("2026-11-10T10:00:00+09:00");
    const c = demoClock(shop, tue, 2);
    assert.equal(c.opened.date, "2026-11-10");
    assert.equal(c.realToday.date, "2026-11-11", "次の営業日を今日にする仕組みは変えない");
    const note = realDayNote(c);
    assert.ok(note.startsWith(`本当の今日は ${calDay(shop, "2026-11-10").label}（お休み）`), note);
    assert.ok(note.includes(`次の営業日は ${calDay(shop, "2026-11-11").label}`), note);
  });
  test("営業日に開いた時は、本当の今日だけ", () => {
    const c = demoClock(shop, new Date("2026-11-04T10:00:00+09:00"), 3);
    assert.equal(realDayNote(c), `本当の今日は ${calDay(shop, "2026-11-04").label} です`);
  });
  test("ホームは realDayNote を使い、realToday を「本当の今日」として出さない", () => {
    const src = readFileSync("src/app/home/HomeSummary.tsx", "utf8");
    assert.match(src, /realDayNote\(book\)/);
    assert.doesNotMatch(src, /本当の今日は \{book\.realToday/);
  });
});

describe("直しA 7：決まった返事（AI なし）は「19時30分」を 19:30 と読む", () => {
  const menus = getMenus();
  const day = calDay(shop, today);
  for (const [text, start] of [
    ["11/7の19時30分にカットを", "19:30"],
    ["11/7の19時半にカットを", "19:30"],
    ["11/7の19:30にカットを", "19:30"],
    ["11/7の１９：３０にカットを", "19:30"],
    ["11/7の19時にカットを", "19:00"],
    ["11/7の19時15分にカットを", "19:15"],
    ["11/7の9時5分にカットを", "09:05"],
  ] as const)
    test(`「${text}」→ ${start}`, () => {
      assert.equal(readRequest({ menus, today: day }, text).start, start);
    });

  test("予約チャットの決まった返事：「18時30分」は 18:30 の枠で仮押さえする（18:00 ではない）", async () => {
    const ctx = ctxAt(at(today, "09:00"));
    const date = businessDayAt(shop, ctx.today, 3)!;
    const r = await chat(ctx, [{ role: "user", text: `${date.label}の18時30分にカットをお願いします` }]);
    const starts = [...r.holds.map((h) => h.start), ...(r.candidates ?? []).map((c) => c.start)];
    assert.ok(starts.length > 0, r.text);
    assert.equal(starts[0], "18:30", r.text);
  });

  test("LINE の一言の決まった返事も同じ読み方（19時30分 → 19:30）", async () => {
    const pick = await scriptSortModel({ menus, today: day }).pick({ system: "", text: "11/7の19時30分にカットで仮押さえ", maxTokens: 100 });
    assert.equal((pick?.input as { start?: string }).start, "19:30");
  });
});

describe("直しA 8：広告の「7日に1つ」は「翌日へ」で進めた日付の時計で数える（画面・送る前・保存する時・AI の仕事）", () => {
  const settings = getAdSettings();
  const table = buildTable(getAds(), settings, []);
  const now = new Date("2026-11-04T15:00:00+09:00");
  const clockAt = (offset: number) => demoInstant(shop, now, offset).toISOString();
  const add = async (s: AdsState, nowIso: string, id: string) => {
    const r = await runReview({ table, rules: [], settings, model: scriptAdsModel(table), maxTokens: 600, maxTries: 2 });
    assert.ok(r.ok);
    if (!r.ok) return s;
    return withProposal(s, r.proposal, table, { id, checks: r.checks, nowIso, mode: "script" }, settings);
  };
  /** 案を閉じる（見送り。見送りも1つと数える） */
  const skipAll = (s: AdsState): AdsState => ({ ...s, proposals: s.proposals.map((p) => ({ ...p, state: "skipped" as const })) });

  test("「翌日へ」で進めた日数だけ時計が進む（0 なら本当の時刻）", () => {
    assert.equal(clockAt(0), now.toISOString());
    const c = demoClock(shop, now, 3);
    assert.equal(clockAt(3).slice(11), now.toISOString().slice(11), "時刻はそのまま");
    assert.equal(Math.round((Date.parse(clockAt(3)) - now.getTime()) / 86_400_000), calDiff(c.realToday.date, c.today.date));
  });

  test("案を作ってから7日に満たない間は頼めず、保存もしない。7日を過ぎたら頼めて、実際に案が増える", async () => {
    let s = skipAll(await add(EMPTY_ADS, clockAt(0), "ad-1"));
    assert.equal(s.proposals.length, 1);
    let opened = -1;
    for (let k = 1; k <= 10; k++) {
      const iso = clockAt(k);
      const days = (Date.parse(iso) - now.getTime()) / 86_400_000;
      const can = canPropose(s, iso, settings);
      if (days < settings.oncePerDays) {
        assert.equal(can.ok, false, `${k}営業日（${days}日）はまだ`);
        // 画面が押せないのに保存の判定だけ通る、のような食い違いが無い（保存しても増えない）
        assert.equal((await add(s, iso, `ad-x${k}`)).proposals.length, 1);
        // 次に頼める日時も同じ時計
        assert.ok(!can.ok && can.nextAt && Date.parse(can.nextAt) > Date.parse(iso));
      } else {
        assert.equal(can.ok, true, `${k}営業日（${days}日）は頼める`);
        s = await add(s, iso, "ad-2");
        assert.equal(s.proposals.length, 2, "実際に案が増える");
        opened = k;
        break;
      }
    }
    assert.ok(opened > 0, "どこかで頼めるようになる");
  });

  test("AI の仕事から広告を見直す時も同じ時計（7日に満たない間は動かさず、過ぎたら承認の箱に入る）", async () => {
    const data = getBookData();
    const first = skipAll(await add(EMPTY_ADS, clockAt(0), "ad-1"));
    const w = { book: { ...emptyBook(shopToday(shop, now).today.date), dayOffset: 2 }, ads: first, jobs: EMPTY_JOBS };
    const env: JobEnv = {
      data,
      rules: getRules(),
      mode: "script",
      store: {
        book: () => w.book,
        setBook: (f) => void (w.book = f(w.book)),
        ads: () => w.ads,
        setAds: (f) => void (w.ads = f(w.ads)),
        accounting: () => EMPTY_ACCOUNTING,
        jobs: () => w.jobs,
        setJobs: (f) => void (w.jobs = f(w.jobs)),
      },
      ask: {
        reserve: async () => [],
        todo: async () => ({ ok: false, code: "no-ai", message: "" }),
        ads: async () => {
          const r = await runReview({ table, rules: [], settings, model: scriptAdsModel(table), maxTokens: 600, maxTries: 2 });
          return r.ok ? r : { ...r, code: "gate" };
        },
      },
      journal: () => {},
      now: () => now,
      adSettings: settings,
      newId: () => `ad-job-${w.ads.proposals.length + 1}`,
    };
    const early = await runJob("ads", env, { left: 10 });
    assert.equal(early.kind, "skip");
    assert.equal(w.ads.proposals.length, 1);
    w.book = { ...w.book, dayOffset: 8 };
    const later = await runJob("ads", env, { left: 10 });
    assert.equal(later.kind, "done");
    assert.equal(w.ads.proposals.length, 2);
    assert.equal(w.ads.proposals[1].createdAt, demoInstant(shop, now, 8).toISOString(), "作った時刻も同じ時計");
  });

  test("広告タブ・AI の仕事は、本当の時計（new Date()）で「7日に1つ」を数えない", () => {
    const review = readFileSync("src/app/ads/AdsReview.tsx", "utf8");
    assert.doesNotMatch(review, /canPropose\(ads\.state, new Date\(\)/);
    assert.match(review, /demoInstant\(/);
    assert.doesNotMatch(readFileSync("src/app/home/AiJobs.tsx", "utf8"), /adsBlocked\(ads\.state, book\.nowIso/);
    assert.match(readFileSync("src/lib/jobs/run.ts", "utf8"), /const nowIso = demoInstant\(env\.data\.shop, env\.now\(\), env\.store\.book\(\)\.dayOffset\)/);
  });
});
