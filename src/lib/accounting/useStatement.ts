"use client";

// 画面で使う経理の明細の一覧（真ん中の一覧と右の列で同じ物）。
// freee の側（つながっている・つながった印がある・送り始めた記録がある）は freee から読んだ一覧、それ以外はアプリの中の架空の明細。
// freee から読めなかった時・まだ読んでいる時は、黙って架空の明細に切り替えない（phase で出し分ける）。

import { useCallback, useMemo } from "react";
import type { CardUse } from "../data/types";
import { isFixed } from "../freee/state";
import { useFreeeBusy, useFreeeList, useFreeeMode, useFreeeRecord, useFreeeStatus, useTryMode, type FreeeListState } from "../freee/useFreee";
import { getFreeeSettings } from "../settings";
import { withAutoNext, withChoice, withLiveAutoNext, withLiveChoice } from "./state";
import { useAccounting } from "./useAccounting";
import { liveView, seedView, type StatementView } from "./view";

export type StatementPhase =
  | { phase: "seed" }
  | { phase: "loading" }
  | { phase: "error"; reason: string; reconnect: boolean }
  | { phase: "ok"; capped: boolean; bank: string | null; range: { from: string; to: string } };

export function useStatement() {
  const acct = useAccounting();
  const record = useFreeeRecord();
  const list = useFreeeList();
  // 来た人の試し（cookie が無い画面で、サーバーがつながりを持っている時）は、つながっている扱いで一覧を出す。
  // 試すのは右の列で1件ずつなので、真ん中の一覧の店用／私用は選べない（見るだけ）
  const tryMode = useTryMode();
  const realStatus = useFreeeStatus().status;
  const status = tryMode ? "connected" : realStatus;
  const freee = useFreeeMode();
  const busy = useFreeeBusy();
  const { seed, state } = acct;

  const phase: StatementPhase = useMemo(() => phaseOf(freee, status, list), [freee, status, list]);
  const view: StatementView = useMemo(() => {
    if (!freee) return seedView(seed, state);
    const rows = phase.phase === "ok" && list.phase === "ok" ? list.list.rows : [];
    return liveView(seed, state, record, rows, getFreeeSettings().markPrefix);
  }, [freee, seed, state, record, list, phase.phase]);

  /** その行の選びを止めるか（架空の明細は登録の後・freee の明細は送り始めて固定した後と、送っている間） */
  const locked = useCallback(
    (key: string) => (view.mode === "seed" ? !!state.registered : tryMode || busy || isFixed(record, key)),
    [view.mode, state.registered, busy, record, tryMode],
  );
  const choose = useCallback(
    (key: string, use: CardUse) => {
      if (locked(key)) return;
      if (view.mode === "seed") acct.update((s) => withChoice(seed, s, Number(key), use));
      else acct.update((s) => withLiveChoice(s, key, use));
    },
    [acct, locked, seed, view.mode],
  );
  const toggleAuto = useCallback(
    (merchantId: string, on: boolean) => {
      if (view.mode === "seed") acct.update((s) => withAutoNext(seed, s, merchantId, on));
      else if (!busy && !tryMode) acct.update((s) => withLiveAutoNext(s, merchantId, on));
    },
    [acct, busy, seed, view.mode, tryMode],
  );
  const autoLocked = view.mode === "seed" ? !!state.registered : busy || tryMode;
  return { acct, view, phase, locked, choose, toggleAuto, autoLocked, record, tryMode };
}

export function phaseOf(freee: boolean, status: string, list: FreeeListState): StatementPhase {
  if (!freee) return { phase: "seed" };
  if (list.phase === "ok") return { phase: "ok", capped: list.list.capped, bank: list.list.bank, range: list.list.range };
  if (list.phase === "error") return { phase: "error", reason: list.reason, reconnect: list.reconnect };
  if (status !== "connected" && status !== "loading")
    return { phase: "error", reason: status === "expired" ? "freee の鍵が切れました" : "freee とつながっていません", reconnect: true };
  return { phase: "loading" };
}
