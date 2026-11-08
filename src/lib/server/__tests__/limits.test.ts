// 来た人の呼び出しの数え方（src/lib/server/limits.ts）のテスト。置き場は memoryStore（Upstash は呼ばない）。
// 広告のだれでも試す・広告の読み直す・経理の来た人の登録・読むの4つの設定を、同じ物差しで確かめる。

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { memoryStore } from "../../line/store";
import { callKeys, callLimitsProblem, countCall, shopClock, type CallLimits } from "../limits";
import { sourceBuckets, sourceHashes } from "../source";
import { getAdSettings, getFreeeSettings, getShop } from "../../settings";

const ads = getAdSettings().live;
const freee = getFreeeSettings().try;
const TZ = getShop().timezone;
const SALT = "s".repeat(32);
/** 店の 2026-11-05 00:00（日本時間）。ここから24時間を1日として見る */
const DAY0 = Date.parse("2026-11-04T15:00:00.000Z");

const CONFIGS: [string, CallLimits][] = [
  ["広告のだれでも試す（live.try.limits）", ads.try.limits],
  ["広告の読み直す（live.read）", ads.read],
  ["経理の来た人の登録（freee.try.register）", freee.register],
  ["経理の来た人の読む（freee.try.read）", freee.read],
];

function counter(limits: CallLimits) {
  let now = DAY0;
  const store = memoryStore(() => now);
  const call = (ip: string) => {
    const c = shopClock(TZ, now);
    return countCall({ incr: (k, ex) => store.incr(k, ex), prefix: "t", date: c.date, hour: c.hour, minute: c.minute, sender: sourceHashes(SALT, ip) }, limits);
  };
  const siteDay = async () => Number((await store.get(callKeys({ prefix: "t", date: "2026-11-05", hour: "00", minute: 0, sender: { narrow: "", wide: null } }).siteDay)) ?? 0);
  return { call, siteDay, at: (ms: number) => (now = ms), get now() { return now; }, store };
}

describe("直しX：数え方の約束（4つの窓口の設定）", () => {
  for (const [name, l] of CONFIGS) {
    test(`${name}：1日は1時間の24倍以上・IPv4 の番地10個と /48 1つでは1日の全体に届かない・細かい単位ほど小さい`, () => {
      assert.equal(callLimitsProblem(l), null);
      assert.ok(l.site.day >= l.site.hour * 24);
      assert.ok(l.source.day * 10 < l.site.day);
      assert.ok(l.wide.day < l.site.day);
      assert.ok(l.wide.day > l.source.day, "同じ家や会社の人が困らないよう、/48 は /64 より大きい数");
    });
  }

  test("約束を破る設定は callLimitsProblem が見つける", () => {
    const ok: CallLimits = { source: { day: 10, hour: 3, minute: 2 }, wide: { day: 20, hour: 6 }, site: { minute: 6, hour: 6, day: 144 } };
    assert.equal(callLimitsProblem(ok), null);
    assert.match(callLimitsProblem({ ...ok, site: { ...ok.site, day: 100 } })!, /24倍/);
    assert.match(callLimitsProblem({ ...ok, source: { ...ok.source, day: 15 }, wide: { ...ok.wide, day: 30 } })!, /10倍/);
    assert.match(callLimitsProblem({ ...ok, wide: { ...ok.wide, day: 144 } })!, /広い束/);
    assert.match(callLimitsProblem({ ...ok, source: { ...ok.source, minute: 0 } })!, /1以上/);
  });
});

