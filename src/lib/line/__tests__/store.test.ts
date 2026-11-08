// 置き場所（Upstash の REST）の読み書きのテスト。Upstash は呼ばない（fetch を置きかえる）。
// 書いた直後の読み直しを書いた所から読ませる upstash-sync-token の扱い（直しW）。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SYNC_TOKEN_HEADER, upstashStore } from "../store";
import { fakeUpstash as laggingUpstash } from "./fakeUpstash";

const CONF = { url: "https://kv.example.test", token: "tok" };

/** 作り物の Upstash：呼ばれた見出しを残し、返事の見出しの sync token は tokens から順に出す（null なら付けない） */
function fakeUpstash(tokens: (string | null)[], result: unknown = "OK") {
  const sent: (string | null)[] = [];
  let i = 0;
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    sent.push(h.get(SYNC_TOKEN_HEADER));
    const cmds = JSON.parse(String(init?.body)) as unknown[];
    const t = tokens[i++] ?? null;
    return new Response(JSON.stringify(cmds.map(() => ({ result }))), {
      status: 200,
      headers: { "content-type": "application/json", ...(t ? { [SYNC_TOKEN_HEADER]: t } : {}) },
    });
  }) as typeof fetch;
  return { fetchFn, sent };
}

describe("直しW：upstash-sync-token（書いた直後の読み直しを書いた所から読む）", () => {
  test("返事の sync token を覚え、次の呼び出しの見出しに付ける。最初の呼び出しには付けない", async () => {
    const f = fakeUpstash(["t1", "t2"]);
    const s = upstashStore(CONF, f.fetchFn);
    assert.equal(await s.set("k", "v", { ex: 60, nx: true }), true);
    await s.get("k");
    await s.get("k");
    assert.deepEqual(f.sent, [null, "t1", "t2"], "毎回、前の返事の新しい値に替える");
  });

  test("返事に sync token が無い時は、前の値のまま付け続ける", async () => {
    const f = fakeUpstash(["t1", null, null, "t4"]);
    const s = upstashStore(CONF, f.fetchFn);
    await s.set("k", "v", { ex: 60 });
    await s.get("k");
    await s.del("k");
    await s.get("k");
    await s.get("k");
    assert.deepEqual(f.sent, [null, "t1", "t1", "t1", "t4"]);
  });

  test("返事に一度も sync token が無ければ、見出しは付けない", async () => {
    const f = fakeUpstash([null, null]);
    const s = upstashStore(CONF, f.fetchFn);
    await s.set("k", "v", { ex: 60 });
    await s.get("k");
    assert.deepEqual(f.sent, [null, null]);
  });

  test("置き場を2つ作った時、片方の token がもう片方に混ざらない（プロセス全体で共有しない）", async () => {
    const fa = fakeUpstash(["a1", "a2"]);
    const fb = fakeUpstash(["b1", "b2"]);
    const a = upstashStore(CONF, fa.fetchFn);
    const b = upstashStore(CONF, fb.fetchFn);
    await a.set("k", "v", { ex: 60 });
    await b.get("k");
    await a.get("k");
    await b.get("k");
    assert.deepEqual(fa.sent, [null, "a1"]);
    assert.deepEqual(fb.sent, [null, "b1"]);
    // 同じ fetch を使っても、置き場ごとに別々に覚える
    const shared = fakeUpstash(["s1", "s2", "s3"]);
    const c = upstashStore(CONF, shared.fetchFn);
    const d = upstashStore(CONF, shared.fetchFn);
    await c.set("k", "v", { ex: 60 }); // c は s1 を覚える
    await d.get("k"); // d は最初なので付けない（s2 を覚える）
    await c.get("k"); // c は s1
    assert.deepEqual(shared.sent, [null, null, "s1"]);
  });

  test("いくつかの命令を1回で送る時（incr の期限・rpush）も、同じ置き場の続きとして付ける", async () => {
    const f = fakeUpstash(["t1", "t2", "t3"], 1);
    const s = upstashStore(CONF, f.fetchFn);
    assert.equal(await s.incr("n", 60), 1); // INCR と EXPIRE を1回で
    await s.rpush("l", "x", 60);
    assert.deepEqual(f.sent, [null, "t1"]);
  });

  test("鍵（Authorization）は今どおり付き、sync token の見出しの名前は Upstash の物", async () => {
    let auth: string | null = null;
    const fetchFn = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify([{ result: null }]), { status: 200 });
    }) as typeof fetch;
    await upstashStore(CONF, fetchFn).get("k");
    assert.equal(auth, "Bearer tok");
    assert.equal(SYNC_TOKEN_HEADER, "upstash-sync-token");
  });

  test("効くのは同じ置き場の中だけ：書いた直後の GET は元の所から読む・別々に作った置き場には引き継がない。送るのは /pipeline", async () => {
    const up = laggingUpstash({ now: () => 0 });
    const a = upstashStore(CONF, up.fetch);
    assert.equal(await a.set("k", "v", { ex: 60, nx: true }), true);
    assert.equal(await a.get("k"), "v", "同じ置き場の中では、書いた直後でも読める");
    // 別々に作った置き場（例：試験10問の startRun と evalGate）は token を持たないので、最初の読みは写しから（まだ写っていない）
    const b = upstashStore(CONF, up.fetch);
    assert.equal(await b.get("k"), null);
    assert.deepEqual(
      up.calls.map((c) => c.syncToken),
      [null, "t1", null],
    );
    assert.ok(up.calls.every((c) => c.url === `${CONF.url}/pipeline`), "token を付けるのは pipeline の窓口");
  });
});

describe("直しX：数の鍵の期限は、足すのと同じ1回で付ける", () => {
  test("incr は INCR と EXPIRE（NX）を1つの pipeline で送る（2回目からも同じ形・期限は付けなおさない）", async () => {
    let t = 0;
    const up = laggingUpstash({ now: () => t });
    const s = upstashStore(CONF, up.fetch);
    assert.equal(await s.incr("n", 60), 1);
    t = 30_000;
    assert.equal(await s.incr("n", 60), 2);
    assert.equal(up.calls.length, 2, "1回の incr は1回の呼び出し");
    for (const c of up.calls) {
      assert.equal(c.url, `${CONF.url}/pipeline`);
      assert.deepEqual(c.cmds, [
        ["INCR", "n"],
        ["EXPIRE", "n", "60", "NX"],
      ]);
    }
    assert.equal(up.until("n"), 60_000, "期限は最初に付けた時のまま（NX）");
  });

  test("前に残った期限の無い数にも、次に足した時に期限が付く", async () => {
    const t = 0;
    const up = laggingUpstash({ now: () => t });
    // 前の作り（INCR の後に別に EXPIRE）で、間で落ちて期限の無い数が残った形
    await up.fetch(`${CONF.url}/pipeline`, { method: "POST", body: JSON.stringify([["INCR", "old"]]) });
    assert.equal(up.until("old"), Infinity);
    const s = upstashStore(CONF, up.fetch);
    assert.equal(await s.incr("old", 600), 2);
    assert.equal(up.until("old"), 600_000);
  });

  test("置き場がうまくいかない時は、数を返さずに投げる（数えられないので動かさない）", async () => {
    const up = laggingUpstash({ now: () => 0, failOn: (c) => c[0] === "EXPIRE" });
    const s = upstashStore(CONF, up.fetch);
    await assert.rejects(() => s.incr("n", 60));
  });
});
