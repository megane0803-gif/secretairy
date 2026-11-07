// 発信：③「下書きを保存」（直しK）。保存できた時だけ、③の下書きと②の材料を空にする（選んだ種類は残す）。
// 保存できなかった3つの時（同じ文がもうある・使わない言葉がある・ブラウザに書けない）は何も消さない。日誌は保存できた時だけ「保存した」。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SAVE_FAILED_MESSAGE, type BrowserWrite } from "../../browser";
import type { PostDraft, PostsDesk } from "../deskStore";
import { deskAfterSave, savedNote, savePostDraft, type PostSaveDeps } from "../save";
import { EMPTY_POSTS, type PostsState } from "../state";

const GATE = ["今だけ", "絶対"];

const draft = (text: string, extra: Partial<PostDraft> = {}): PostDraft => ({
  id: "pd-1",
  version: 0,
  kind: "blog",
  text,
  made: text,
  checks: [],
  inserted: [],
  tries: 1,
  cut: false,
  mode: "ai",
  topic: "冬のヘアケア",
  ...extra,
});

const desk = (d: PostDraft | null): PostsDesk => ({
  kind: "blog",
  materials: { blog: { topic: "冬のヘアケア", points: "乾燥" }, sns: { topic: "別の種類の材料" } },
  draft: d,
  busy: false,
  mode: "ai",
  noAi: false,
  failed: null,
  problem: null,
});

function mem(start: PostsState = EMPTY_POSTS, fail: false | "full" | "denied" = false) {
  const box = { state: start, writes: 0, lines: [] as string[] };
  const deps: PostSaveDeps = {
    read: () => box.state,
    write: (s): BrowserWrite => {
      if (fail) return { ok: false, why: fail };
      box.writes += 1;
      box.state = s;
      return { ok: true };
    },
    journal: (...l) => box.lines.push(...l.map((x) => `${x.who}：${x.text}`)),
  };
  const save = (d: PostDraft, id = "po-1") => savePostDraft(deps, { draft: d, kindLabel: "ブログ", id, nowIso: "2026-11-07T01:00:00.000Z", gateWords: GATE, maxPerKind: 30 });
  return { box, save };
}

/** 画面と同じ流れ：保存できた時だけ机を空にする */
function press(m: ReturnType<typeof mem>, d: PostsDesk): { desk: PostsDesk; ok: boolean; text: string } {
  const r = m.save(d.draft!);
  if (!r.ok) return { desk: d, ok: false, text: r.reason };
  return { desk: { ...d, ...deskAfterSave(d, d.draft!.kind) }, ok: true, text: savedNote("ブログ", "右") };
}

describe("発信の保存 1：保存できた時だけ、③の下書きと②の材料を空にする", () => {
  test("保存できた → 下書きは空・その種類の材料は空・選んだ種類とほかの種類の材料は残す", () => {
    const m = mem();
    const before = desk(draft("冬の乾燥にはていねいなケアを。"));
    const after = press(m, before);
    assert.equal(after.ok, true);
    assert.equal(after.desk.draft, null);
    assert.deepEqual(after.desk.materials.blog, {});
    assert.deepEqual(after.desk.materials.sns, { topic: "別の種類の材料" });
    assert.equal(after.desk.kind, "blog");
    assert.equal(after.desk.mode, "ai");
    assert.equal(m.box.state.saved.length, 1);
    assert.deepEqual(m.box.lines, ["オーナー：ブログの下書きを保存した（15字。送信・公開はしていない）"]);
  });
  test("出す文は、どこに入ったかが分かる形", () => {
    assert.equal(savedNote("ブログ", "右"), "保存しました（ブログ）。右の「保存した下書き」に入っています。");
    assert.equal(savedNote("ブログ", "下"), "保存しました（ブログ）。下の「保存した下書き」に入っています。");
  });
});

describe("発信の保存 2：保存できなかった3つの時は、何も消さない", () => {
  test("同じ文がもうある", () => {
    const m = mem();
    m.save(draft("冬の乾燥にはていねいなケアを。"), "po-0");
    const lines = m.box.lines.length;
    const before = desk(draft("冬の乾燥にはていねいなケアを。"));
    const after = press(m, before);
    assert.equal(after.ok, false);
    assert.equal(after.text, "同じ文はもう保存してあります");
    assert.deepEqual(after.desk, before);
    assert.equal(m.box.state.saved.length, 1);
    assert.match(m.box.lines.at(-1)!, /二重に保存しなかった/);
    assert.equal(m.box.lines.length, lines + 1);
  });
  test("使わない言葉がある", () => {
    const m = mem();
    const before = desk(draft("今だけのご案内です。", { handEdited: true }));
    const after = press(m, before);
    assert.equal(after.ok, false);
    assert.match(after.text, /「今だけ」は使わない言葉です/);
    assert.deepEqual(after.desk, before);
    assert.equal(m.box.writes, 0);
  });
  for (const why of ["full", "denied"] as const) {
    test(`ブラウザに書けない（${why}）→ 決まった1文。日誌に「保存した」は書かない`, () => {
      const m = mem(EMPTY_POSTS, why);
      const before = desk(draft("冬の乾燥にはていねいなケアを。"));
      const after = press(m, before);
      assert.equal(after.ok, false);
      assert.equal(after.text, SAVE_FAILED_MESSAGE);
      assert.deepEqual(after.desk, before);
      assert.deepEqual(m.box.lines, []);
    });
  }
});

describe("発信の保存 3：画面は保存できた時だけ空にする", () => {
  const board = readFileSync(join(__dirname, "../../../app/posts/PostsBoard.tsx"), "utf8");
  test("savePostDraft の答えが ok でなければ、空にする前に戻る", () => {
    const at = board.indexOf("const r = savePostDraft(");
    const bad = board.indexOf("if (!r.ok) {", at);
    const back = board.indexOf("return;", bad);
    const clear = board.indexOf("setPostsDesk((s) => deskAfterSave(s, draft.kind));", at);
    assert.ok(at > 0 && bad > at && back > bad && clear > back);
  });
  test("書く所は書けたかを返す（usePosts の update も）", () => {
    const store = readFileSync(join(__dirname, "../usePosts.ts"), "utf8");
    assert.match(store, /write: \(s: PostsState\): BrowserWrite => writeBrowser\(POSTS_KEY/);
    assert.match(store, /\(f: \(s: PostsState\) => PostsState\): BrowserWrite =>/);
  });
});