describe("直しX：少ない送り元では、その日の全体を使い切れない", () => {
  for (const [name, l] of CONFIGS) {
    test(`${name}：IPv4 の番地10個が1日じゅう送り続けても、全体の1日に届かず、ほかの人は通る`, async () => {
      const c = counter(l);
      const ips = Array.from({ length: 10 }, (_, i) => `198.51.100.${i + 1}`);
      // 1分ごとに10個の番地から送る（24時間。1分の数より細かく送っても、先に送り元の数で止まる）
      for (let t = 0; t < 86_400_000; t += 60_000) {
        c.at(DAY0 + t);
        for (const ip of ips) await c.call(ip);
      }
      const used = await c.siteDay();
      assert.ok(used <= l.source.day * 10 && used < l.site.day, `${used}`);
      c.at(DAY0 + 86_400_000 - 30 * 60_000);
      assert.equal(await c.call("203.0.113.50"), "ok", "ほかの送り元は通る");
    });

    test(`${name}：IPv6 の /48 1つが /64 を変えながら送り続けても、全体の1日に届かず、ほかの人は通る`, async () => {
      const c = counter(l);
      let n = 0;
      for (let t = 0; t < 86_400_000; t += 60_000) {
        c.at(DAY0 + t);
        for (let k = 0; k < 10; k++) await c.call(`2001:db8:aa:${(n++ % 65535).toString(16)}::1`);
      }
      const used = await c.siteDay();
      assert.ok(used <= l.wide.day && used < l.site.day, `${used}`);
      c.at(DAY0 + 86_400_000 - 30 * 60_000);
      assert.equal(await c.call("2001:db8:bb:1::1"), "ok", "ほかの /48 は通る");
      assert.equal(await c.call("2001:db8:aa:ffff::1"), "wide-day", "同じ /48 は止まる");
    });

    test(`${name}：たくさんの送り元に1時間の数を使い切られても、止まるのは長くてその時の終わりまで（1日の数には届かない）`, async () => {
      const c = counter(l);
      let n = 0;
      for (let h = 0; h < 24; h++) {
        const start = DAY0 + h * 3_600_000;
        c.at(start);
        // 時の頭に、来た人が1回
        assert.equal(await c.call(`203.0.113.${h + 1}`), "ok", `${h}時の頭は通る`);
        // 残りを、たくさんの送り元が使い切る（1分の上限に当てないよう分をずらす）
        for (let i = 0; i < l.site.hour + 5; i++) {
          c.at(start + 60_000 + Math.floor(i / l.site.minute) * 60_000);
          await c.call(`10.${h}.${Math.floor(n / 250) % 250}.${n++ % 250}`);
        }
        c.at(start + 59 * 60_000);
        assert.equal(await c.call(`203.0.114.${h + 1}`), "site-hour", `${h}時は使い切られている`);
      }
      assert.ok((await c.siteDay()) <= l.site.hour * 24);
    });
  }

  test("順は 同じ送り元 → 広い束 → 全体。こえたら先は足さない", async () => {
    const l: CallLimits = { source: { day: 3, hour: 3, minute: 3 }, wide: { day: 5, hour: 5 }, site: { minute: 100, hour: 100, day: 2400 } };
    const c = counter(l);
    for (let i = 0; i < 3; i++) assert.equal(await c.call("2001:db8:1:1::1"), "ok");
    assert.equal(await c.call("2001:db8:1:1::2"), "source-day");
    assert.equal(await c.siteDay(), 3, "送り元でこえた分は全体に足さない");
    assert.equal(await c.call("2001:db8:1:2::1"), "ok");
    assert.equal(await c.call("2001:db8:1:2::1"), "ok");
    assert.equal(await c.call("2001:db8:1:3::1"), "wide-day");
    assert.equal(await c.siteDay(), 5);
  });
});

describe("送り元の束（/64 と /48）", () => {
  test("IPv6 は /64 と /48・IPv4 と IPv4 を写した IPv6 は番地だけ（広い束なし）", () => {
    assert.deepEqual(sourceBuckets("2001:db8:1:2::1"), { narrow: "2001:db8:1:2::/64", wide: "2001:db8:1::/48" });
    assert.deepEqual(sourceBuckets("[2001:0DB8:0001:0002:aaaa::9]"), { narrow: "2001:db8:1:2::/64", wide: "2001:db8:1::/48" });
    assert.equal(sourceBuckets("2001:db8:1:2::1").wide, sourceBuckets("2001:db8:1:ffff::1").wide);
    assert.notEqual(sourceBuckets("2001:db8:1:2::1").wide, sourceBuckets("2001:db8:2:2::1").wide);
    assert.deepEqual(sourceBuckets("203.0.113.7"), { narrow: "203.0.113.7", wide: null });
    assert.deepEqual(sourceBuckets("::ffff:198.51.100.4"), { narrow: "198.51.100.4", wide: null });
    assert.deepEqual(sourceBuckets("unknown"), { narrow: "unknown", wide: null });
    const h = sourceHashes(SALT, "2001:db8:1:2::1");
    assert.match(h.narrow, /^[0-9a-f]{32}$/);
    assert.notEqual(h.narrow, h.wide);
  });
});
