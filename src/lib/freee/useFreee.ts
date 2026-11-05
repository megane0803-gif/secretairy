"use client";

// 画面で使う freee（テスト事業所）のつなぎ。鍵はブラウザの JavaScript からは見えない（HttpOnly の cookie）。
// 画面が持つのは記録（secretairy:freee。明細ごとの状態・取引の番号）だけ。
// つながっているかはサーバー（/api/freee/status）に聞く。cookie が無い画面（審査員の画面も）は「つながっていない」。

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { FREEE_KEY, readBrowser, subscribeBrowser, writeBrowser } from "../browser";
import type { CardUse } from "../data/types";
import { getFreeeSettings } from "../settings";
import { pressCheck, pressImport, pressRegister, recoverIfIdle, withFreeeLock, type LockLike, type Post, type RunDeps } from "./run";
import { hasStarted, importHeld, isSending, parseFreee, type FreeeRecord } from "./state";

export type FreeeStatus = "loading" | "connected" | "none" | "expired" | "off" | "not-set" | "no-company-id" | "wrong-company";

const read = () => readBrowser(FREEE_KEY);

/** いまの記録を読む（送った直後の数を見る） */
export function readFreeeRecord(): FreeeRecord {
  return parseFreee(read());
}

export const freeePost: Post = async (path, body) => {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? "" : JSON.stringify(body),
  });
  let b: unknown = null;
  try {
    b = await res.json();
  } catch {
    b = null;
  }
  return { status: res.status, body: b };
};

// この画面（タブ）の中で、同時に2回は流さない
let active = false;
const activeListeners = new Set<() => void>();
const setActive = (on: boolean) => {
  active = on;
  activeListeners.forEach((f) => f());
};
const subscribeActive = (f: () => void) => {
  activeListeners.add(f);
  return () => activeListeners.delete(f);
};

/** 同じブラウザのタブどうしの排他（Web Locks）。使えないブラウザでは null（このタブの中だけで止める） */
function browserLocks(): LockLike | null {
  try {
    const l = (navigator as Navigator & { locks?: LockLike }).locks;
    return l && typeof l.request === "function" ? l : null;
  } catch {
    return null;
  }
}

function runDeps(): RunDeps {
  const s = getFreeeSettings();
  return {
    read: () => parseFreee(read()),
    write: (r: FreeeRecord) => writeBrowser(FREEE_KEY, JSON.stringify(r)),
    post: freeePost,
    now: () => new Date(),
    staleSeconds: s.sendingStaleSeconds,
    locks: browserLocks(),
    importWaitSeconds: s.importUnknownWaitSeconds,
    maxImportCalls: s.maxImportCalls,
  };
}

/** このタブで押した物を、排他の中で動かす（タブの中の印も立てる） */
async function pressed<T>(fn: (d: RunDeps) => Promise<T>): Promise<T | { ok: false; reason: string }> {
  if (active) return { ok: false, reason: "いま freee とやりとりしています" };
  setActive(true);
  try {
    return await fn(runDeps());
  } finally {
    setActive(false);
  }
}

/**
 * 「最初に戻す」を freee の排他の中で動かす（送っている間・ほかのタブが送っている間は戻さない）。
 * 戻したら true。
 */
export async function resetUnderFreeeLock(reset: () => void): Promise<boolean> {
  if (active) return false;
  const r = await withFreeeLock(browserLocks(), async () => {
    reset();
    return true as const;
  });
  return r === true;
}

/** いま freee に送っているか（「最初に戻す」を止める。ほかのタブで送っている時も） */
export function freeeSendingNow(): boolean {
  return active || isSending(parseFreee(read()), Date.now(), getFreeeSettings().sendingStaleSeconds);
}

/** 「最初に戻す」で消してよいか、の印を見るための小さな hook（ResetBook で使う） */
export function useFreeeSending(): boolean {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  const on = useSyncExternalStore(subscribeActive, () => active, () => false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 5000);
    return () => window.clearInterval(id);
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => on || isSending(parseFreee(raw), Date.now(), getFreeeSettings().sendingStaleSeconds), [raw, on, tick]);
}

/** つながっているか（サーバーの答え）と、サーバーが読めていない環境変数の名前（中身は来ない） */
export type FreeeStatusAnswer = { status: FreeeStatus; missing: string[] };

/**
 * サーバーの答えを読む。cookie が無い・切れた時は「つながっていない」（none / expired）。
 * 環境変数が本当に欠けている時は、その名前（missing）も読む。画面のテストでも同じ物を使う。
 */
