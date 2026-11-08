"use client";

// 画面で使う freee（テスト事業所）のつなぎ。鍵はブラウザの JavaScript からは見えない（HttpOnly の cookie）。
// 画面が持つのは記録（secretairy:freee。明細ごとの状態・取引の番号）だけ。
// つながっているかはサーバー（/api/freee/status）に聞く。cookie が無い画面（審査員の画面も）は「つながっていない」。
// freee から読んだ明細の一覧は、画面のメモリの中だけに持つ（ブラウザには書かない）。読みに行くのは、経理のタブを開いた時
// （つながっている答えを受けた時に1回）と「freee から読み直す」を押した時だけ（自動で何度も読みに行かない）。

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { FREEE_KEY, readBrowser, subscribeBrowser, writeBrowser } from "../browser";
import type { CardUse } from "../data/types";
import { getFreeeSettings } from "../settings";
import {
  pressCheck,
  pressImport,
  pressRegister,
  recoverIfIdle,
  withFreeeLock,
  BUSY_REASON,
  type CheckOutcome,
  type FreeeList,
  type LockLike,
  type Post,
  type RegisterTarget,
  type RunDeps,
} from "./run";
import { hasStarted, importHeld, isSending, parseFreee, recordKeys, stateOf, withLinked, type FreeeRecord } from "./state";
import { reuseOpenRead, tryRead, tryRegister, type TryInfo, type TryRead, type TryRegisterOutcome } from "./tryClient";

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

// ---- freee から読んだ一覧（画面のメモリの中だけ） ----

/** 一覧の読み方の状態。idle：まだ読んでいない・loading：読んでいる・ok：読めた・error：読めなかった（架空の明細には切り替えない） */
export type FreeeListState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ok"; list: FreeeList }
  | { phase: "error"; reason: string; reconnect: boolean };

let listState: FreeeListState = { phase: "idle" };
const listListeners = new Set<() => void>();
function setList(x: FreeeListState) {
  listState = x;
  listListeners.forEach((f) => f());
}
const subscribeList = (f: () => void) => {
  listListeners.add(f);
  return () => listListeners.delete(f);
};

/** freee から読めなかった時の1行（理由を括弧に）。カードの口座が無い時は、つなぎ直しても直らないので「つなぐ」は言わない */
export function listErrorText(reason: string, reconnect: boolean): string {
  const why = reason.replace(/。?もう一度 freee とつないでください。?$/, "").replace(/[。.]+$/, "");
  return `freee から読めませんでした（${why}）。${reconnect ? "もう一度 freee とつないでください" : ""}`;
}

/** 読み直しの答えが「つなぎ直しが要る」か（カードの口座が無い時と、ほかのタブでやりとりしている時以外） */
export const needsReconnect = (reason: string, cardName: string) => !reason.includes(`「${cardName}」`) && reason !== BUSY_REASON && !reason.startsWith("いま freee と");

// ---- つながっているか（同じ画面の部品で1つを共有する） ----

let statusState: FreeeStatusAnswer = { status: "loading", missing: [] };
const statusListeners = new Set<() => void>();
function setStatus(x: FreeeStatusAnswer) {
  statusState = x;
  statusListeners.forEach((f) => f());
}
const subscribeStatus = (f: () => void) => {
  statusListeners.add(f);
  return () => statusListeners.delete(f);
};

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
    onList: (list) => setList({ phase: "ok", list }),
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
export type FreeeStatusAnswer = {
  status: FreeeStatus;
  missing: string[];
  /** つながっている時：サーバーもつながりを持っているか（来た人も試せるか）。分からなければ null */
  shared?: boolean | null;
  /** つながっている時：サーバーの鍵を freee が延ばすのを断った（来た人は試せない。つなぎ直してください） */
  dead?: boolean;
  /** つながっている時：来た人の試しの記録（要復旧・まだ元に戻していない） */
  trial?: "repair" | "pending" | null;
};

