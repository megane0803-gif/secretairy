"use client";

// 画面に1つだけの、広告のテスト用アカウントの流れ（livePanel）と、つながっているかの札（直しU・docs/SPEC.md §1.7.8）。
// 承認から呼ぶ「試す」（AdApprovalRows・AdAddRow。広告のタブとホームの承認BOX）・「読み直す」ボタンと一覧（AdsLiveRead）・
// 「くわしく」のオーナーの「用意」「送る」（AdsLive）が、みなこの1つを使う（押している間の印・頼みの番号・epoch・遅れた返事を出さない、を共にする）。
// 札はページを開いてから1回だけ GET する（Google は呼ばない）。失敗した時は「分からない」（つないでいない、とは分ける）。

import { useEffect, useSyncExternalStore } from "react";
import { subscribeBrowser } from "../../browser";
import { currentEpoch } from "../../book/store";
import { writeJournal } from "../../journal";
import { getAdSettings, getMenus } from "../../settings";
import { syncPayload } from "../connect";
import { loadSyncResult } from "../connectLoad";
import { featuredWords } from "../featured";
import { readAdsState, writeAdsState } from "../useAds";
import { liveRead, liveSend, liveSetup, liveStatus, liveTry } from "./client";
import { EMPTY_LIVE_PANEL, livePanel, type LivePanel, type LivePanelView } from "./panel";
import type { TryKind } from "./wire";

// ---- 流れ（1つだけ） ----

let panel: LivePanel | null = null;
let view: LivePanelView = EMPTY_LIVE_PANEL;
const viewSubs = new Set<() => void>();

const words = () => featuredWords(getAdSettings(), getMenus());

/** 画面に1つの流れ（初めて使う時に作る） */
export function sharedPanel(): LivePanel {
  if (panel) return panel;
  const c = getAdSettings().connect;
  panel = livePanel({
    setup: liveSetup,
    send: liveSend,
    read: liveRead,
    try: liveTry,
    epoch: currentEpoch,
    // 送る直前の状態で作る（作った日時はブラウザの時計）
    payload: () => syncPayload(readAdsState(), words(), c, new Date().toISOString()).payload,
    // 送った結果で印を付ける（直しR の読み込みと同じ道。試すでは印を付けない）
    mark: (result) =>
      loadSyncResult(JSON.stringify(result), {
        read: readAdsState,
        update: (f) => writeAdsState(f(readAdsState())),
        words: words(),
        settings: c,
        journal: "テスト用の広告アカウントに送った",
      }),
    journal: (text) => writeJournal({ who: "オーナー", text }),
    onChange: (v) => {
      view = v;
      viewSubs.forEach((f) => f());
    },
  });
  return panel;
}

const subscribeView = (f: () => void) => {
  viewSubs.add(f);
  return () => void viewSubs.delete(f);
};

let seenEpoch: string | null = null;
/** 「最初に戻す」が押されたら（印が変わったら）、流れている返事を捨てて一覧と知らせを消す（どの画面から見ても1回） */
function syncEpoch(e: string | undefined) {
  const now = e ?? "";
  if (seenEpoch === null) seenEpoch = now;
  else if (seenEpoch !== now) {
    seenEpoch = now;
    sharedPanel().forget();
  }
}

export function useLivePanel(): { panel: LivePanel; view: LivePanelView; epochNow: string | undefined } {
  const v = useSyncExternalStore(subscribeView, () => view, () => EMPTY_LIVE_PANEL);
  const epochNow = useSyncExternalStore(subscribeBrowser, currentEpoch, () => undefined);
  useEffect(() => syncEpoch(epochNow), [epochNow]);
  return { panel: sharedPanel(), view: v, epochNow };
}

// ---- つながっているかの札（ページを開いてから1回） ----

/** null = まだ分からない（読んでいる）/ "unknown" = 札の GET が失敗した */
export type LiveLink = { connected: boolean; canWrite: boolean } | "unknown" | null;

let link: LiveLink = null;
let linkP: Promise<LiveLink> | null = null;
const linkSubs = new Set<() => void>();

export function liveLink(): Promise<LiveLink> {
  if (!linkP)
    linkP = liveStatus().then((r) => {
      link = r.ok ? { connected: r.connected, canWrite: r.canWrite } : "unknown";
      linkSubs.forEach((f) => f());
      return link;
    });
  return linkP;
}

export function useLiveLink(): LiveLink {
  const s = useSyncExternalStore(
    (f) => {
      linkSubs.add(f);
      return () => void linkSubs.delete(f);
    },
    () => link,
    () => null,
  );
  useEffect(() => void liveLink(), []);
  return s;
}

/**
 * 承認した後に1回だけ試す（広告のタブとホームの承認BOXの、止める・外す・足す）。LINE のボタンの承認と戻す案からは呼ばない。
 * つないでいない・分からない時は呼ばない（承認は作品の中だけで効いている）。返事が届かなくても呼び直さない。
 */
export async function tryAfterApprove(it: { kind: TryKind; no: number; text: string }): Promise<"started" | "off" | "unknown" | "not-run"> {
  const s = await liveLink();
  if (s === "unknown") return "unknown";
  if (!s || !s.connected) return "off";
  return (await sharedPanel().tryOne(it)) ? "started" : "not-run";
}
