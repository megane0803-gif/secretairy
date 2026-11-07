// 「（架空）」の札を外した（docs/SPEC.md §3.3）。Claude は呼ばない。
// 1. src の画面に出す文（テストとコメントを除く）・config・seed に「（架空）」が残っていない（LINE のファイルも含む）
// 2. 作る文・受け取る所・拾う所は「○○様」の1つの書き方で照らす
// 3. ブラウザに残った前の書き方（「○○（架空）様」）の ToDo・日誌・AI の仕事の済みの印も、同じように動く（保存は消さない）

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CardStatement } from "../../app/accounting/CardStatement";
import { RegisterColumn } from "../../app/accounting/RegisterColumn";
import { TodoTitle } from "../../components/TodoRows";
import { parseAds } from "../ads/state";
import { emptyBook, parseBook, withChatTodo, withReleased } from "../book/state";
import { guestTitleHead, isGuestTitle, withoutOldMark } from "../guestName";
import { parseJobs } from "../jobs/state";
import { parseJournal } from "../journal";
import { NO_REAL_NAMES_NOTE } from "../notices";
import { getAccountingSettings } from "../settings";
import { rescheduleTitle } from "../todo/reschedule";

const OLD = "（架空）";

/** 画面に出ない所（コメント）を外す。文字列の中の「//」（URL）は残す */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[\s;,{}()])\/\/.*$/, "$1"))
    .join("\n");
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "__tests__" ? [] : walk(p);
    return /\.(ts|tsx|css)$/.test(f) ? [p] : [];
  });
}

describe("1. 画面に出す文に「（架空）」が残っていない", () => {
  // 前の書き方を読みかえる所（src/lib/guestName.ts）だけは、読みかえる相手として「（架空）」を持つ
  const files = walk("src").filter((f) => f !== join("src", "lib", "guestName.ts"));

  test("src（テストとコメントを除く。LINE のファイルも含む）に「（架空）」「架空」の札が無い", () => {
    assert.ok(files.includes(join("src", "lib", "line", "messages.ts")), "LINE の文のファイルも見る");
    assert.ok(files.includes(join("src", "components", "LineBridge.tsx")));
    assert.ok(files.includes(join("src", "app", "home", "LinePanel.tsx")));
    for (const f of files) {
      const code = withoutComments(readFileSync(f, "utf8"));
      assert.ok(!code.includes(OLD), `${f} に「${OLD}」`);
      assert.doesNotMatch(code, /tag fictional/, `${f} に「架空」の札`);
      assert.doesNotMatch(code, /みな架空/, f);
    }
  });

  test("config・seed にも「（架空）」が無い", () => {
    for (const dir of ["config", "seed"])
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) assert.ok(!readFileSync(join(dir, f), "utf8").includes(OLD), `${dir}/${f}`);
  });

  test("画面（src/app・src/components）の説明の文にも「架空」が無い（試験のページ /eval の説明と、注意の1行 NO_REAL_NAMES_NOTE だけは残す）", () => {
    const screens = [...walk(join("src", "app")), ...walk("src/components")].filter((f) => !f.startsWith(join("src", "app", "eval")));
    for (const f of screens) assert.ok(!withoutComments(readFileSync(f, "utf8")).includes("架空"), `${f} に「架空」`);
  });

  test("設定ファイルから画面に出す文（経理の明細の説明・入金の1行・freee の札と文）にも「架空」が無い", () => {
    const strings: string[] = [];
    const collect = (x: unknown) => {
      if (typeof x === "string") strings.push(x);
      else if (Array.isArray(x)) x.forEach(collect);
      else if (x && typeof x === "object") Object.values(x).forEach(collect);
    };
    collect(JSON.parse(readFileSync(join("config", "accounting.json"), "utf8")));
    const s = getAccountingSettings();
    for (const t of [s.statementNote, s.incomeNote, s.freee.statementNote, s.freee.incomeNote, s.freee.label, s.freee.unconnectedNote]) assert.ok(strings.includes(t));
    for (const t of strings) assert.ok(!t.includes("架空"), `config/accounting.json の「${t}」に「架空」`);
  });

  test("経理の画面（設定ファイルから出す文も入れて描いた物）に「架空」が無い", () => {
    const html = renderToStaticMarkup(createElement(CardStatement)) + renderToStaticMarkup(createElement(RegisterColumn));
    assert.ok(html.includes(getAccountingSettings().statementNote), "設定の説明の文を描いている");
    assert.ok(!html.includes("架空"), "経理の画面に「架空」");
  });

  test("入力欄の近くの注意の1行は残す", () => {
    assert.equal(NO_REAL_NAMES_NOTE, "架空の店のデモです。本名や連絡先は入れないでください");
  });
});