/**
 * サーバーの答えを読む。cookie が無い・切れた時は「つながっていない」（none / expired）。
 * 環境変数が本当に欠けている時は、その名前（missing）も読む。画面のテストでも同じ物を使う。
 */
export function readStatusAnswer(httpStatus: number, body: unknown): FreeeStatusAnswer {
  if (httpStatus === 200) {
    const ok = body as { shared?: unknown; dead?: unknown; trial?: unknown } | null;
    return {
      status: "connected",
      missing: [],
      shared: typeof ok?.shared === "boolean" ? ok.shared : null,
      dead: ok?.dead === true,
      trial: ok?.trial === "repair" || ok?.trial === "pending" ? ok.trial : null,
    };
  }
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
    const body = await res.json().catch(() => null);
    return readStatusAnswer(res.status, body);
  } catch {
    return { status: "off", missing: [] };
  }
}

/** freee から読み直す（一覧を入れかえ、記録の明細を照らし合わせる）。読めなかった時は理由を出す（架空の明細には切り替えない） */
async function loadList(): Promise<CheckOutcome | { ok: false; reason: string }> {
  setList({ phase: "loading" });
  const r = await pressed((d) => {
    // 照らし合わせるのは、まだ済んでいない記録の明細だけ（登録した・もう処理済みは入れない）
    const rec = d.read();
    const keys = recordKeys(rec).filter((k) => !["registered", "already"].includes(stateOf(rec, k)));
    return pressCheck(d, keys.slice(-getFreeeSettings().maxListRows));
  });
  if (r.ok) return r;
  setList({ phase: "error", reason: r.reason, reconnect: needsReconnect(r.reason, getFreeeSettings().cardName) });
  return r;
}

// ---- 来た人がそのまま試す（cookie が無い画面。サーバーがつながりを持っている時だけ。§1.8.2） ----

/**
 * on：来た人の窓口から読めた（一覧と登録の欄を freee の側にする）。line：つながっていない時の1行（アプリの中の明細のまま）。
 * 画面のメモリの中だけに持つ（ブラウザには書かない。試しの様子はサーバーが毎回返す）。
 */
export type FreeeTryState = { on: boolean; info: TryInfo | null; line: string | null; busy: boolean };

let tryState: FreeeTryState = { on: false, info: null, line: null, busy: false };
const tryListeners = new Set<() => void>();
function setTry(x: Partial<FreeeTryState>) {
  tryState = { ...tryState, ...x };
  tryListeners.forEach((f) => f());
}
const subscribeTry = (f: () => void) => {
  tryListeners.add(f);
  return () => tryListeners.delete(f);
};

/** この画面で、来た人の窓口から最後に読めた時刻（画面のメモリの中だけ。開いた時の読むを省くかに使う） */
let lastTryOkAt: number | null = null;

/** 来た人の読む・読み直すの答えを、一覧と試しの様子に入れる */
function applyTryRead(r: TryRead): void {
  if (r.kind === "ok") {
    lastTryOkAt = Date.now();
    setTry({ on: true, info: r.info, line: null });
    setList({ phase: "ok", list: r.list });
  } else if (r.kind === "not-connected") {
    // 試していた途中（on）なら、一覧は架空の明細に切り替えず理由を出す
    if (tryState.on) setList({ phase: "error", reason: r.message, reconnect: false });
    setTry({ line: r.message, info: tryState.on ? tryState.info : null });
  } else if (r.kind === "error") {
    if (tryState.on) setList({ phase: "error", reason: r.message, reconnect: false });
    else setTry({ line: null });
  }
}

const nowIso = () => new Date().toISOString();

/** 来た人：読む・読み直す（押した時と、経理のタブを開いた時だけ。自動で何度も呼ばない） */
export async function tryReload(): Promise<TryRead> {
  if (tryState.busy) return { kind: "error", message: "いまやりとりしています" };
  setTry({ busy: true });
  if (tryState.on) setList({ phase: "loading" });
  try {
    const r = await tryRead(freeePost, nowIso);
    applyTryRead(r);
    return r;
  } finally {
    setTry({ busy: false });
  }
}

