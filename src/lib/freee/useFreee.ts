"use client";

// 画面で使う freee（テスト事業所）のつなぎ。鍵はブラウザの JavaScript からは見えない（HttpOnly の cookie）。
// 画面が持つのは記録（secretairy:freee。明細ごとの状態・取引の番号）だけ。
// つながっているかはサーバー（/api/freee/status）に聞く。cookie が無い画面（審査員の画面も）は「つながっていない」。

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { FREEE_KEY, readBrowser, subscribeBrowser, writeBrowser } from "../browser";
import type { CardUse } from "../data/types";
import { getFreeeSettings } from "../settings";
import { runCheck, runRegister, type Post, type RunDeps } from "./run";
import { hasStarted, isSending, parseFreee, stateOf, type FreeeRecord } from "./state";

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

function runDeps(): RunDeps {
  return {
    read: () => parseFreee(read()),
    write: (r: FreeeRecord) => writeBrowser(FREEE_KEY, JSON.stringify(r)),
    post: freeePost,
    now: () => new Date(),
    staleSeconds: getFreeeSettings().sendingStaleSeconds,
  };
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

async function fetchStatus(): Promise<FreeeStatus> {
  try {
    const res = await fetch("/api/freee/status", { credentials: "same-origin", cache: "no-store" });
    if (res.status === 200) return "connected";
    const b = (await res.json().catch(() => null)) as { code?: unknown } | null;
    const code = b?.code;
    if (code === "expired") return "expired";
    if (code === "no-cookie") return "none";
    if (code === "not-set" || code === "no-company-id" || code === "wrong-company") return code;
    return "off";
  } catch {
    return "off";
  }
}

export function useFreee() {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  const record = useMemo(() => parseFreee(raw), [raw]);
  const running = useSyncExternalStore(subscribeActive, () => active, () => false);
  const [status, setStatus] = useState<FreeeStatus>("loading");
  const settings = getFreeeSettings();

  const refresh = useCallback(async () => setStatus(await fetchStatus()), []);
  useEffect(() => {
    let alive = true;
    void fetchStatus().then((s) => alive && setStatus(s));
    return () => {
      alive = false;
    };
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await freeePost("/api/freee/disconnect");
    } catch {
      // つながらなくても、次の status で分かる
    }
    await refresh();
  }, [refresh]);

  const importStatements = useCallback(async () => {
    try {
      return await freeePost("/api/freee/import");
    } catch {
      return { status: 0, body: null };
    }
  }, []);

  /** 照らし合わせてから、1件ずつ登録する */
  const register = useCallback(
    async (uses: Record<string, CardUse>, nos: number[]) => {
      if (active) return { ok: false as const, reason: "いま送っています" };
      setActive(true);
      try {
        const d = runDeps();
        // 「結果が分からない」の明細は、ここでは読み直さない（送り直さない）。「freee から読み直す」を押した後でだけ送れる
        const first = d.read();
        const checkNos = nos.filter((no) => stateOf(first, no) !== "unknown" && stateOf(first, no) !== "registered" && stateOf(first, no) !== "already");
        if (checkNos.length) {
          const checked = await runCheck(d, checkNos);
          if (!checked.ok) return checked;
        }
        return await runRegister(d, { uses, nos });
      } finally {
        setActive(false);
        void refresh();
      }
    },
    [refresh],
  );

  const check = useCallback(async (nos: number[]) => {
    if (active) return { ok: false as const, reason: "いま送っています" };
    setActive(true);
    try {
      return await runCheck(runDeps(), nos);
    } finally {
      setActive(false);
    }
  }, []);

  const sending = running || isSending(record, Date.now(), settings.sendingStaleSeconds);
  return { record, status, settings, sending, started: hasStarted(record), refresh, disconnect, importStatements, register, check };
}

/** 記録だけ（サーバーには聞かない）。経理の明細の行で、送り始めた後に選びを固定するのに使う */
export function useFreeeLocked(): boolean {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  const on = useSyncExternalStore(subscribeActive, () => active, () => false);
  return useMemo(() => on || hasStarted(parseFreee(raw)), [raw, on]);
}
