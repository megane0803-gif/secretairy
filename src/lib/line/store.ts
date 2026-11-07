// LINE のつなぎと試験10問の見張りと広告のテスト用アカウントの見張りと経理の来た人の試しだけに使う、短い間の置き場所（Upstash Redis。サーバーの側だけ）。
// 置くのは「合言葉のつなぎ」「画面が受け取りに来るまでの LINE の知らせ」と、試験10問の「流している印」「呼んだ回数」（src/lib/eval/guard.ts）、
// 広告のテスト用アカウントの「動いている印」「1日の回数」「合言葉の間違いの数」とだれでも試すの「回数」「日ごとの塩」「最後に元の形に戻した時刻」
// （src/lib/ads/live/server.ts。送り元は塩と合わせたハッシュだけ）、
// 経理の freee（テスト事業所）の暗号化した鍵・延ばす印・書く時の印・来た人の試しの記録・回数（src/lib/freee/kv.ts・trial.ts・try.ts）だけ。どれも期限つきで消える。
// お客様の記録・台帳・日誌はここに置かない（それは見ている人のブラウザの中だけ。docs/SPEC.md §5.1）。
//
// 環境変数は Vercel が Upstash をつないだときに自動で入れる名前を使う：
//   KV_REST_API_URL / KV_REST_API_TOKEN（無ければ UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN）
// テストでは memoryStore（このプロセスの中だけ）に置きかえる。

export interface KvStore {
  get(key: string): Promise<string | null>;
  /** nx = まだ無いときだけ置く。置けたら true */
  set(key: string, value: string, opts: { ex: number; nx?: boolean }): Promise<boolean>;
  del(key: string): Promise<void>;
  /** 読んで、すぐ消す（1回だけ効く物に使う） */
  getdel(key: string): Promise<string | null>;
  /** 1つ足した数。初めての時だけ期限（秒）を付ける */
  incr(key: string, ex: number): Promise<number>;
  /** 後ろに足し、全体の期限（秒）を付けなおす */
  rpush(key: string, value: string, ex: number): Promise<void>;
  /** 前から count 個取り出す（取り出した物は消える） */
  lpop(key: string, count: number): Promise<string[]>;
  /** 期限（秒）を付けなおす。鍵が無ければ false */
  expire(key: string, ex: number): Promise<boolean>;
}

/** 置き場所がつながっていない（環境変数が無い・止まっている など） */
export class NoStoreError extends Error {}

