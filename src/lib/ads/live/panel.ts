// 広告のテスト用アカウントの「くわしく」の中の動き（画面に依らない形。画面は src/app/ads/AdsLive.tsx。docs/SPEC.md §1.7.8）。
// 直しT：送った後・用意した後に、送る前に読んだ古い一覧を残さない。
// - 「用意」「送る」を始めたら、うまくいっても・断られても・分からなくても、古い読み直しの一覧と読み直しの知らせを消す
//   （送った・用意した結果の知らせ shown は残す）。
// - 何か変わったかもしれない時（うまくいった・分からない）は、同じ run の中で1回だけ読み直す（押している間の印で止まらない）。
//   読み直しだけ断られた時は、送った結果を残したまま「送った結果は上のとおりです。いまは読み直せませんでした（理由）」。
// - 読み直しの返事は、頼んだ時の「最初に戻す」の印と、いちばん新しい頼みの番号の両方が同じ時だけ出す。
// - 「印がありますが〜」の確かめは、最後に「用意」「送る」を始めた時より後に頼んだ一覧とだけ比べる。
// 直しU：だれでも承認したら試す（try）も、この同じ流れ（画面に1つ。src/lib/ads/live/usePanel.ts）を通す。
// - 承認から呼ぶ「試す」・「読み直す」ボタン・「くわしく」のオーナーの「用意」「送る」が、押している間の印・頼みの番号・
//   「最初に戻す」の印・遅れた返事を出さない、を共にする（どれかが動いている間は、ほかは動かない）
// - 試すは書く物なので、始めたら古い一覧を消す（beginWrite）。返事の一覧（窓口の中で読み直した物）をそのまま出す
// - 試すの返事が届かない・「分からない」の時も、自動では呼び直さない（読み直しも自動ではしない。「読み直す」で見る）

import { sameEpoch } from "../../book/state";
import type { AdsState } from "../state";
import type { SyncPayload } from "../connect";
import { driftOf, outcomeText } from "./client";
import type { LiveFail, LiveOutcome, LiveReadResponse, LiveResult, LiveSendResponse, LiveSetupResponse, LiveTryResponse, TryKind } from "./wire";

export type LiveKind = "setup" | "send" | "read" | "try";
/** 試した1件（承認の知らせに使う）。sending = 送っている / refused = 窓口が断った（理由つき） */
export type LiveTried = { kind: TryKind; no: number; text: string; state: "sending" | LiveOutcome | "refused"; reason?: string };
export type LiveShown = { head: string; lines: string[] } | null;
export type LiveReadList = Extract<LiveReadResponse, { ok: true }>;
type Epoch = string | undefined;

export type LivePanelView = {
  busy: LiveKind | null;
  shown: LiveShown;
  /** 読み直しの一覧と、頼んだ時の番号・「最初に戻す」の印 */
  read: { list: LiveReadList; seq: number; epoch: Epoch; at: string } | null;
  readNote: string | null;
  /** 最後に「用意」「送る」「試す」を始めた時の番号（これより後に頼んだ一覧とだけ比べる） */
  wroteSeq: number;
  /** 最後に試した1件（だれでも承認したら。直しU） */
  tried: LiveTried | null;
};

export const EMPTY_LIVE_PANEL: LivePanelView = { busy: null, shown: null, read: null, readNote: null, wroteSeq: 0, tried: null };

export const NOTHING_TO_SEND = "送る案がありません（承認済みで、まだ反映していない案だけを送ります）";
export const RESET_WHILE_SENDING = "送っている間に「最初に戻す」が押されたので、印は付けませんでした（テスト用アカウントの中は変わっています。下の一覧で確かめてください）";
/** 送る・用意が始まる前に断られた時（何も変わっていない）の読み直しの所の1行 */
export const READ_LATER_NOTE = "いまの様子は「読み直す」で見られます";
export const READ_LIMIT_NOTE = "今日の読み直しは上限です。明日また読み直せます";

/** 断られても、テスト用アカウントの中が変わったかもしれない時（読み直して確かめる） */
const MAY_HAVE_CHANGED = new Set(["lost", "unknown", "failed"]);

