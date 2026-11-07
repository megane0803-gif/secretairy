"use client";

// 広告タブの「くわしく」の中：本物の広告に渡す形（docs/SPEC.md §1.7.6）。今はつないでいない。
// 承認済みでまだ反映していない案を JSON にして写す（どこにも送らない）・本物の側の結果を貼って読み込む（反映した案に「本物に反映済み」の印）。
// 今の画面の見た目と動画を変えないため、閉じた折りたたみの中に小さく置く。鍵・合言葉・本物の広告の番号は出さない。

import { useMemo, useState } from "react";
import { readSyncResult, sampleResult, syncPayload, withSynced } from "@/lib/ads/connect";
import { featuredWords } from "@/lib/ads/featured";
import { readAdsState, useAds } from "@/lib/ads/useAds";
import { SAVE_FAILED_MESSAGE } from "@/lib/browser";
import { writeJournal } from "@/lib/journal";
import { DEMO_TAG_NOTE } from "@/lib/notices";
import { getMenus } from "@/lib/settings";

export function AdsConnect() {
  const ads = useAds();
  const words = useMemo(() => featuredWords(ads.settings, getMenus()), [ads.settings]);
  const c = ads.settings.connect;
  // 作った日時は開いた時の時計（写すたびに変わらないように、状態が変わった時だけ作りなおす）
  const { payload, notes } = useMemo(() => syncPayload(ads.state, words, c, new Date().toISOString()), [ads.state, words, c]);
  const json = JSON.stringify(payload, null, 2);
  const [paste, setPaste] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [read, setRead] = useState<{ head: string; lines: string[] } | null>(null);
  const marked = [...ads.state.proposals, ...(ads.state.adds ?? [])].filter((p) => p.realAt);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied("写しました（どこにも送っていません）");
    } catch {
      setCopied("写せませんでした。上の文字を選んで写してください");
    }
  };

  const load = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    // 書く直前に読みなおした状態で照らす
    const r = readSyncResult(paste, readAdsState(), words, c);
    if (!r.ok) return void setRead({ head: r.note, lines: [] });
    let n = 0;
    const w = ads.update((s) => {
      const again = readSyncResult(paste, s, words, c);
      if (!again.ok) return s;
      n = again.marks.length;
      return withSynced(s, again.marks, new Date().toISOString());
    });
    if (!w.ok) return void setRead({ head: SAVE_FAILED_MESSAGE, lines: [] });
    writeJournal({ who: "オーナー", text: `本物の広告の結果を読み込んだ：反映済みの印 ${n}件${r.notes.length ? `・知らせ ${r.notes.length}件` : ""}` });
    setRead({ head: n ? `✓ 本物に反映済みの印を ${n}件 付けました` : "印を付けた案はありません", lines: r.notes });
  };

  return (
    <details className="fold ad-connect">
      <summary>本物の広告に渡す形を見る（今はつないでいません）</summary>
      <div>
        <p className="hint small">
          承認済みでまだ反映していない案（止める・外す・足す）を、本物の検索広告へ渡す形にしたものです。今はどこにも送っていません。鍵・合言葉・本物の広告の番号は入れていません。
          合い方は、足す＝フレーズ一致・外す＝完全一致。キャンペーン「{c.campaign}」・足す先の広告グループ「{c.adGroup}」は作り物の名前です。
        </p>
        {notes.map((n, i) => (
          <p key={i} className="hint small">
            {n}
          </p>
        ))}
        <pre className="ad-connect-json" aria-label="本物の広告に渡す形（JSON）">
          {json}
        </pre>
        <div className="reset-row">
          <button type="button" className="btn small" onClick={() => void copy()}>
            写す
          </button>
          {copied && (
            <small className="hint" role="status">
              {copied}
            </small>
          )}
        </div>
        <label className="ad-connect-paste">
          <span className="hint small">本物の側の結果を貼る（案の番号ごとに「反映した／できなかった」）</span>
          <textarea value={paste} onChange={(e) => setPaste(e.target.value)} maxLength={c.maxPasteChars} rows={4} spellCheck={false} />
        </label>
        <div className="reset-row">
          <button type="button" className="btn small" onClick={load} disabled={!paste.trim()}>
            読み込む
          </button>
          <button
            type="button"
            className="btn small"
            onClick={() => setPaste(JSON.stringify(sampleResult(payload), null, 2))}
            disabled={payload.items.length === 0}
            title="本物の側の代わりに、渡す中身の全部を「反映した」とした結果を欄に入れます"
          >
            見本の結果を入れる
          </button>
          <span className="tag text" title={DEMO_TAG_NOTE}>
            デモ<span className="sr-only">（{DEMO_TAG_NOTE}）</span>
          </span>
        </div>
        {read && (
          <div role="status">
            <p className="hint">{read.head}</p>
            {read.lines.length > 0 && (
              <ul className="hint small">
                {read.lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {marked.length > 0 && (
          <p className="hint small">
            本物に反映済み：{marked.map((p) => `「${p.text}」`).join("・")}
          </p>
        )}
      </div>
    </details>
  );
}