describe("2. 作る文・受け取る所・拾う所は「○○様」の1つの書き方", () => {
  test("作る文", () => {
    assert.equal(guestTitleHead("青木"), "青木様：");
    assert.equal(rescheduleTitle("江口"), "江口様に別の日時を案内");
  });

  test("拾う所（カルテのお客様一覧の「次回話すこと」）は今の書き方も前の書き方も同じに読む", () => {
    assert.ok(isGuestTitle("青木様：前髪", "青木"));
    assert.ok(isGuestTitle("青木（架空）様：前髪", "青木"));
    assert.ok(!isGuestTitle("青木様：", "青木"), "用件が空");
    assert.ok(!isGuestTitle("江口様：前髪", "青木"), "ほかの方");
    assert.ok(!isGuestTitle("青木さま：前髪", "青木"));
  });

  test("受け取る所（予約チャットの ToDo）：今の書き方を受け取る。前の書き方でも受け取り、今の書き方で残す", () => {
    const now = "2026-11-04T01:00:00.000Z";
    const a = withChatTodo(emptyBook("2026-11-04"), { id: "td-chat-1", title: "江口様：傘を忘れました" }, "江口", now);
    assert.deepEqual(a.state.todos.map((t) => t.title), ["江口様：傘を忘れました"]);
    const b = withChatTodo(emptyBook("2026-11-04"), { id: "td-chat-2", title: "江口（架空）様：傘を忘れました" }, "江口", now);
    assert.deepEqual(b.state.todos.map((t) => t.title), ["江口様：傘を忘れました"]);
    assert.equal(b.journal, "ToDo に足した（予約チャットで「お店に確かめてご連絡します」と返したため）：江口様：傘を忘れました");
    assert.equal(withChatTodo(emptyBook("2026-11-04"), { id: "x", title: "青木様：傘" }, "江口", now).journal, null, "ほかの方の名前の題は受け取らない");
  });

  test("前の書き方を外すのは札だけ（ほかの文は変えない）", () => {
    assert.equal(withoutOldMark("青木（架空）様：前髪"), "青木様：前髪");
    assert.equal(withoutOldMark("予約サイト（架空）から1件入った：江口（架空）様 11/4"), "予約サイトから1件入った：江口様 11/4");
    assert.equal(withoutOldMark("人が登録：会計（架空）に通販の明細"), "人が登録：会計に通販の明細");
    assert.equal(withoutOldMark("広告（架空）を最初に戻した"), "広告を最初に戻した");
    assert.equal(withoutOldMark("お客様（架空）"), "お客様");
    assert.equal(withoutOldMark("架空の店のデモです"), "架空の店のデモです");
    assert.equal(withoutOldMark("青木様：前髪"), "青木様：前髪");
  });
});