/**
 * 送った・用意した後の読み直しだけが断られた時の1行（送れなかったと読めない言い方）。
 * この1行は広告の管理画面の下（読み直しの所）に出て、送った・用意した結果は「くわしく」の中に出るので、場所を書く。
 */
export function readFailedAfter(after: "setup" | "send", r: LiveFail): string {
  const head = after === "send" ? "送った結果は「くわしく」の中に出ています。" : "用意した結果は「くわしく」の中に出ています。";
  // 1日の上限は決まった1行。1時間・1分の上限（「しばらく」「1分ほど」）は、明日と言わずにサーバーの文のまま
  if (r.code === "limit") return head + (r.message.includes("今日") ? READ_LIMIT_NOTE : `${r.message.replace(/。$/, "")}。`);
  // 返事が届かなかった時の文は「送れたか分かりません」なので、読み直しの所では使わない
  const why = r.code === "lost" ? "返事が届きませんでした" : r.message.replace(/。$/, "");
  return `${head}いまは読み直せませんでした（${why}）`;
}

/** 画面に出してよい一覧（いまの「最初に戻す」の印と同じ時だけ） */
export function visibleRead(v: LivePanelView, epochNow: Epoch): LiveReadList | null {
  return v.read && sameEpoch({ epoch: epochNow }, v.read.epoch) ? v.read.list : null;
}

/** 「印がありますが〜」の行。最後の「用意」「送る」より後に頼んだ一覧とだけ比べる（送る前の一覧とは比べない） */
export function driftShown(s: AdsState, v: LivePanelView, epochNow: Epoch, adGroup: string): string[] {
  const list = visibleRead(v, epochNow);
  if (!list || !v.read || v.read.seq <= v.wroteSeq) return [];
  return driftOf(s, list, adGroup);
}

export type LivePanelDeps = {
  setup: (code: string) => Promise<LiveSetupResponse | LiveFail>;
  /** だれでも試す（種類と番号だけを送る） */
  try: (kind: TryKind, no: number) => Promise<LiveTryResponse | LiveFail>;
  send: (code: string, payload: SyncPayload) => Promise<LiveSendResponse | LiveFail>;
  read: () => Promise<LiveReadResponse>;
  /** いまの「最初に戻す」の印（book/store.ts の currentEpoch） */
  epoch: () => Epoch;
  /** 送る直前の中身 */
  payload: () => SyncPayload;
  /** 送った結果で印を付ける（直しR の読み込みと同じ道：connectLoad.ts の loadSyncResult） */
  mark: (result: LiveResult) => { ok: true; marked: number } | { ok: false; note: string };
  journal: (text: string) => void;
  onChange: (v: LivePanelView) => void;
};

export type LivePanel = {
  view: () => LivePanelView;
  setup: (code: string) => Promise<void>;
  send: (code: string) => Promise<void>;
  reread: () => Promise<void>;
  /**
   * 承認した1件を試す（だれでも。直しU）。ほかが動いている間は動かさず false（承認BOXのボタンは押せなくしてある）。
   * 返事が届かない・分からない時も、自動では呼び直さない。
   */
  tryOne: (it: { kind: TryKind; no: number; text: string }) => Promise<boolean>;
  /** 「最初に戻す」が押された時など：流れている読み直しの返事を捨て、一覧と試した1件の知らせを消す */
  forget: () => void;
};

