// 朝の要点の「AI の一言」のテスト。Claude は呼ばず、決まった返事（scriptBriefWriter）と置きかえた書く物を使う。
// 材料に名前を入れない・印を日時とお名前に置きかえる・門（数字・日時・知らない印・体や判断の言葉）・上限は config。

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import aiJson from "../../../../config/ai.json";
import { at, customers, menus, shop } from "../../ai/__tests__/helpers";
import { approvalQueue } from "../../approvals";
import { EMPTY_ADS } from "../../ads/state";
import { emptyBook, withHold } from "../../book/state";
import { calDay, shopToday } from "../../calendar";
import { getSeedKartes, getTodos } from "../../data/seed";
import { allKartes, resolveSeedKartes } from "../../karte/record";
import { resolveMenu } from "../../combo";
import { loadBook } from "../../reservations";
import { LOCKED_INSTRUCTIONS } from "../../rules/prompt";
import { getRules } from "../../rules/store";
import { getBriefAiSettings, getBriefLimits, getKarteHeadings } from "../../settings";
import { resolveSeedTodos, todoItems } from "../../todo/items";
import { gateBrief, gateBriefLine } from "../gate";
import { briefKey, briefMaterial, fillMarks } from "../items";
import { briefShown, shownBriefNotes } from "../pace";
import { briefSystem } from "../prompt";
import { BriefRefusedError, runBrief } from "../run";
import { parseBriefRequest, type BriefItem } from "../wire";
import { scriptBriefWriter, type BriefWriter } from "../writer";

const ROOT = join(__dirname, "../../../..");
const limits = getBriefLimits();
const headings = getKarteHeadings();
const now = at("2026-11-04", "09:00");
const { today } = shopToday(shop, now);
const book = loadBook(shop, menus, today);
const nowIso = now.toISOString();

function material() {
  const kartes = allKartes(resolveSeedKartes(getSeedKartes(), book.all), []);
  const firstToday = book.all.find((r) => r.date === today.date)!;
  // 承認待ちの仮押さえを1つ入れる
  const state = withHold(emptyBook(today.date), {
    id: "h-1",
    customerId: "c09",
    menuId: "cut",
    date: today.date,
    start: "19:00",
    heldAt: nowIso,
    expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
    reason: "予約チャットで仮押さえ",
  });
  const todos = todoItems(resolveSeedTodos(shop, today, getTodos()), state, shop);
  return {
    firstToday,
    m: briefMaterial({
      today: today.date,
      todays: book.all.filter((r) => r.date === today.date),
      kartes,
      headings,
      approvals: approvalQueue(state, EMPTY_ADS, nowIso),
      todos,
      customers,
      menuName: (id) => resolveMenu(menus, id)?.name ?? id,
      dayLabel: (d) => calDay(shop, d).label,
      maxItems: limits.maxItems,
      maxItemChars: limits.maxItemChars,
    }),
  };
}

const run = (items: BriefItem[], writer: BriefWriter = scriptBriefWriter()) =>
  runBrief({ items, mode: "script", writer, rules: getRules(), maxTokens: limits.maxReplyTokens, maxNotes: limits.maxNotes, maxNoteChars: limits.maxNoteChars });
const fixed = (text: string, stop: "end" | "max_tokens" | "refusal" = "end"): BriefWriter => ({ write: async () => ({ text, stop }) });