/** 来た人：1件を登録して、1回だけ読み直す（結果が分からない時は呼び直さない） */
export async function tryRegisterOne(p: { id: number; use: CardUse; label: string }): Promise<TryRegisterOutcome> {
  if (tryState.busy) return { result: "failed", message: "いまやりとりしています", read: null };
  setTry({ busy: true });
  try {
    const r = await tryRegister(freeePost, p, nowIso);
    if (r.read) applyTryRead(r.read);
    return r;
  } finally {
    setTry({ busy: false });
  }
}

export function useFreeeTry(): FreeeTryState {
  return useSyncExternalStore(subscribeTry, () => tryState, () => tryState);
}

/** 「つなぎを外す」がうまくいかなかった時の1行（サーバーの文が無い時） */
export const DISCONNECT_FAILED_NOTE = "サーバーの鍵を消せませんでした。少し待ってから、もう一度押してください";

let opening: Promise<void> | null = null;

/** 経理のタブを開いた時：つながっているかを聞き、つながっていれば1回だけ freee から読む */
function openAccounting(): Promise<void> {
  if (opening) return opening;
  opening = (async () => {
    const a = await fetchStatus();
    setStatus(a);
    const rec = parseFreee(read());
    if (a.status === "connected") {
      if (!rec.linked) writeBrowser(FREEE_KEY, JSON.stringify(withLinked(parseFreee(read()), true)));
      await loadList();
    } else if (a.status === "none" && !rec.linked && !hasStarted(rec)) {
      // cookie が無い画面（来た人も）：サーバーがつながりを持っていれば、来た人の窓口から読む。
      // この画面で少し前に読めたばかりなら、開いた時の読むは省く（タブの行き来で回数を使わない。「読み直す」は省かない）
      if (tryState.on && reuseOpenRead(lastTryOkAt, Date.now(), getFreeeSettings().try.openReuseSeconds, tryState.info)) return;
      await tryReload();
      if (!tryState.on) setList({ phase: "idle" });
    } else if (a.status === "expired" || a.status === "none") {
      setList({ phase: "error", reason: a.status === "expired" ? "freee の鍵が切れました" : "freee とつながっていません", reconnect: true });
    } else setList({ phase: "idle" });
  })().finally(() => {
    opening = null;
  });
  return opening;
}

/** つながっているか（同じ画面の部品で共有する。聞きに行くのは経理のタブを開いた時と、押した後） */
export function useFreeeStatus(): FreeeStatusAnswer {
  return useSyncExternalStore(subscribeStatus, () => statusState, () => statusState);
}

/** freee から読んだ一覧の状態（画面のメモリの中だけ） */
export function useFreeeList(): FreeeListState {
  return useSyncExternalStore(subscribeList, () => listState, () => listState);
}

/** 記録（このブラウザの中）。つながった印・送り始めたか・固定した選び */
export function useFreeeRecord(): FreeeRecord {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  return useMemo(() => parseFreee(raw), [raw]);
}

/**
 * 明細の一覧と登録の欄を freee の側にするか：つながっている・つながった印がある（鍵が切れても黙って架空の明細に切り替えない）・送り始めた記録がある。
 * それ以外（cookie が無い画面・審査員の画面も）は、アプリの中の架空の明細と「会計に登録」。
 */
export function freeeMode(status: FreeeStatus, record: FreeeRecord): boolean {
  if (status === "off") return false;
  return status === "connected" || record.linked || hasStarted(record);
}

/** 経理の画面が freee の側か（真ん中の一覧と右の列で同じ答え） */
export function useFreeeMode(): boolean {
  const a = useFreeeStatus();
  const record = useFreeeRecord();
  const t = useFreeeTry();
  return freeeMode(a.status, record) || (t.on && a.status !== "connected");
}