export function livePanel(d: LivePanelDeps): LivePanel {
  let v: LivePanelView = EMPTY_LIVE_PANEL;
  let seq = 0;
  let running = false;
  const set = (p: Partial<LivePanelView>) => {
    v = { ...v, ...p };
    d.onChange(v);
  };

  /** 同時に2回押さない（押している間はどのボタンも押せない）。動かせなかった時は false */
  const run = async (kind: LiveKind, f: () => Promise<void>): Promise<boolean> => {
    if (running) return false;
    running = true;
    set({ busy: kind });
    try {
      await f();
    } finally {
      running = false;
      set({ busy: null });
    }
    return true;
  };

  /** 読み直しを1回。押している間の印は見ない（run の中から呼ぶ） */
  const readOnce = async (after: "setup" | "send" | null) => {
    const ticket = { seq: ++seq, epoch: d.epoch() };
    const r = await d.read();
    // 遅れて届いた古い返事は出さない（もっと新しい頼みがある・途中で「最初に戻す」が押された）
    if (ticket.seq !== seq || !sameEpoch({ epoch: d.epoch() }, ticket.epoch)) return;
    if (r.ok) return set({ read: { list: r, seq: ticket.seq, epoch: ticket.epoch, at: new Date().toISOString() }, readNote: r.note ?? null });
    set({ read: null, readNote: after ? readFailedAfter(after, r) : r.message });
  };

  /** 「用意」「送る」を始めた：古い一覧と知らせを消す（どう終わっても残さない） */
  const beginWrite = () => {
    seq += 1;
    set({ read: null, readNote: null, wroteSeq: seq });
  };

  /** 断られた時：変わったかもしれなければ読み直す。何も変わっていなければ1行だけ */
  const afterFail = async (after: "setup" | "send", r: LiveFail) => {
    set({ shown: { head: r.message, lines: [] } });
    if (MAY_HAVE_CHANGED.has(r.code)) await readOnce(after);
    else set({ readNote: READ_LATER_NOTE });
  };

  return {
    view: () => v,
    forget: () => {
      seq += 1;
      set({ read: null, readNote: null, tried: null });
    },
    reread: async () => void (await run("read", () => readOnce(null))),
    tryOne: (it) =>
      run("try", async () => {
        beginWrite();
        const epoch = d.epoch();
        set({ tried: { ...it, state: "sending" } });
        // 1回だけ呼ぶ（返事が届かなくても呼び直さない）
        const r = await d.try(it.kind, it.no);
        // 途中で「最初に戻す」が押された：承認も消えているので、知らせも一覧も出さない
        if (!sameEpoch({ epoch: d.epoch() }, epoch)) return set({ tried: null });
        if (!r.ok) {
          const lost = r.code === "lost";
          return set({ tried: { ...it, state: lost ? "unknown" : "refused", ...(lost ? {} : { reason: r.message }) }, readNote: READ_LATER_NOTE });
        }
        const ticket = ++seq;
        set({
          tried: { ...it, state: r.line.outcome, ...(r.line.reason ? { reason: r.line.reason } : {}) },
          read: r.list ? { list: r.list, seq: ticket, epoch, at: new Date().toISOString() } : null,
          readNote: r.list ? (r.list.note ?? null) : READ_LATER_NOTE,
        });
      }),
    setup: async (code) =>
      void (await run("setup", async () => {
        beginWrite();
        const r = await d.setup(code);
        if (!r.ok) return afterFail("setup", r);
        if (r.created) d.journal("テスト用の広告アカウントに店の広告を用意した");
        set({ shown: { head: r.created ? "✓ 用意しました" : "もう用意してあります", lines: r.lines } });
        await readOnce("setup");
      })),
    send: async (code) =>
      void (await run("send", async () => {
        beginWrite();
        // 送る直前の状態で作る。「最初に戻す」が途中で押されたら、返事が来ても印を付けない（始めた時の印を持つ）
        const payload = d.payload();
        const epoch = d.epoch();
        if (payload.items.length === 0) return set({ shown: { head: NOTHING_TO_SEND, lines: [] } });
        const r = await d.send(code, payload);
        if (!r.ok) return afterFail("send", r);
        const lines = r.lines.map(outcomeText);
        if (!sameEpoch({ epoch: d.epoch() }, epoch)) set({ shown: { head: RESET_WHILE_SENDING, lines } });
        else {
          // 直しR の結果の読み込みと同じ道で印を付ける（「もう〜だった」も印。2回でも1回）
          const m = d.mark(r.result);
          set({ shown: !m.ok ? { head: m.note, lines } : { head: m.marked ? `✓ 本物に反映済みの印を ${m.marked}件 付けました` : "印を付けた案はありません", lines } });
        }
        // 送った後に1回だけ読み直す（反映した・もう〜だった・できなかった・分からない、のどれでも）
        await readOnce("send");
      })),
  };
}
