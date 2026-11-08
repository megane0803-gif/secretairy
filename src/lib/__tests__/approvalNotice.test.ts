// 直しY 4：ホームの承認BOXで予約の行を承認・直す・見送りした時の知らせ（「✓ 確定しました：…」「✗ 確定しませんでした：…」
// 「仮押さえを外し、ToDo に足しました：…」）を、ほかの行が残っていても0件になっても、次の操作まで出す（広告の行の知らせと同じ考え）。
// 知らせは承認BOXが1つだけ持ち、予約の行と広告の行の知らせは分けず、新しい操作の知らせに置きかえる。文・日誌・確定の決まり・
// 書けなかった時の1文（failed）は今のまま。承認BOXの部品はブラウザの中の置き場所を読むので描かず、台帳の変え方（画面と同じ
// withHold・withApproved・withReleased）と承認BOXの形（ApprovalBoxFrame。描いて確かめる）とソースのつなぎで確かめる。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalBoxFrame } from "../../components/ApprovalBox";
import type { HoldOffer } from "../ai/wire";
import { EMPTY_ADS, withProposal } from "../ads/state";
import { buildTable } from "../ads/report";
import { approvalQueue, approvalsFor } from "../approvals";
import { emptyBook, withApproved, withHold, withReleased, type BookState } from "../book/state";
import { getAds } from "../data/seed";
import { getAdSettings } from "../settings";
import { rescheduleTitle } from "../todo/reschedule";

const ROOT = join(__dirname, "../../..");
const box = readFileSync(join(ROOT, "src/components/ApprovalBox.tsx"), "utf8");
const now = "2026-11-04T02:00:00.000Z";
const hold = (id: string, customerId: string, start: string): HoldOffer => ({
  id,
  customerId,
  menuId: "cut",
  date: "2026-11-06",
  start,
  heldAt: "2026-11-04T01:00:00.000Z",
  expiresAt: "2026-11-05T01:00:00.000Z",
  reason: "お客様が候補から選びました",
});
/** 仮押さえ2件と広告の案1件（承認待ち3件） */
function threeRows(): { book: BookState; ads: typeof EMPTY_ADS } {
  const book = withHold(withHold(emptyBook("2026-11-04"), hold("h1", "c04", "15:00")), hold("h2", "c05", "16:00"));
  const table = buildTable(getAds(), getAdSettings());
  const row = table.keywords[0];
  const ads = withProposal(EMPTY_ADS, { action: "stop", no: row.no, text: row.text, reason: "予約につながっていません。" }, table, { id: "ad1", checks: [], nowIso: now, mode: "script" }, getAdSettings());
  return { book, ads };
}
const count = (book: BookState, ads: typeof EMPTY_ADS) => approvalsFor(approvalQueue(book, ads, now), "all").count;
const frame = (empty: boolean, notice: string | null, failed: string | null = null) =>
  renderToStaticMarkup(createElement(ApprovalBoxFrame, { empty, failed, notice }, createElement("ul", { className: "approvals" }, createElement("li", null, "のこりの行"))));
const shown = (text: string) => `<p class="hint" role="status">${text}</p>`;

describe("直しY 4：予約の行の知らせは、ほかの行が残っていても0件になっても出す", () => {
  test("ほかの行（仮押さえ・広告の案）を残したまま予約の行を承認 →「✓ 確定しました：…」が一覧の上に出る", () => {
    const { book, ads } = threeRows();
    assert.equal(count(book, ads), 3);
    const after = withApproved(book, book.approvals[0].id, now);
    assert.equal(after.chat.find((r) => r.id === "h1")?.status, "confirmed", "台帳に確定で入る");
    assert.equal(count(after, ads), 2, "ほかの行は残る（承認BOXは一覧の形のまま）");
    const text = "✓ 確定しました：青木様 11月6日(金) 15:00 カット";
    const html = frame(false, text);
    assert.ok(html.startsWith(shown(text)), html);
    assert.match(html, /のこりの行/);
    assert.doesNotMatch(html, /承認待ちはありません/);
  });

  test("ほかの行を残したまま見送り →「仮押さえを外し、ToDo に足しました：…」が出る", () => {
    const { book, ads } = threeRows();
    const after = withReleased(book, book.approvals[0].id, "skipped", "青木", now, "2026-11-04");
    assert.equal(count(after, ads), 2);
    const title = rescheduleTitle("青木", book.chat[0]);
    assert.ok(after.todos.some((t) => t.title === title), "ToDo に足す");
    const text = `仮押さえを外し、ToDo に足しました：${title}`;
    assert.ok(frame(false, text).startsWith(shown(text)));
  });

  test("0件になった時も今どおり「承認待ちはありません」の下に出る。書けなかった時の1文は今のまま別に出る", () => {
    const text = "✓ 確定しました：青木様 11月6日(金) 15:00 カット";
    const checked = renderToStaticMarkup(createElement(ApprovalBoxFrame, { empty: true, failed: null, notice: null }));
    assert.match(checked, /承認待ちはありません/);
    assert.equal(frame(true, text), checked + shown(text));
    assert.doesNotMatch(frame(true, text), /のこりの行/);
    const failed = frame(false, null, "ブラウザに保存できませんでした。入力はそのまま残しています。");
    assert.match(failed, /^<p class="problems" role="alert">ブラウザに保存できませんでした。入力はそのまま残しています。<\/p><ul/);
  });

  test("画面：承認BOXが知らせを1つだけ持ち、承認・確定しない・直す・見送りはどれもそこに入れる。行が残っていても0件でも同じ形で出す", () => {
    assert.match(box, /const \[done, setDone\] = useAdDone\(book\.state\.epoch\);/);
    assert.match(box, /setDone\(`✓ 確定しました：\$\{what\}`\);/);
    assert.match(box, /setDone\(`✗ 確定しませんでした：\$\{blocked\}`\);/);
    assert.match(box, /setDone\(`仮押さえを外し、ToDo に足しました：\$\{title\}`\);/);
    assert.match(box, /if \(queue\.count === 0\) return <ApprovalBoxFrame empty failed=\{failed\} notice=\{done\} \/>;/);
    assert.match(box, /<ApprovalBoxFrame empty=\{false\} failed=\{failed\} notice=\{done\}>/);
    // 広告の行も同じ知らせに入れる（新しい操作の知らせに置きかえる）
    assert.match(box, /<AdApprovalRows seedRules=\{data\.seedRules\} done=\{done\} onDone=\{setDone\} \/>/);
    assert.equal((box.match(/useState</g) ?? []).length, 1, "知らせのほかに持つのは書けなかった時の1文だけ");
  });
});