describe("3. ブラウザに残った前の書き方でも同じように動く（保存は消さない）", () => {
  const raw = JSON.stringify({
    v: 1,
    anchor: "2026-11-04",
    chat: [
      { id: "h1", customerId: "c04", menuId: "cut", date: "2026-11-05", start: "11:00", status: "hold", heldAt: "2026-11-04T00:00:00.000Z", expiresAt: "2026-11-05T00:00:00.000Z" },
    ],
    approvals: [{ id: "a1", reservationId: "h1", createdAt: "2026-11-04T00:00:00.000Z", reason: "江口（架空）様のご希望の時間が空いていたため", state: "pending" }],
    todos: [
      { id: "td-next-k1", title: "青木（架空）様：前髪", createdAt: "2026-11-04T00:00:00.000Z", done: false, kind: "next-talk", source: "karte", key: "カルテ:k1" },
      { id: "td-chat-1", title: "江口（架空）様：傘", createdAt: "2026-11-04T00:00:00.000Z", done: false, source: "chat", key: "チャット:1" },
      { id: "td-h0", title: "大橋（架空）様に別の日時を案内", createdAt: "2026-11-04T00:00:00.000Z", done: true, source: "reserve" },
    ],
    kartes: [],
    todoTitles: { "ts-08": "江口（架空）様：次はパーマ" },
  });
  const s = parseBook(raw)!;

  test("ToDo は1件も消さず、鍵・済み・出どころはそのままで、題を今の書き方で読む", () => {
    assert.deepEqual(
      s.todos.map((t) => [t.id, t.title, t.done, t.key ?? null, t.source ?? null]),
      [
        ["td-next-k1", "青木様：前髪", false, "カルテ:k1", "karte"],
        ["td-chat-1", "江口様：傘", false, "チャット:1", "chat"],
        ["td-h0", "大橋様に別の日時を案内", true, null, "reserve"],
      ],
    );
    assert.deepEqual(s.todoTitles, { "ts-08": "江口様：次はパーマ" });
    assert.equal(s.approvals[0].reason, "江口様のご希望の時間が空いていたため");
  });

  test("拾う所（カルテの「次回話すこと」）は前の書き方の ToDo も拾う", () => {
    assert.deepEqual(s.todos.filter((t) => t.source === "karte" && isGuestTitle(t.title, "青木")).map((t) => t.id), ["td-next-k1"]);
  });

  test("同じ予約チャットの ToDo（同じ id）は、前の書き方で残っていても2回足さない", () => {
    assert.equal(withChatTodo(s, { id: "td-chat-1", title: "江口様：傘" }, "江口", "2026-11-04T02:00:00.000Z").journal, null);
  });

  test("前の書き方の題のまま残っていても、承認BOXの「直す」は今の書き方の ToDo を足す", () => {
    const next = withReleased(s, "a1", "fixed", "江口", "2026-11-04T02:00:00.000Z");
    assert.ok(next.todos.some((t) => t.title.startsWith("江口様に別の日時を案内（")), next.todos.map((t) => t.title).join("／"));
    assert.equal(next.todos.length, s.todos.length + 1);
  });

  test("ToDo の行は前の書き方の題でも「（架空）」を出さない", () => {
    assert.equal(renderToStaticMarkup(createElement(TodoTitle, { title: "青木（架空）様：前髪" })), '<span class="todo-title">青木様：前髪</span>');
  });

  test("日誌の行は消さず、今の書き方で出す", () => {
    const j = parseJournal(
      JSON.stringify([
        { id: "j1", at: "2026-11-04T00:00:00.000Z", who: "予約サイト", text: "予約サイト（架空）から1件入った：江口（架空）様 11/4（水） 11:30–12:30 カット" },
        { id: "j2", at: "2026-11-04T00:00:00.000Z", who: "オーナー", text: "広告（架空）を最初に戻した" },
      ]),
    );
    assert.deepEqual(
      j.map((e) => [e.id, e.who, e.text]),
      [
        ["j1", "予約サイト", "予約サイトから1件入った：江口様 11/4（水） 11:30–12:30 カット"],
        ["j2", "オーナー", "広告を最初に戻した"],
      ],
    );
  });

  test("ホームの「AI の仕事」の済みの印も、済みのまま今の書き方で出す", () => {
    const j = parseJobs(JSON.stringify({ v: 1, done: { site: { at: "2026-11-04T00:00:00.000Z", result: "台帳に1件（江口（架空）様）", tab: "reservations" } } }));
    assert.deepEqual(j.done.site, { at: "2026-11-04T00:00:00.000Z", result: "台帳に1件（江口様）", tab: "reservations" });
  });

  test("広告の承認BOXの理由も、今の書き方で読む", () => {
    const a = parseAds(
      JSON.stringify({
        v: 1,
        proposals: [{ id: "p1", no: 3, action: "stop", text: "言葉", reason: "検索広告（架空）で予約がない", createdAt: "2026-11-04T00:00:00.000Z", state: "pending", mode: "script", total: { clicks: 1, cost: 1, bookings: 0 } }],
      }),
    );
    assert.deepEqual(a.proposals.map((p) => p.reason), ["検索広告で予約がない"]);
  });
});
