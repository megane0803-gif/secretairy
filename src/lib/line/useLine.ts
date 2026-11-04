"use client";

// 画面で使う LINE のつなぎ。このブラウザの中の物（state.ts）と、窓口（/api/line/*・/api/ai/line）を呼ぶ所。
// 印（token）は窓口に送るだけで、画面・日誌には出さない。

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { LINE_KEY, readBrowser, subscribeBrowser, writeBrowser } from "../browser";
import type { LineAskRequest, LineAskResponse } from "./ask";
import { parseLine, type LineState } from "./state";
import type { LinkStartResponse, PollResponse, SendRequest, SendResponse } from "./wire";

const read = () => readBrowser(LINE_KEY);

export function readLineState(): LineState | null {
  return parseLine(read());
}

/** 書く直前に読みなおす（別の窓で変えた分を消さないように）。null を返すと消す */
export function updateLineState(f: (s: LineState | null) => LineState | null): void {
  const next = f(readLineState());
  writeBrowser(LINE_KEY, next ? JSON.stringify(next) : null);
}

export function useLineState() {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  const state = useMemo(() => parseLine(raw), [raw]);
  const update = useCallback(updateLineState, []);
  return { state, update };
}

// ---- 画面を開いている間だけの様子（うまくいかなかった1文・最後にしたこと） ----

export type LineStatus = { problem: string | null; last: string | null };
let status: LineStatus = { problem: null, last: null };
const listeners = new Set<() => void>();

export function setLineStatus(p: Partial<LineStatus>): void {
  status = { ...status, ...p };
  listeners.forEach((f) => f());
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

export function useLineStatus(): LineStatus {
  return useSyncExternalStore(subscribe, () => status, () => status);
}

// ---- 窓口 ----

async function post<T>(url: string, body: unknown, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}

const offline = { ok: false as const, code: "failed" as const, message: "つながりませんでした" };

export const lineApi = {
  start: (token?: string, passcode?: string) => post<LinkStartResponse>("/api/line/link", { action: "start", token, passcode }, offline),
  unlink: (token: string) => post<{ ok: boolean }>("/api/line/link", { action: "unlink", token }, { ok: false }),
  /** 「最初に戻す」：サーバーに預けてある、まだ受け取っていない LINE の知らせを消す */
  clear: (token: string) => post<{ ok: boolean }>("/api/line/link", { action: "clear", token }, { ok: false }),
  poll: (token: string) => post<PollResponse>("/api/line/poll", { token }, offline),
  send: (req: SendRequest) => post<SendResponse>("/api/line/send", req, offline),
  ask: (req: LineAskRequest) => post<LineAskResponse>("/api/ai/line", req, { ok: false, code: "no-ai", message: "つながりませんでした" }),
};

/** 窓口の答えを、画面に出すやさしい1文にする */
export function problemText(code: string, message: string): string {
  switch (code) {
    case "no-store":
      return "LINE の預かり場所（Redis）につながりません。Vercel の Redis の設定を確かめてください";
    case "no-line":
      return "LINE の鍵がありません。Vercel の環境変数（LINE_CHANNEL_ACCESS_TOKEN）を確かめてください";
    case "limit":
      return `${message}。明日になるとまた送れます（返事はいつでも返せます）`;
    case "passcode":
      return `${message}。オーナー用の合言葉（Vercel の環境変数 LINE_OWNER_PASSCODE に入れた物）を入れてください`;
    case "gone":
    case "not-linked":
      return "LINE とのつながりが切れています。もう一度「LINE とつなぐ」を押してください";
    default:
      return `うまくいきませんでした。${message}。少し待ってからもう一度押してください`;
  }
}