/** 来た人の試しの画面か（オーナーのブラウザ（cookie がある・つながった印・送り始めた記録）では false） */
export function useTryMode(): boolean {
  const a = useFreeeStatus();
  const record = useFreeeRecord();
  const t = useFreeeTry();
  return t.on && !freeeMode(a.status, record);
}

export function useFreee() {
  const record = useFreeeRecord();
  const running = useSyncExternalStore(subscribeActive, () => active, () => false);
  const answer = useFreeeStatus();
  const status = answer.status;
  const settings = getFreeeSettings();

  const refresh = useCallback(async () => setStatus(await fetchStatus()), []);
  useEffect(() => {
    // 経理のタブを開いた時：つながっているかを聞き、つながっていれば freee から1回読む
    void openAccounting();
    // 開いた時：排他が空いていれば、前に止まった「送っている」を「結果が分からない」にする（読み込み直した時も）
    void recoverIfIdle(runDeps());
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

  /**
   * 「つなぎを外す」。サーバーが外せた（200）時だけ ok。置き場が使えない（503）・来た人が書いている（409）・つながらない時は、
   * cookie も画面の印もそのまま（もう一度押せる）。
   */
  const disconnect = useCallback(async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
    let res: { status: number; body: unknown | null } | null = null;
    try {
      res = await freeePost("/api/freee/disconnect");
    } catch {
      res = null;
    }
    const b = res?.body as { ok?: unknown; message?: unknown } | null;
    if (!res || res.status !== 200 || b?.ok !== true) {
      const m = typeof b?.message === "string" && b.message ? b.message.slice(0, 200) : DISCONNECT_FAILED_NOTE;
      await refresh();
      return { ok: false, reason: m };
    }
    // オーナーが自分で外した：つながった印を外す（一覧は架空の明細に戻る。送り始めた記録があれば freee の欄のまま）
    writeBrowser(FREEE_KEY, JSON.stringify(withLinked(parseFreee(read()), false)));
    setList({ phase: "idle" });
    await refresh();
    return { ok: true };
  }, [refresh]);

  /** 「freee に明細を入れる」（排他の中。結果が分からない時は待つ期限を残す）。一覧は読み直さない（「freee から読み直す」で） */
  const importStatements = useCallback(async () => {
    const r = await pressed((d) => pressImport(d));
    void refresh();
    return r;
  }, [refresh]);

  /** 照らし合わせてから、1件ずつ登録する（排他の中） */
  const register = useCallback(
    async (uses: Record<string, CardUse>, targets: RegisterTarget[]) => {
      const r = await pressed((d) => pressRegister(d, { uses, targets }));
      void refresh();
      return r;
    },
    [refresh],
  );

  /** 「freee から読み直す」：一覧を入れかえ、記録の明細を照らし合わせる（排他の中・書かない） */
  const check = useCallback(async () => loadList(), []);

  const nowMs = Date.now();
  const sending = running || isSending(record, nowMs, settings.sendingStaleSeconds);
  const importWait = importHeld(record, nowMs) ? record.importHold : null;
  return { record, status, missing: answer.missing, shared: answer.shared ?? null, dead: answer.dead === true, trial: answer.trial ?? null, canConnect: showConnect(answer), settings, sending, importWait, started: hasStarted(record), refresh, disconnect, importStatements, register, check };
}

/** 記録だけ（サーバーには聞かない）。経理の明細の行で、送っている間は選びを止めるのに使う（固定した明細は isFixed で） */
export function useFreeeBusy(): boolean {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  const on = useSyncExternalStore(subscribeActive, () => active, () => false);
  return useMemo(() => on || isSending(parseFreee(raw), Date.now(), getFreeeSettings().sendingStaleSeconds), [raw, on]);
}

/** 「最初に戻す」の確かめの文に、freee の記録が残ると出すか */
export function useFreeeStarted(): boolean {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  return useMemo(() => hasStarted(parseFreee(raw)), [raw]);
}