export function readStatusAnswer(httpStatus: number, body: unknown): FreeeStatusAnswer {
  if (httpStatus === 200) return { status: "connected", missing: [] };
  const b = body as { code?: unknown; missing?: unknown } | null;
  const missing = Array.isArray(b?.missing) ? b.missing.filter((x): x is string => typeof x === "string").slice(0, 10) : [];
  const code = b?.code;
  if (code === "expired") return { status: "expired", missing };
  if (code === "no-cookie") return { status: "none", missing };
  if (code === "not-set" || code === "no-company-id" || code === "wrong-company") return { status: code, missing };
  return { status: "off", missing: [] };
}

/** 「オーナー用」の「freee とつなぐ」を出すか：つながっていない（cookie が無い・切れた）・事業所の番号がまだ空・環境変数が読めていない時 */
export function showConnect(a: FreeeStatusAnswer): boolean {
  return a.status === "none" || a.status === "expired" || a.status === "no-company-id" || (a.status === "not-set" && a.missing.length > 0);
}

async function fetchStatus(): Promise<FreeeStatusAnswer> {
  try {
    const res = await fetch("/api/freee/status", { credentials: "same-origin", cache: "no-store" });
    const body = res.status === 200 ? null : await res.json().catch(() => null);
    return readStatusAnswer(res.status, body);
  } catch {
    return { status: "off", missing: [] };
  }
}

export function useFreee() {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  const record = useMemo(() => parseFreee(raw), [raw]);
  const running = useSyncExternalStore(subscribeActive, () => active, () => false);
  const [answer, setAnswer] = useState<FreeeStatusAnswer>({ status: "loading", missing: [] });
  const status = answer.status;
  const settings = getFreeeSettings();

  const refresh = useCallback(async () => setAnswer(await fetchStatus()), []);
  useEffect(() => {
    let alive = true;
    void fetchStatus().then((s) => alive && setAnswer(s));
    // 開いた時：排他が空いていれば、前に止まった「送っている」を「結果が分からない」にする（読み込み直した時も）
    void recoverIfIdle(runDeps());
    return () => {
      alive = false;
    };
  }, []);

  // 送っている印が古くなる時刻（sendingAt＋120秒）と、明細を入れるのを待つ期限で、描き直す
  const [, setTick] = useState(0);
  useEffect(() => {
    const times: number[] = [];
    if (record.sendingAt) times.push(Date.parse(record.sendingAt) + settings.sendingStaleSeconds * 1000 + 500);
    if (record.importHold) times.push(Date.parse(record.importHold.until) + 500);
    const ids = times
      .filter((x) => Number.isFinite(x))
      .map((x) =>
        window.setTimeout(() => {
          void recoverIfIdle(runDeps());
          setTick((n) => n + 1);
        }, Math.max(0, x - Date.now())),
      );
    return () => ids.forEach((id) => window.clearTimeout(id));
  }, [record.sendingAt, record.importHold, settings.sendingStaleSeconds]);

  const disconnect = useCallback(async () => {
    try {
      await freeePost("/api/freee/disconnect");
    } catch {
      // つながらなくても、次の status で分かる
    }
    await refresh();
  }, [refresh]);

  /** 「freee に明細を入れる」（排他の中。結果が分からない時は待つ期限を残す） */
  const importStatements = useCallback(async () => {
    const r = await pressed((d) => pressImport(d));
    void refresh();
    return r;
  }, [refresh]);

  /** 照らし合わせてから、1件ずつ登録する（排他の中） */
  const register = useCallback(
    async (uses: Record<string, CardUse>, nos: number[]) => {
      const r = await pressed((d) => pressRegister(d, { uses, nos }));
      void refresh();
      return r;
    },
    [refresh],
  );

  /** freee から読み直して照らし合わせる（排他の中・書かない） */
  const check = useCallback(async (nos: number[]) => pressed((d) => pressCheck(d, nos)), []);

  const nowMs = Date.now();
  const sending = running || isSending(record, nowMs, settings.sendingStaleSeconds);
  const importWait = importHeld(record, nowMs) ? record.importHold : null;
  return { record, status, missing: answer.missing, canConnect: showConnect(answer), settings, sending, importWait, started: hasStarted(record), refresh, disconnect, importStatements, register, check };
}

/** 記録だけ（サーバーには聞かない）。経理の明細の行で、送り始めた後（選びを固定した後）に選びを止めるのに使う */
export function useFreeeLocked(): boolean {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  const on = useSyncExternalStore(subscribeActive, () => active, () => false);
  return useMemo(() => on || parseFreee(raw).uses !== null, [raw, on]);
}

/** 「最初に戻す」の確かめの文に、freee の記録が残ると出すか */
export function useFreeeStarted(): boolean {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  return useMemo(() => hasStarted(parseFreee(raw)), [raw]);
}
