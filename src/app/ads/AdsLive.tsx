"use client";

// 広告タブの「くわしく」の中：広告のテスト用アカウント（docs/SPEC.md §1.7.8）。「本物の広告に渡す形」の下に置く。
// つないでいない時（3つの環境変数のどれかが無い・プレビュー・手元）は、1行だけ。つながっている時は、札・用意・送る・読み直す。
// 札はサーバーが広告の側を呼ばずに決める（開くたびに呼ばない）。本当の確かめは、ボタンを押した時だけ。
// 「用意」「送る」はオーナーだけ（押すたびにオーナー用の合言葉を入れる。ブラウザに残さない）。「読み直す」はだれでも。
// 送った結果は、直しR の結果の読み込みと同じ道（connectLoad.ts）で「本物に反映済み」の印にする。
// サービスの名前を画面に出すのは、つながっている時の札（config/ads.json の live.label）だけ。

import { useEffect, useMemo, useRef, useState } from "react";
import { syncPayload } from "@/lib/ads/connect";
import { loadSyncResult } from "@/lib/ads/connectLoad";
import { featuredWords } from "@/lib/ads/featured";
import { driftOf, liveRead, liveSend, liveSetup, liveStatus, outcomeText } from "@/lib/ads/live/client";
import { NOT_CONNECTED_MESSAGE, type LiveReadResponse } from "@/lib/ads/live/wire";
import { readAdsState, useAds } from "@/lib/ads/useAds";
import { sameEpoch } from "@/lib/book/state";
import { currentEpoch } from "@/lib/book/store";
import { writeJournal } from "@/lib/journal";
import { getMenus } from "@/lib/settings";

type Status = { connected: boolean; canWrite: boolean } | null;
type Shown = { head: string; lines: string[] } | null;
type Read = Extract<LiveReadResponse, { ok: true }>;

