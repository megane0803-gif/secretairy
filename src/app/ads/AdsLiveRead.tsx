"use client";

// 広告の管理画面のすぐ下（2つの一覧の上）：テスト用の広告アカウントの今の様子（直しU・docs/SPEC.md §1.7.8）。だれでも見られる。
// 5つをひとまとまりにする：札（つながっているか）・「テスト用アカウントから読み直す」（画面に1つだけ）・読み直した一覧・
// 「印がありますが〜」（オーナーの送りの後だけ）・読み直しの1行。流れは画面に1つ（src/lib/ads/live/usePanel.ts）で、
// 承認から試す物・このボタン・「くわしく」のオーナーの送るが同じ物を使う。
// サービスの名前を画面に出すのは、つながっている時の札（config/ads.json の live.label）だけ。

import { driftShown, visibleRead } from "@/lib/ads/live/panel";
import { useLiveLink, useLivePanel } from "@/lib/ads/live/usePanel";
import { NOT_CONNECTED_MESSAGE } from "@/lib/ads/live/wire";
import { useAds } from "@/lib/ads/useAds";
import { getShop } from "@/lib/settings";

export const LINK_UNKNOWN_MESSAGE = "つながっているか分かりませんでした（ページを読み込み直してください）";

export function AdsLiveRead() {
  const ads = useAds();
  const link = useLiveLink();
  const { panel, view, epochNow } = useLivePanel();
  const c = ads.settings.connect;
  // 開いた時の描画はサーバーとそろえ、札が分かるまでは何も出さない
  if (!link) return null;
  if (link === "unknown") return <p className="hint small ad-live-off">{LINK_UNKNOWN_MESSAGE}</p>;
  if (!link.connected) return <p className="hint small ad-live-off">{NOT_CONNECTED_MESSAGE}（つなぐ手順は README）</p>;

  const { busy, readNote } = view;
  const read = visibleRead(view, epochNow);
  const drift = driftShown(ads.state, view, epochNow, c.adGroup);
  const at = view.read ? new Date(view.read.at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: getShop().timezone }) : "";

  const reread = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    void panel.reread();
  };

  return (
    <section className="ad-live" aria-label="テスト用の広告アカウントの今の様子">
      <p className="ad-live-badge" role="status">
        <b>{ads.settings.live.label}</b> つながっています・広告は出ません・お金は動きません
      </p>
      <div className="reset-row">
        <button type="button" className="btn small" onClick={reread} disabled={!!busy}>
          {busy === "read" ? "読み直しています…" : busy === "try" ? "試しています…" : busy ? "送っています…" : "テスト用アカウントから読み直す"}
        </button>
      </div>
      {read && read.campaign.found && (
        <div className="ad-live-read">
          <p className="hint small">
            テスト用の広告アカウントから読みました（{at}）。次の人が承認すると元の形に戻ります。キャンペーン「{c.campaign}」：{read.campaign.status}。数の欄は空です（テスト用アカウントは広告が出ないため）。この一覧が、このブラウザの印よりも正しい物です。
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
        </div>
      )}
      {drift.length > 0 && (
        <ul className="hint small">
          {drift.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {readNote && <p className="hint small">{readNote}</p>}
    </section>
  );
}