export function storeEnv(env: Record<string, string | undefined> = process.env): { url: string; token: string } | null {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

/** Upstash の書いた所の印の見出し（返事に付いてくる・次の呼び出しに付けると、その書き込みの後の所から読む） */
export const SYNC_TOKEN_HEADER = "upstash-sync-token";

/**
 * Upstash の REST の窓口で動かす（依存を増やさないため fetch だけで書く）。
 * Upstash は、書くのは元の所・読むのは写しから、のことがある（置いた直後の GET が null で返ることがある）。
 * そこで、返事の見出し upstash-sync-token を覚え、この置き場の次の呼び出しに付ける（Upstash の公式の部品の「Read Your Writes」と同じ）。
 * 返事ごとに新しい値に替え、返事に無ければ前の値のまま。最初の呼び出しには付けない。
 * 覚えるのはこの置き場の中だけ（置き場は窓口の1回の呼び出しごとに作る。プロセス全体では共有しない＝ほかの呼び出しと混ぜない）。
 * なので効くのは「同じ置き場の中で、書いた直後に読む時」だけ。別々に作った置き場の間では引き継がない
 * （例：試験10問の startRun と evalGate は別々に置き場を作るので、そこには効かない）。
 * token を付けるのは、送る窓口（/pipeline）の呼び出し全部。
 */
export function upstashStore(conf = storeEnv(), fetchFn: typeof fetch = (input, init) => fetch(input, init)): KvStore {
  if (!conf) throw new NoStoreError("Redis の環境変数がありません");
  const { url, token } = conf;
  let syncToken: string | null = null;

  async function pipeline(cmds: (string | number)[][]): Promise<unknown[]> {
    let res: Response;
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      if (syncToken) headers[SYNC_TOKEN_HEADER] = syncToken;
      res = await fetchFn(`${url}/pipeline`, {
        method: "POST",
        headers,
        body: JSON.stringify(cmds.map((c) => c.map(String))),
        cache: "no-store",
      });
    } catch {
      throw new NoStoreError("Redis につながりません");
    }
    const next = res.headers.get(SYNC_TOKEN_HEADER);
    if (next) syncToken = next;
    if (!res.ok) throw new NoStoreError(`Redis が ${res.status} を返しました`);
    const out = (await res.json()) as { result?: unknown; error?: string }[];
    return out.map((r) => {
      if (r.error) throw new NoStoreError("Redis の命令がうまくいきませんでした");
      return r.result;
    });
  }
  const one = async (...cmd: (string | number)[]) => (await pipeline([cmd]))[0];
  const str = (x: unknown) => (typeof x === "string" ? x : null);

  return {
    get: async (k) => str(await one("GET", k)),
    set: async (k, v, o) => (await one("SET", k, v, "EX", Math.max(1, Math.ceil(o.ex)), ...(o.nx ? ["NX"] : []))) === "OK",
    del: async (k) => {
      await one("DEL", k);
    },
    getdel: async (k) => str(await one("GETDEL", k)),
    incr: async (k, ex) => {
      const n = Number(await one("INCR", k));
      if (n === 1) await one("EXPIRE", k, Math.max(1, Math.ceil(ex)));
      return n;
    },
    rpush: async (k, v, ex) => {
      await pipeline([
        ["RPUSH", k, v],
        ["EXPIRE", k, Math.max(1, Math.ceil(ex))],
      ]);
    },
    lpop: async (k, count) => {
      const r = await one("LPOP", k, count);
      return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [];
    },
    expire: async (k, ex) => Number(await one("EXPIRE", k, Math.max(1, Math.ceil(ex)))) === 1,
  };
}

/** このプロセスの中だけの置き場所（テスト用）。now で時計を差しかえられる */
export function memoryStore(now: () => number = Date.now): KvStore & { keys(): string[] } {
  const m = new Map<string, { v: string | string[]; until: number }>();
  const live = (k: string) => {
    const e = m.get(k);
    if (e && e.until <= now()) m.delete(k);
    return m.get(k);
  };
  return {
    keys: () => [...m.keys()].filter((k) => live(k)),
    get: async (k) => {
      const e = live(k);
      return e && typeof e.v === "string" ? e.v : null;
    },
    set: async (k, v, o) => {
      if (o.nx && live(k)) return false;
      m.set(k, { v, until: now() + o.ex * 1000 });
      return true;
    },
    del: async (k) => {
      m.delete(k);
    },
    getdel: async (k) => {
      const e = live(k);
      m.delete(k);
      return e && typeof e.v === "string" ? e.v : null;
    },
    incr: async (k, ex) => {
      const e = live(k);
      const n = (e && typeof e.v === "string" ? Number(e.v) : 0) + 1;
      m.set(k, { v: String(n), until: e ? e.until : now() + ex * 1000 });
      return n;
    },
    rpush: async (k, v, ex) => {
      const e = live(k);
      const list = e && Array.isArray(e.v) ? e.v : [];
      m.set(k, { v: [...list, v], until: now() + ex * 1000 });
    },
    lpop: async (k, count) => {
      const e = live(k);
      if (!e || !Array.isArray(e.v)) return [];
      const out = e.v.slice(0, count);
      const rest = e.v.slice(count);
      if (rest.length) m.set(k, { v: rest, until: e.until });
      else m.delete(k);
      return out;
    },
    expire: async (k, ex) => {
      const e = live(k);
      if (!e) return false;
      m.set(k, { v: e.v, until: now() + ex * 1000 });
      return true;
    },
  };
}