describe("上限は config・窓口は /api/ai/ の下", () => {
  test("config/ai.json の brief（Haiku・3つまで）", () => {
    const b = (aiJson as { brief: Record<string, unknown> }).brief;
    for (const k of ["maxReplyTokens", "maxNotes", "maxNoteChars", "maxItems", "maxItemChars", "maxRequestChars"]) assert.ok(typeof b[k] === "number" && (b[k] as number) > 0, k);
    assert.equal(b.maxNotes, 3);
    assert.match(String(b.model), /haiku/);
    assert.equal(getBriefAiSettings().maxNotes, limits.maxNotes);
    assert.ok(existsSync(join(ROOT, "src/app/api/ai/brief/route.ts")));
    assert.doesNotMatch(readFileSync(join(ROOT, "src/app/api/ai/brief/route.ts"), "utf8"), /maxNotes:\s*\d|\d+_000\b/);
  });

  test("🔒 指示の先頭は鍵つき（健康の判断はしない）。数字・日時は書かせない", () => {
    const sys = briefSystem(getRules(), limits.maxNotes, limits.maxNoteChars);
    assert.ok(sys.indexOf(LOCKED_INSTRUCTIONS[1]) >= 0 && sys.indexOf(LOCKED_INSTRUCTIONS[1]) < sys.indexOf("あなたの役目"));
    assert.match(sys, /数字・時刻・日付・曜日/);
  });
});

describe("材料（名前は送らない）と印の置きかえ", () => {
  test("今日の予約・承認待ち・ToDo に印を付け、名前は〔お客様〕に。札には時刻とお名前（架空）", () => {
    const { firstToday, m } = material();
    assert.ok(m.items.some((i) => i.kind === "reservation"));
    assert.ok(m.items.some((i) => i.kind === "approval"));
    assert.ok(m.items.some((i) => i.kind === "todo"));
    for (const i of m.items) for (const c of customers) assert.ok(!i.text.includes(c.surname), `${i.mark} に ${c.surname}`);
    assert.ok(m.labels["【予約1】"].includes(firstToday.start));
    assert.ok(m.labels["【予約1】"].includes(`${firstToday.customer.surname}様`));
    assert.ok(m.labels["【承認1】"].includes("小林様"));
    assert.ok(m.items.length <= limits.maxItems);
  });

  test("fillMarks：印を札に。知らない印のある行は使わない", () => {
    const labels = { "【予約1】": "10:00 青木様 カット" };
    assert.equal(fillMarks("【予約1】は前回の注意点を見る", labels), "10:00 青木様 カットは前回の注意点を見る");
    assert.equal(fillMarks("【予約9】を見る", labels), null);
  });

  test("同じ材料なら同じ鍵（同じ材料で AI を何回も呼ばない）", () => {
    assert.equal(briefKey(material().m.items), briefKey(material().m.items));
    // オーナーのルールを変えたら、鍵も変わる（前の答えを使わずに呼びなおす）
    const rule = { id: "r-x", level: "tab", tab: "home", label: "朝は短く", check: { kind: "text" } };
    assert.notEqual(briefKey(material().m.items, []), briefKey(material().m.items, [rule]));
    assert.equal(briefKey(material().m.items, [rule]), briefKey(material().m.items, [{ ...rule }]));
  });

  test("窓口の形：印の形・種類・数を確かめる", () => {
    const ok = parseBriefRequest({ items: [{ mark: "【予約1】", kind: "reservation", text: "メニュー：カット" }], rules: [] }, limits, menus.map((m) => m.id));
    assert.ok(ok.ok);
    const bad = parseBriefRequest({ items: [{ mark: "【予約1】", kind: "todo", text: "x" }] }, limits, []);
    assert.ok(!bad.ok);
    const many = parseBriefRequest({ items: Array.from({ length: limits.maxItems + 1 }, (_, n) => ({ mark: `【ToDo${n}】`, kind: "todo", text: "x" })) }, limits, []);
    assert.ok(!many.ok);
  });
});

