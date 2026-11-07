"use client";

// 広告タブの「くわしく」の中：広告のテスト用アカウントのオーナーの操作（docs/SPEC.md §1.7.8）。「本物の広告に渡す形」の下に置く。
// つないでいない時（3つの環境変数のどれかが無い・プレビュー・手元）は、1行だけ。つながっている時は、合言葉の欄・用意・送る・送った結果の知らせ。
// 「用意」「送る」はオーナーだけ（押すたびにオーナー用の合言葉を入れる。ブラウザに残さない）。
// 読み直しの一覧・「読み直す」ボタン・札は、広告の管理画面の下（AdsLiveRead.tsx）に1つだけ。流れは画面に1つ（src/lib/ads/live/usePanel.ts の livePanel）。
// 送った結果は、直しR の結果の読み込みと同じ道（connectLoad.ts）で「本物に反映済み」の印にする（だれでも試すの道では印を付けない）。

import { useMemo, useState } from "react";
import { syncPayload } from "@/lib/ads/connect";
import { featuredWords } from "@/lib/ads/featured";
import { useLiveLink, useLivePanel } from "@/lib/ads/live/usePanel";
import { NOT_CONNECTED_MESSAGE } from "@/lib/ads/live/wire";
import { useAds } from "@/lib/ads/useAds";
import { getMenus } from "@/lib/settings";
import { LINK_UNKNOWN_MESSAGE } from "./AdsLiveRead";

export function AdsLive() {
  const ads = useAds();
  const words = useMemo(() => featuredWords(ads.settings, getMenus()), [ads.settings]);
  const c = ads.settings.connect;
  const live = ads.settings.live;
  const link = useLiveLink();
  const { panel, view } = useLivePanel();
  const [pass, setPass] = useState("");

  if (!link) return null;
  if (link === "unknown") return <p className="hint small ad-live-off">{LINK_UNKNOWN_MESSAGE}</p>;
  if (!link.connected) return <p className="hint small ad-live-off">{NOT_CONNECTED_MESSAGE}（つなぐ手順は README）</p>;

  const pending = syncPayload(ads.state, words, c, "").payload.items.length;
  const { busy, shown } = view;

  const setup = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    const code = pass;
    setPass("");
    void panel.setup(code);
  };

  const send = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    const code = pass;
    setPass("");
    void panel.send(code);
  };

  return (
    <div className="ad-live" aria-label="テスト用の広告アカウント（オーナー）">
      <p className="ad-live-badge" role="status">
        <b>{live.label}</b> つながっています・広告は出ません・お金は動きません
      </p>
      {link.canWrite ? (
        <>
          <p className="hint small">
            「用意」と「送る」はオーナーだけです。押すたびにオーナー用の合言葉を入れてください（このブラウザには残しません）。送るのは承認済みで、まだ反映していない案（いま{pending}件）です。
            だれでも承認した時の試し（元の形に戻してから1件）とは別で、送った案に「本物に反映済み」の印を付けます。
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
      <p className="hint small">読み直しの一覧は、広告の管理画面の下に出ます。</p>
    </div>
  );
}
