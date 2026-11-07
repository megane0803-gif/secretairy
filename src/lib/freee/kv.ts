// freee（テスト事業所）の、サーバーが持ち続けるつながり（docs/SPEC.md §1.8.2）。置き場は LINE・試験・広告と同じ Upstash（KvStore）。
// 置くのは、オーナーが1回つないだ時の鍵（アクセス・更新・期限・事業所の番号・つないだ回の番号）を暗号化した物と、その周りの印だけ：
//   - 鍵：seal の用途 "kv-token"（cookie の "token" と AAD が違うので、cookie の中身を KV に、KV の中身を cookie に入れ替えても読めない）
//   - つないだ回の番号：「つなぐ」で進め、「つなぎを外す」でも進める。番号が変わっていたら、延ばした鍵を書かない・古い鍵は使わない
//   - 延ばす印：同時に1回だけ延ばす（SET NX＋期限・自分の印だけ消す）。更新用の鍵は1回使うと変わるため
//   - 書く時の印：来た人の登録・元に戻す・オーナーの「明細を入れる」と登録が、同じ1つの印を取る（取れなければ「少し待ってから」）
// 鍵の中身は、返事・ログ・画面に出さない。お客様の記録・台帳・日誌はここに置かない。

import { randomBytes } from "node:crypto";
import type { KvStore } from "../line/store";
import type { FreeeSettings } from "../settings";
import { FreeeRejected, refreshAccessToken, type FetchLike } from "./api";
import { seal, unseal } from "./seal";

export const FREEE_KV = {
  token: "freee:kv:token",
  gen: "freee:kv:gen",
  refreshLock: "freee:kv:refresh-lock",
  /** 書く時の「同時に1回」の印（来た人の登録・元に戻す・オーナーの明細を入れる・登録で1つ） */
  writeLock: "freee:write-lock",
  /** 元に戻す記録（来た人が登録した明細と取引の番号・最後に書いた時刻・要復旧の印） */
  trial: "freee:try:trial",
  salt: (date: string) => `freee:try:salt:${date}`,
  count: (kind: "register" | "read" | "restore", scope: string) => `freee:try:n:${kind}:${scope}`,
};

/** 置き場（KV）が読めない・書けない（数えられない・鍵を確かめられないので、受けない） */
export class StoreDown extends Error {}

export async function kv<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch {
    throw new StoreDown("置き場につながりません");
  }
}

/** 置き場に置く鍵（暗号化して置く）。gen はつないだ回の番号 */
export type KvToken = { accessToken: string; refreshToken: string | null; companyId: number; expiresAt: number; gen: number };

export type KvCtx = {
  store: KvStore;
  cookieKey: Buffer;
  settings: FreeeSettings;
  now: () => number;
  random: (n: number) => Buffer;
};

const days = (n: number) => Math.max(1, Math.round(n * 86_400));
const mineOf = (random: (n: number) => Buffer) => random(16).toString("hex");

/**
 * いまのつないだ回の番号（無ければ 0）。
 * 番号は進むだけなので、「変わった」は読んだ番号が自分の番号より大きい時だけと見る（書いた直後の読み直しが、まだ写っていない写しから
 * 古い小さい番号で返っても、変わったとは見ない。同じ置き場の物を使えば upstash-sync-token で書いた所から読む。直しW）。
 */
export const genMovedPast = (current: number, mine: number) => current > mine;

