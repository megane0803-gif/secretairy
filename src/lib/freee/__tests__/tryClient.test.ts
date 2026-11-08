// 来た人の画面から /api/freee/try を呼ぶ形（ブラウザの側）。サーバーも freee も呼ばない（post を置きかえる）。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Post } from "../run";
import { phaseLine, readTryAnswer, restoreNote, reuseOpenRead, TRY_PATH, TRY_REGISTERED_NOTE, tryRegister, type TryInfo, type TryPhase } from "../tryClient";

const NOW = () => "2026-11-05T03:00:00.000Z";
const info = (items: TryInfo["items"], phase: TryPhase = "holding"): TryInfo => ({ phase, minutes: 5, mine: true, items, holdMinutes: 5, maxItems: 2 });
const listBody = (items: Parameters<typeof info>[0]) => ({ ok: true, range: { from: "2026-08-07", to: "2026-11-10" }, rows: [], capped: false, bank: null, trial: info(items) });

describe("freee：来た人の画面の呼び方", () => {
  test("送るのは明細の番号と店用か私用かだけ。登録できたら1回だけ読み直し、入ったのを確かめてから今どおりの言い方に1文を足す", async () => {
    const sent: unknown[] = [];
    const post: Post = async (path, body) => {
      assert.equal(path, TRY_PATH);
      sent.push(body);
      return (body as { action: string }).action === "register"
        ? { status: 200, body: { ok: true, id: 5, result: "registered", reason: "x" } }
        : { status: 200, body: listBody([{ id: 5, use: "shop", state: "registered" }]) };
    };
    const r = await tryRegister(post, { id: 5, use: "shop", label: "登録した 1件（店用）" }, NOW);
    assert.equal(r.result, "registered");
    assert.equal(r.message, `登録した 1件（店用）。${TRY_REGISTERED_NOTE}`);
    assert.equal(TRY_REGISTERED_NOTE, "テスト用の事業所に登録しました。読み直して入ったのを確かめました");
    assert.deepEqual(sent, [{ action: "register", id: 5, use: "shop" }, { action: "read" }]);
  });

  test("読み直しでまだ入っていなければ「確かめました」と言わない", async () => {
    const post: Post = async (_p, body) =>
      (body as { action: string }).action === "register" ? { status: 200, body: { ok: true, id: 5, result: "registered" } } : { status: 200, body: listBody([{ id: 5, use: "shop", state: "open" }]) };
    const r = await tryRegister(post, { id: 5, use: "shop", label: "登録した 1件（店用）" }, NOW);
    assert.equal(r.result, "unconfirmed");
    assert.ok(!r.message.includes("確かめました"));
  });

  test("結果が分からない時は、呼び直さない（読み直しもしない）", async () => {
    for (const make of [
      async () => {
        throw new TypeError("network");
      },
      async () => ({ status: 504, body: null }),
      async () => ({ status: 200, body: { ok: true, id: 5, result: "unknown", reason: "送った後に返事が途切れました。送り直しません。いまは試せません（オーナーが直します）" } }),
    ]) {
      let calls = 0;
      const post: Post = async () => {
        calls++;
        return make();
      };
      const r = await tryRegister(post, { id: 5, use: "private", label: "x" }, NOW);
      assert.equal(r.result, "unknown");
      assert.equal(calls, 1);
    }
  });

  test("答えの読み方：つながっていない・本番ではない・読めた", () => {
    assert.deepEqual(readTryAnswer(200, { ok: false, code: "not-connected", message: "いまは経理につながっていません（オーナーがつなぎ直します）" }, NOW()), {
      kind: "not-connected",
      message: "いまは経理につながっていません（オーナーがつなぎ直します）",
    });
    assert.equal(readTryAnswer(404, { ok: false, code: "off" }, NOW()).kind, "off");
    assert.equal(readTryAnswer(200, listBody([]), NOW()).kind, "ok");
    assert.equal(readTryAnswer(200, { ok: true, rows: [] }, NOW()).kind, "error");
  });

  test("画面の1行：自動で戻ったとは書かない。言いすぎない", () => {
    assert.equal(restoreNote(5), "試した物は、5分たった後に、次にだれかが経理のタブを開いた時に元に戻ります");
    const lines = [restoreNote(5), ...(["holding", "restoring", "repair"] as const).map((p) => phaseLine(info([], p))!)];
    assert.equal(phaseLine(info([], "repair"))!, "いまは試せません（オーナーが直します）");
    for (const l of lines) for (const w of ["100%", "必ず", "すぐ反映", "戻りました"]) assert.ok(!l.includes(w), `${l}：${w}`);
  });
});

describe("直しX：経理のタブを開いた時の読むは、少し前に読めたばかりなら省く", () => {
  const T = Date.parse("2026-11-05T03:00:00.000Z");
  test("決めた秒数の中だけ省く（読めていない・元に戻している・要復旧の時は省かない）", () => {
    assert.equal(reuseOpenRead(null, T, 120, info([])), false, "まだ読めていない");
    assert.equal(reuseOpenRead(T, T + 60_000, 120, info([])), true);
    assert.equal(reuseOpenRead(T, T + 120_000, 120, info([])), false, "決めた秒数をこえたら読む");
    assert.equal(reuseOpenRead(T, T - 1, 120, info([])), false, "時計が戻った時は読む");
    assert.equal(reuseOpenRead(T, T + 1000, 120, null), false);
    assert.equal(reuseOpenRead(T, T + 1000, 120, info([], "restoring")), false);
    assert.equal(reuseOpenRead(T, T + 1000, 120, info([], "repair")), false);
    assert.equal(reuseOpenRead(T, T + 1000, 120, info([], "free")), true);
  });
});
