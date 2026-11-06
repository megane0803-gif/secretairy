// ホームとカルテの直しのテスト。Claude・LINE は呼ばない（決まった返事・置きかえた LINE）。
// 1. 「翌日へ」の前日のお知らせ（決まった形・AI なし・送らない）
// 4. 日誌は新しい5行・行の頭にだれがしたかの札（AI・人・外は色つき。プログラムは灰色。色の作りは actors.ts・actors.test.ts）
// 5. 「本名や連絡先は入れない」の1行（予約チャット・LINE の友だち追加）

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import reminderJson from "../../../config/reminder.json";
import { at, menus, shop } from "../ai/__tests__/helpers";
import { businessDayAt, shopToday } from "../calendar";
import { journalActor } from "../actors";
import { JOURNAL_SHOW, withEntries } from "../journal";
import { handleWebhook, type BridgeDeps } from "../line/bridge";
import type { LineMessage } from "../line/api";
import { LINE_TEXT } from "../line/messages";
import { memoryStore } from "../line/store";
import { NO_REAL_NAMES_NOTE } from "../notices";
import { dayBeforeReminders, reminderText } from "../reminder";
import { loadBook, type Reservation } from "../reservations";
import { getLineSettings, getReminderSettings } from "../settings";

const ROOT = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
describe("1. 「翌日へ」の前日のお知らせ（デモ）", () => {
  const now = at("2026-11-04", "09:00");
  const { today } = shopToday(shop, now);
  const next = businessDayAt(shop, today, 1)!;
  const book = loadBook(shop, menus, today);
  const r = getReminderSettings();

  test("決まった形は config に置き、日時とメニューと店の名前はプログラムが入れる", () => {
    assert.equal(r.template, reminderJson.template);
    assert.match(r.template, /\{time\}/);
    assert.match(r.template, /\{menu\}/);
    assert.equal(r.demoNote, "デモ：実際には送信されません");
    assert.equal(reminderText("明日 {time} {menu}のご予約をお待ちしています", { time: "13:00", menu: "カット＋カラー", shop: "omochi" }), "明日 13:00 カット＋カラーのご予約をお待ちしています");
    // 知らない {…} は空にする（AI が文を足す所は無い）
    assert.equal(reminderText("{x}明日 {time}", { time: "10:00", menu: "", shop: "" }), "明日 10:00");
  });

  test("その日の確定の予約の方に1通ずつ、時刻の順（文はメニューと時刻から）", () => {
    const list = dayBeforeReminders(book.all, next.date, r.template, shop.name);
    const want = book.all.filter((x) => x.date === next.date && x.status === "confirmed");
    assert.ok(want.length > 0, "最初の状態で、次の営業日に予約がある");
    assert.equal(list.length, want.length);
    assert.deepEqual(list.map((m) => m.start), [...list.map((m) => m.start)].sort());
    for (const m of list) {
      const res = want.find((x) => x.id === m.reservationId)!;
      assert.ok(m.text.startsWith(`明日 ${res.start} ${res.menu.name}のご予約をお待ちしています`), m.text);
      assert.ok(m.text.includes(shop.name));
      assert.ok(!m.text.includes(res.customer.surname), "文に名前は入れない（画面は名前を札の外に出す）");
    }
  });

  test("仮押さえの方・ほかの日の方には出さない", () => {
    const one = book.all.find((x) => x.date === next.date)!;
    const hold: Reservation = { ...one, id: "hold-1", status: "hold" };
    const list = dayBeforeReminders([...book.all, hold], next.date, r.template, shop.name);
    assert.ok(!list.some((m) => m.reservationId === "hold-1"));
    assert.ok(list.every((m) => m.date === next.date));
  });

  test("本当には送らない：お知らせの部品は LINE・fetch・AI を使わない", () => {
    for (const f of ["src/lib/reminder.ts", "src/app/home/DayBeforeReminders.tsx"]) {
      const text = read(f);
      assert.doesNotMatch(text, /fetch\(|\/api\/|line\/|anthropic/i, f);
    }
    assert.match(read("src/app/home/DayBeforeReminders.tsx"), /demoNote/);
  });
});

describe("4. 日誌：新しい5行・だれがしたかの札", () => {
  test("畳まずに出すのは新しい5行（残りは畳む）", () => {
    assert.equal(JOURNAL_SHOW, 5);
    const list = withEntries([], Array.from({ length: 8 }, (_, i) => ({ who: "AI" as const, text: `行${i + 1}` })));
    assert.deepEqual(list.slice(0, JOURNAL_SHOW).map((e) => e.text), ["行8", "行7", "行6", "行5", "行4"]);
    assert.match(read("src/components/JournalList.tsx"), /slice\(0, JOURNAL_SHOW\)[\s\S]*Fold[\s\S]*slice\(JOURNAL_SHOW\)/);
  });

  test("行の頭に、だれがしたかの札：AI = AI・オーナー = 人・LINE = 外（色の3つ）・プログラム = 灰色の「プログラム」", () => {
    assert.equal(journalActor("AI"), "ai");
    assert.equal(journalActor("オーナー"), "human");
    assert.equal(journalActor("LINE"), "outside");
    assert.equal(journalActor("プログラム"), null);
    const ui = read("src/components/JournalList.tsx");
    // 札（JournalWhoTag）が時刻より前＝行の頭
    const row = ui.slice(ui.indexOf("<li key={e.id}>"));
    assert.ok(row.indexOf("<JournalWhoTag") < row.indexOf("<time"), "札は行の頭");
    // 色だけに頼らず文字を出す（ActorTag は ACTOR_LABEL の文字を必ず出す）
    assert.match(read("src/components/parts.tsx"), /\{ACTOR_LABEL\[actor\]\}/);
  });
});

describe("5. 「本名や連絡先は入れない」の1行", () => {
  test("予約チャットの入力欄の近くに出す", () => {
    assert.equal(NO_REAL_NAMES_NOTE, "架空の店のデモです。本名や連絡先は入れないでください");
    const chat = read("src/app/reservations/ReserveChat.tsx");
    const form = chat.indexOf('className="chat-input"');
    const note = chat.indexOf("{NO_REAL_NAMES_NOTE}");
    assert.ok(form > 0 && note > form, "入力欄のすぐ後に出す");
  });

  test("LINE で友だち追加された時の返事にも入れる（つながっていない人には合言葉のお願いも）", async () => {
    const sent: { to: string; messages: LineMessage[] }[] = [];
    const d: BridgeDeps = {
      store: memoryStore(() => Date.parse("2026-11-04T09:00:00+09:00")),
      line: {
        reply: async (to, messages) => {
          sent.push({ to, messages });
          return { ok: true, status: 200 };
        },
        push: async () => ({ ok: true, status: 200 }),
      },
      settings: getLineSettings(),
      timezone: shop.timezone,
      now: () => new Date("2026-11-04T00:00:00Z"),
      random: (n) => Buffer.alloc(n, 7),
    };
    await handleWebhook(d, { destination: "x", events: [{ type: "follow", replyToken: "rt-f", webhookEventId: "we-f", source: { type: "user", userId: "U-new" } }] });
    assert.equal(sent.length, 1);
    const text = String((sent[0].messages[0] as { text?: string }).text);
    assert.ok(text.includes(NO_REAL_NAMES_NOTE), text);
    assert.ok(text.includes(LINE_TEXT.askCode), text);
  });

  test("README に、LINE の管理画面のあいさつ文のことを書く", () => {
    assert.match(read("README.md"), /あいさつ/);
    assert.match(read("README.md"), /本名や連絡先は入れないでください/);
  });
});