/** いまのつないだ回の番号（無ければ 0） */
export async function currentGen(store: KvStore): Promise<number> {
  const raw = await kv(() => store.get(FREEE_KV.gen));
  const n = Number(raw ?? 0);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** 番号を1つ進める（つなぐ・つなぎを外す） */
export async function advanceGen(c: KvCtx): Promise<number> {
  return kv(() => c.store.incr(FREEE_KV.gen, days(Math.max(c.settings.try.kvTokenDays, c.settings.try.trialKeepDays) * 4)));
}

function parseToken(x: unknown): KvToken | null {
  const t = x as Partial<KvToken> | null;
  if (!t || typeof t !== "object") return null;
  if (typeof t.accessToken !== "string" || !t.accessToken) return null;
  if (t.refreshToken !== null && typeof t.refreshToken !== "string") return null;
  if (typeof t.companyId !== "number" || typeof t.expiresAt !== "number" || typeof t.gen !== "number") return null;
  return { accessToken: t.accessToken, refreshToken: t.refreshToken ?? null, companyId: t.companyId, expiresAt: t.expiresAt, gen: t.gen };
}

/** 置き場の鍵を読む（読めない・形が違う・用途が違う時は null） */
export async function readKvToken(c: KvCtx): Promise<{ token: KvToken; raw: string } | null> {
  const raw = await kv(() => c.store.get(FREEE_KV.token));
  if (!raw) return null;
  const token = parseToken(unseal(c.cookieKey, "kv-token", raw));
  return token ? { token, raw } : null;
}

async function writeToken(c: KvCtx, t: KvToken): Promise<string | null> {
  const raw = seal(c.cookieKey, "kv-token", t, c.random);
  try {
    const ok = await c.store.set(FREEE_KV.token, raw, { ex: days(c.settings.try.kvTokenDays) });
    return ok ? raw : null;
  } catch {
    return null;
  }
}

/** 中身が raw の時だけ消す（ほかの回の鍵を消さない） */
async function delIfSame(c: KvCtx, raw: string): Promise<void> {
  try {
    if ((await c.store.get(FREEE_KV.token)) === raw) await c.store.del(FREEE_KV.token);
  } catch {
    // 消せなくても、番号が合わないので使われない
  }
}

/**
 * オーナーがつないだ時（戻り先）：つないだ回の番号を進めて、鍵を置く。置けたら true。
 * 事業所の番号は、呼ぶ側で FREEE_COMPANY_ID と同じかを確かめてから渡す。
 */
export async function putKvToken(c: KvCtx, t: Omit<KvToken, "gen">): Promise<boolean> {
  try {
    const gen = await advanceGen(c);
    const raw = await writeToken(c, { ...t, gen });
    if (!raw) return false;
    // 書いている間に、ほかの「つなぐ」「つなぎを外す」が番号を進めていたら、書いた鍵を消す
    if (genMovedPast(await currentGen(c.store), gen)) {
      await delIfSame(c, raw);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** つなぎを外す：番号を進めてから鍵を消す（延ばしている途中の物は、番号が合わないので書かれない） */
export async function dropKvToken(c: KvCtx): Promise<void> {
  await advanceGen(c);
  await kv(() => c.store.del(FREEE_KV.token));
}

export type KvAccess = { ok: true; token: KvToken } | { ok: false; why: "none" | "busy" };

/**
 * 来た人用の窓口で使う鍵。期限の refreshMarginSeconds 秒前から、更新用の鍵で延ばす（同時に1回だけ）。
 * - 延ばしている最中（印が取れない）：今の鍵がまだ切れていなければそれを使い、切れていれば busy（少し待ってから）
 * - 延ばした新しい鍵は、使う前に置き場に書く。書けなければ、古い更新用の鍵はもう使えないので、つながっていない扱い（鍵を消す）
 * - 番号が変わっていたら（延ばしている途中につなぎを外された）、延ばした鍵は書かずに捨てる
 * - freee が更新を受けなかった：鍵を消して、つながっていない扱い（自分でつなぎ直そうとしない）
 */
export async function kvAccess(c: KvCtx & { fetch: FetchLike; clientId: string; clientSecret: string; companyId: number }): Promise<KvAccess> {
  const got = await readKvToken(c);
  if (!got) return { ok: false, why: "none" };
  let { token: t } = got;
  let raw = got.raw;
  const seen = await currentGen(c.store);
  // 鍵の番号より新しい番号が読めたら、もう外された（つなぎ直された）鍵。古い番号しか読めない時は鍵の番号を使う
  if (t.companyId !== c.companyId || genMovedPast(seen, t.gen)) return { ok: false, why: "none" };
  const gen = t.gen;
  const now = c.now();
  const margin = c.settings.try.refreshMarginSeconds * 1000;
  if (t.expiresAt - margin > now) return { ok: true, token: t };
  const usable = t.expiresAt > now;
  if (!t.refreshToken) return usable ? { ok: true, token: t } : { ok: false, why: "none" };

  const mine = mineOf(c.random);
  const locked = await kv(() => c.store.set(FREEE_KV.refreshLock, mine, { ex: c.settings.try.refreshLockSeconds, nx: true }));
  if (!locked) return usable ? { ok: true, token: t } : { ok: false, why: "busy" };
  try {
    // 印を取る前に、ほかの呼び出しが延ばし終えていたかもしれない（読み直す）
    const again = await readKvToken(c);
    if (!again || again.token.companyId !== c.companyId || genMovedPast(again.token.gen, gen) || genMovedPast(await currentGen(c.store), gen)) return { ok: false, why: "none" };
    if (again.token.gen < gen) return { ok: true, token: t }; // 古い写しが読めた：前に読んだ鍵のまま
    t = again.token;
    raw = again.raw;
    if (t.expiresAt - margin > c.now()) return { ok: true, token: t };
    if (!t.refreshToken) return t.expiresAt > c.now() ? { ok: true, token: t } : { ok: false, why: "none" };

    let ans;
    try {
      ans = await refreshAccessToken({ fetch: c.fetch, settings: c.settings, clientId: c.clientId, clientSecret: c.clientSecret, refreshToken: t.refreshToken });
    } catch (e) {
      if (e instanceof FreeeRejected) {
        // 消さない：ほかの呼び出しがもう延ばして新しい鍵を置いたのに、こちらは古い写しを読んで古い更新用の鍵を送ったのかもしれない
        // （消すと、その新しい鍵まで消してしまう）。この呼び出しはつながっていない扱い。本当に使えなければ、オーナーがつなぎ直す
        return { ok: false, why: "none" };
      }
      // 返事が無い：更新用の鍵が使われたかどうか分からない。今の鍵が切れていなければそれを使う（次に延ばす時に freee が決める）
      return t.expiresAt > c.now() ? { ok: true, token: t } : { ok: false, why: "none" };
    }
    if (ans.companyId !== null && ans.companyId !== c.companyId) {
      await delIfSame(c, raw);
      return { ok: false, why: "none" };
    }
    const next: KvToken = {
      accessToken: ans.accessToken,
      refreshToken: ans.refreshToken,
      companyId: t.companyId,
      expiresAt: c.now() + Math.min(ans.expiresIn, c.settings.maxTokenSeconds) * 1000,
      gen,
    };
    // 書く前に番号を確かめる（つなぎを外された後なら、延ばした鍵は捨てる）
    if (genMovedPast(await currentGen(c.store), gen)) return { ok: false, why: "none" };
    const wrote = await writeToken(c, next);
    if (!wrote) {
      // 延ばせたのに書けない：古い更新用の鍵はもう使えない。つながっていない扱い
      await delIfSame(c, raw);
      return { ok: false, why: "none" };
    }
    // 書いている間につなぎを外されたら、書いた鍵を消す
    if (genMovedPast(await currentGen(c.store), gen)) {
      await delIfSame(c, wrote);
      return { ok: false, why: "none" };
    }
    return { ok: true, token: next };
  } finally {
    try {
      if ((await c.store.get(FREEE_KV.refreshLock)) === mine) await c.store.del(FREEE_KV.refreshLock);
    } catch {
      // 消せなくても期限で消える
    }
  }
}

/**
 * freee が鍵を受けなかった（401）：次の呼び出しで延ばすように、置き場の鍵を「切れた」にする（同じ鍵の時だけ）。
 * 延ばす所と同じ順：書く前と書いた後につないだ回の番号を確かめ、書いた後に変わっていたら自分が書いた物を消す。
 */
export async function markKvExpired(c: KvCtx, accessToken: string): Promise<void> {
  try {
    const got = await readKvToken(c);
    if (!got || got.token.accessToken !== accessToken) return;
    if (genMovedPast(await currentGen(c.store), got.token.gen)) return;
    const wrote = await writeToken(c, { ...got.token, expiresAt: 0 });
    if (wrote && genMovedPast(await currentGen(c.store), got.token.gen)) await delIfSame(c, wrote);
  } catch {
    // 書けなくても、次の呼び出しでまた 401 になるだけ
  }
}

/** 書く時の印の期限（持ち時間と1回の待ち時間より必ず長く） */
export function writeLockSeconds(s: FreeeSettings): number {
  return Math.max(s.try.lockSeconds, s.serverBudgetSeconds + s.timeoutSeconds + 15);
}

/** 書く直前に呼ぶ：印がまだ自分の物か（置き場の時計で期限が来ていたら false。その時は書かない） */
export type StillHeld = () => Promise<boolean>;

/**
 * 書く時の「同時に1回」の印を取って中身を動かす。取れなければ "busy"。終わったら自分の印だけ消す。
 * run には印の期限（ms）と、印がまだ自分の物かを確かめる口（held）を渡す。中で freee を呼ぶ時は、この期限より前に返事を待ち終える
 * 締め切りにし（期限の後に書かない）、書く直前に held() で確かめる（置き場の時計がこちらより早く進んでいても、期限の後に書かない）。
 */
export async function withWriteLock<T>(
  c: { store: KvStore; settings: FreeeSettings; now: () => number; random: (n: number) => Buffer },
  run: (lockUntil: number, held: StillHeld) => Promise<T>,
): Promise<T | "busy"> {
  const mine = mineOf(c.random ?? randomBytes);
  const seconds = writeLockSeconds(c.settings);
  const got = await kv(() => c.store.set(FREEE_KV.writeLock, mine, { ex: seconds, nx: true }));
  if (!got) return "busy";
  const until = c.now() + seconds * 1000;
  const held: StillHeld = async () => {
    if (c.now() >= until - 1000) return false;
    try {
      // 自分の値の時だけ（期限で消えた null・ほかの呼び出しが取った値なら書かない）。同じ置き場の物で読むので、
      // 書いた直後でも書いた所から読む（upstash-sync-token。直しW）
      return (await c.store.get(FREEE_KV.writeLock)) === mine;
    } catch {
      return false;
    }
  };
  try {
    return await run(until, held);
  } finally {
    try {
      if ((await c.store.get(FREEE_KV.writeLock)) === mine) await c.store.del(FREEE_KV.writeLock);
    } catch {
      // 消せなくても期限で消える
    }
  }
}