export function AdsLive() {
  const ads = useAds();
  const words = useMemo(() => featuredWords(ads.settings, getMenus()), [ads.settings]);
  const c = ads.settings.connect;
  const live = ads.settings.live;
  const [status, setStatus] = useState<Status>(null);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState<null | "setup" | "send" | "read">(null);
  const [shown, setShown] = useState<Shown>(null);
  const [read, setRead] = useState<Read | null>(null);
  const [readNote, setReadNote] = useState<string | null>(null);
  const running = useRef(false);

  useEffect(() => {
    let alive = true;
    void liveStatus().then((r) => {
      if (alive) setStatus(r.ok ? { connected: r.connected, canWrite: r.canWrite } : { connected: false, canWrite: false });
    });
    return () => {
      alive = false;
    };
  }, []);

  // 開いた時の描画はサーバーとそろえ、札が分かるまでは何も出さない
  if (!status) return null;
  if (!status.connected) return <p className="hint small ad-live-off">{NOT_CONNECTED_MESSAGE}（つなぐ手順は README）</p>;

  const pending = syncPayload(ads.state, words, c, "").payload.items.length;

  /** 同時に2回押さない（押している間はどのボタンも押せない） */
  const run = async (kind: "setup" | "send" | "read", f: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(kind);
    try {
      await f();
    } finally {
      running.current = false;
      setBusy(null);
    }
  };

  const setup = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    const code = pass;
    setPass("");
    void run("setup", async () => {
      const r = await liveSetup(code);
      if (!r.ok) return void setShown({ head: r.message, lines: [] });
      if (r.created) writeJournal({ who: "オーナー", text: "テスト用の広告アカウントに店の広告を用意した" });
      setShown({ head: r.created ? "✓ 用意しました" : "もう用意してあります", lines: r.lines });
    });
  };

  const send = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    const code = pass;
    setPass("");
    void run("send", async () => {
      // 送る直前の状態で作る（作った日時はブラウザの時計）
      const { payload } = syncPayload(readAdsState(), words, c, new Date().toISOString());
      // 「最初に戻す」が途中で押されたら、返事が来ても印を付けない（始めた時の印を持つ）
      const epoch = currentEpoch();
      if (payload.items.length === 0) return void setShown({ head: "送る案がありません（承認済みで、まだ反映していない案だけを送ります）", lines: [] });
      const r = await liveSend(code, payload);
      if (!r.ok) return void setShown({ head: r.message, lines: [] });
      const lines = r.lines.map(outcomeText);
      if (!sameEpoch({ epoch: currentEpoch() }, epoch))
        return void setShown({ head: "送っている間に「最初に戻す」が押されたので、印は付けませんでした（テスト用アカウントの中は変わっています。読み直してください）", lines });
      // 直しR の結果の読み込みと同じ道で印を付ける（「もう〜だった」も印。2回でも1回）
      const m = loadSyncResult(JSON.stringify(r.result), { read: readAdsState, update: ads.update, words, settings: c, journal: "テスト用の広告アカウントに送った" });
      if (!m.ok) return void setShown({ head: m.note, lines });
      setShown({ head: m.marked ? `✓ 本物に反映済みの印を ${m.marked}件 付けました` : "印を付けた案はありません", lines });
    });
  };

  const reread = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    void run("read", async () => {
      const r = await liveRead();
      if (!r.ok) {
        setRead(null);
        return void setReadNote(r.message);
      }
      setRead(r);
      setReadNote(r.note ?? null);
    });
  };

  const drift = read ? driftOf(ads.state, read, c.adGroup) : [];

  return (
    <div className="ad-live" aria-label="テスト用の広告アカウント">
      <p className="ad-live-badge" role="status">
        <b>{live.label}</b> つながっています・広告は出ません・お金は動きません
      </p>
      {status.canWrite ? (
        <>
          <p className="hint small">
            「用意」と「送る」はオーナーだけです。押すたびにオーナー用の合言葉を入れてください（このブラウザには残しません）。送るのは承認済みで、まだ反映していない案（いま{pending}件）です。
          </p>
          <label className="ad-live-pass">
            <span className="hint small">オーナー用の合言葉</span>
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="off" maxLength={live.passcode.maxChars} disabled={!!busy} />
          </label>
          <div className="reset-row">
            <button type="button" className="btn small" onClick={setup} disabled={!!busy || !pass}>
              {busy === "setup" ? "用意しています…" : "テスト用アカウントに店の広告を用意する"}
            </button>
            <button type="button" className="btn small" onClick={send} disabled={!!busy || !pass || pending === 0}>
              {busy === "send" ? "送っています…" : "テスト用アカウントに送る"}
            </button>
          </div>
        </>
      ) : (
        <p className="hint small">オーナー用の合言葉が設定されていないので、「用意」と「送る」は動きません。読み直すことはできます。</p>
      )}
      {shown && (
        <div role="status">
          <p className="hint">{shown.head}</p>
          {shown.lines.length > 0 && (
            <ul className="hint small">
              {shown.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="reset-row">
        <button type="button" className="btn small" onClick={reread} disabled={!!busy}>
          {busy === "read" ? "読み直しています…" : "テスト用アカウントから読み直す"}
        </button>
      </div>
      {readNote && <p className="hint small">{readNote}</p>}
      {read && read.campaign.found && (
        <div className="ad-live-read">
          <p className="hint small">
            キャンペーン「{c.campaign}」：{read.campaign.status}。数の欄は空です（テスト用アカウントは広告が出ないため）。この一覧が、このブラウザの印よりも正しい物です。
          </p>
          <div className="ad-live-table">
            <table>
              <caption className="hint small">広告を出す言葉</caption>
              <thead>
                <tr>
                  <th scope="col">言葉</th>
                  <th scope="col">合い方</th>
                  <th scope="col">状態</th>
                  <th scope="col">広告グループ</th>
                  <th scope="col">数</th>
                </tr>
              </thead>
              <tbody>
                {read.keywords.length === 0 && (
                  <tr>
                    <td colSpan={5}>まだありません</td>
                  </tr>
                )}
                {read.keywords.map((k, i) => (
                  <tr key={i}>
                    <td>{k.text}</td>
                    <td>{k.match}</td>
                    <td>{k.status}</td>
                    <td>{k.group}</td>
                    <td aria-label="数は空">—</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ad-live-table">
            <table>
              <caption className="hint small">外した言葉（除外）</caption>
              <thead>
                <tr>
                  <th scope="col">言葉</th>
                  <th scope="col">合い方</th>
                  <th scope="col">数</th>
                </tr>
              </thead>
              <tbody>
                {read.negatives.length === 0 && (
                  <tr>
                    <td colSpan={3}>まだありません</td>
                  </tr>
                )}
                {read.negatives.map((n, i) => (
                  <tr key={i}>
                    <td>{n.text}</td>
                    <td>{n.match}</td>
                    <td aria-label="数は空">—</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {drift.length > 0 && (
            <ul className="hint small">
              {drift.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