describe("門（プログラム）", () => {
  const items: BriefItem[] = [
    { mark: "【予約1】", kind: "reservation", text: "メニュー：カラー。前回の注意点：頭皮が赤かった" },
    { mark: "【ToDo1】", kind: "todo", text: "シャンプーを発注" },
  ];
  test("数字・時刻・曜日を書いた行は外す（日時と数字はプログラム）", () => {
    assert.ok(gateBriefLine("【予約1】は13時です", items, limits.maxNoteChars));
    assert.ok(gateBriefLine("【予約1】は十時から", items, limits.maxNoteChars));
    assert.ok(gateBriefLine("木曜の【ToDo1】", items, limits.maxNoteChars));
    assert.equal(gateBriefLine("【ToDo1】を忘れずに", items, limits.maxNoteChars), null);
  });

  test("🔒 体・薬・判断の言葉は材料に無ければ外す。材料にある言葉はそのまま書いてよい", () => {
    assert.ok(gateBriefLine("【予約1】は大丈夫です", items, limits.maxNoteChars));
    assert.ok(gateBriefLine("【ToDo1】のあと受診をおすすめ", items, limits.maxNoteChars));
    assert.equal(gateBriefLine("【予約1】は前回、頭皮が赤かったと記録あり", items, limits.maxNoteChars), null);
  });

  test("知らない印・長すぎる行は外す。通った行は3つまで", () => {
    assert.ok(gateBriefLine("【予約2】を見る", items, limits.maxNoteChars));
    assert.ok(gateBriefLine("【空き枠】を見る", items, limits.maxNoteChars));
    assert.ok(gateBriefLine(`【ToDo1】${"あ".repeat(limits.maxNoteChars)}`, items, limits.maxNoteChars));
    const g = gateBrief("・一つ目\n・【ToDo1】を見る\n・【予約1】を見る\n・ほか\n・もう一つ", items, limits.maxNotes, limits.maxNoteChars);
    assert.equal(g.notes.length, limits.maxNotes);
  });
});

describe("流れ（決まった返事・置きかえた書く物）", () => {
  test("決まった返事：初めての方・承認待ち の行が門を通って出る", async () => {
    const { m } = material();
    const out = await run(m.items);
    assert.ok(out.notes.length > 0 && out.notes.length <= limits.maxNotes);
    for (const n of out.notes) assert.equal(gateBriefLine(n, m.items, limits.maxNoteChars), null);
    assert.ok(out.notes.every((n) => fillMarks(n, m.labels) !== null));
  });

  test("書きすぎた行（数字・判断）は外して日誌の材料に（dropped）", async () => {
    const out = await run([{ mark: "【予約1】", kind: "reservation", text: "メニュー：カット" }], fixed("・【予約1】は15時から\n・【予約1】は大丈夫\n・【予約1】のご希望を聞く"));
    assert.deepEqual(out.notes, ["【予約1】のご希望を聞く"]);
    assert.equal(out.dropped.length, 2);
  });

  test("長さの上限で切れたら最後の1行は使わない。断られたら止める（画面は欄ごと出さない）", async () => {
    const items: BriefItem[] = [{ mark: "【予約1】", kind: "reservation", text: "メニュー：カット" }];
    const cut = await run(items, fixed("・【予約1】のご希望を聞く\n・【予約1】の前回", "max_tokens"));
    assert.deepEqual(cut.notes, ["【予約1】のご希望を聞く"]);
    await assert.rejects(run(items, fixed("", "refusal")), BriefRefusedError);
  });

  test("AI が使えない時は欄ごと出さない（画面の部品は答えが無ければ何も描かない）", () => {
    const ui = readFileSync(join(ROOT, "src/app/home/BriefNotes.tsx"), "utf8");
    assert.match(ui, /if \(!key \|\| lines\.length === 0\) return null;/);
    assert.match(ui, /\/api\/ai\/brief/);
    // 答え無し（つながらない・混んでいた）は、前に出した一言があっても出さない（直しY。brief/pace.ts）
    const last = { today: "2026-11-05", lines: ["10:00 青木様 カットのご希望を聞く"] };
    const m = { items: [{ mark: "【予約1】", kind: "reservation" as const, text: "メニュー：カット" }], labels: { "【予約1】": "10:00 青木様 カット" } };
    assert.deepEqual(briefShown({ today: "2026-11-05", resolved: true, lines: shownBriefNotes(null, m, limits) }, last), []);
  });
});
