// 作り物の Upstash の REST（/pipeline）。テストだけで使う（本物の Upstash は呼ばない）。
// 書くのは元の所・読むのは写しから、を作る：書く命令の入った呼び出しは元の所で動き、読むだけの呼び出しは写しから読む。
// 写しは catchUp() を呼ぶまで追いつかない（窓口の1回の呼び出しの中では、ずっと遅れている＝いちばん意地悪な形）。
// 返事には毎回 upstash-sync-token（書いた回数の印）を付け、読むだけの呼び出しにその見出しがあれば元の所から読む
// （honorSyncToken: false なら見出しを見ない＝前の作りのままだと何が起きるかを見る用）。

import { SYNC_TOKEN_HEADER } from "../store";

type Entry = { v: string | string[]; until: number };
type Db = Map<string, Entry>;

const WRITES = new Set(["SET", "DEL", "GETDEL", "INCR", "EXPIRE", "RPUSH", "LPOP"]);

export type UpstashCall = { url: string; syncToken: string | null; cmds: string[][] };

export function fakeUpstash(o: { now: () => number; honorSyncToken?: boolean; failOn?: (cmd: string[]) => boolean }) {
  const honor = o.honorSyncToken ?? true;
  let primary: Db = new Map();
  let replica: Db = new Map();
  let seq = 0;
  const calls: UpstashCall[] = [];
  const clone = (db: Db): Db => new Map([...db].map(([k, e]) => [k, { v: Array.isArray(e.v) ? [...e.v] : e.v, until: e.until }]));
  const live = (db: Db, k: string) => {
    const e = db.get(k);
    if (e && e.until <= o.now()) db.delete(k);
    return db.get(k);
  };

  function run(db: Db, c: string[]): unknown {
    const [name, k] = c;
    const e = live(db, k);
    switch (name) {
      case "GET":
        return e && typeof e.v === "string" ? e.v : null;
      case "SET": {
        const ex = Number(c[c.indexOf("EX") + 1]);
        if (c.includes("NX") && e) return null;
        db.set(k, { v: c[2], until: o.now() + ex * 1000 });
        return "OK";
      }
      case "DEL":
        return db.delete(k) ? 1 : 0;
      case "GETDEL":
        db.delete(k);
        return e && typeof e.v === "string" ? e.v : null;
      case "INCR": {
        const n = (e && typeof e.v === "string" ? Number(e.v) : 0) + 1;
        db.set(k, { v: String(n), until: e ? e.until : Infinity });
        return n;
      }
      case "EXPIRE":
        if (!e) return 0;
        e.until = o.now() + Number(c[2]) * 1000;
        return 1;
      case "RPUSH": {
        const list = e && Array.isArray(e.v) ? e.v : [];
        db.set(k, { v: [...list, c[2]], until: e ? e.until : Infinity });
        return list.length + 1;
      }
      case "LPOP": {
        if (!e || !Array.isArray(e.v)) return null;
        const out = e.v.slice(0, Number(c[2]));
        e.v = e.v.slice(out.length);
        if (!e.v.length) db.delete(k);
        return out;
      }
      default:
        throw new Error(`作り物の Upstash に無い命令：${name}`);
    }
  }

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const syncToken = new Headers(init?.headers).get(SYNC_TOKEN_HEADER);
    const cmds = JSON.parse(String(init?.body)) as string[][];
    calls.push({ url, syncToken, cmds });
    if (!url.endsWith("/pipeline")) return new Response("not found", { status: 404 });
    const writes = cmds.some((c) => WRITES.has(c[0]));
    const db = writes || (honor && syncToken) ? primary : replica;
    const out = cmds.map((c) => {
      if (o.failOn?.(c)) return { error: "ERR fake" };
      if (WRITES.has(c[0])) seq++;
      return { result: run(db, c) };
    });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json", [SYNC_TOKEN_HEADER]: `t${seq}` } });
  }) as typeof fetch;

  return {
    fetch: fetchFn,
    calls,
    /** 写しを元の所に追いつかせる（窓口の呼び出しの間に） */
    catchUp: () => void (replica = clone(primary)),
    /** 元の所の値（テストで見る用） */
    value: (k: string) => {
      const e = live(primary, k);
      return e && typeof e.v === "string" ? e.v : null;
    },
    until: (k: string) => live(primary, k)?.until ?? null,
    keys: () => [...primary.keys()].filter((k) => live(primary, k)),
    reset: () => {
      primary = new Map();
      replica = new Map();
    },
  };
}
