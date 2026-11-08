"use client";

// 承認BOXの「足す案」の行（広告。docs/SPEC.md §1.7.5）。止める・外すの行の下に出す（ホームの承認BOXと広告タブの同じ行）。
// 大きいカード1枚：「前 → 後」と理由1文、数（表からプログラムが入れた物）、足す用のプログラムの確認（✓ 4つ）。
// ボタンは「承認」「見送り」（直すは無い）。AI のチームの会議は付けない。LINE には届けない。
// 🔒 確定は人：足すのは、人が画面の「承認」を押したときだけ（ブラウザの本物の操作か確かめる）。
// 直しU：承認の後に、テスト用の広告アカウントを元の形に戻してからこの1件を送る窓口を1回呼ぶ（AdApprovalRows の startTry と同じ道）。
// 窓口を呼んでいる間（liveBusy）は「承認」を押せない。

import { useState } from "react";
import { addLabel } from "@/lib/ads/add";
import { featuredWords } from "@/lib/ads/featured";
import { yen } from "@/lib/ads/report";
import { approveAdd, tableOf, withAddSkipped, type AdAddProposal } from "@/lib/ads/state";
import { useAds } from "@/lib/ads/useAds";
import { SAVE_FAILED_MESSAGE } from "@/lib/browser";
import { writeJournal, type JournalWho } from "@/lib/journal";
import { getMenus } from "@/lib/settings";
import { GateChecks, LIVE_BUSY_TITLE, startTry, type AdDoneSet } from "./AdApprovalRows";

export function AdAddRow({ p, onDone, liveBusy = false }: { p: AdAddProposal; onDone?: AdDoneSet; liveBusy?: boolean }) {
  const ads = useAds();
  const [note, setNote] = useState<string | null>(null);

  const approve = (e: React.MouseEvent) => {
    // 人がボタンを押したときだけ（スクリプトから押したことにはできない）
    if (!e.nativeEvent.isTrusted) return;
    if (liveBusy) return;
    const nowIso = new Date().toISOString();
    const words = featuredWords(ads.settings, getMenus());
    let journal: { who: JournalWho; text: string }[] = [];
    let problems: string[] | undefined;
    // 書く直前に読みなおした状態から作った表で、足す用の4つをもう一度確かめる
    const w = ads.update((a) => {
      const out = approveAdd(a, p.id, { nowIso, table: tableOf(ads.report, ads.settings, a), words, settings: ads.settings });
      journal = out.journal;
      problems = out.ok ? undefined : out.problems;
      return out.ads;
    });
    if (!w.ok) return void setNote(SAVE_FAILED_MESSAGE);
    writeJournal(...journal);
    if (problems) return void setNote(`足しませんでした：${problems.join("。")}`);
    setNote(null);
    // 作品の中の承認は効いた。そのあとテスト用の広告アカウントに、元の形に戻してからこの1件を送る（つないでいなければ呼ばない）
    startTry({ kind: "add", no: p.no, text: p.text, todo: false }, (d) => onDone?.(d));
  };

  const skip = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    const w = ads.update((a) => withAddSkipped(a, p.id, new Date().toISOString()));
    if (!w.ok) return void setNote(SAVE_FAILED_MESSAGE);
    writeJournal({ who: "オーナー", text: `見送り：広告の案「${addLabel(p)}」を閉じた（広告は変えていない。次からこの言葉は足す候補にしない）` });
    setNote(null);
    onDone?.(`見送りました：${p.no}番を足す案を閉じました`);
  };

  return (
    <li className="approval ad-card">
      <div className="approval-what">
        <span className="tag hold">広告の案</span>
        <span className="tag who-ai">{p.mode === "script" ? "決まった返事" : "AI"}</span>
        <span className="tag">足す</span>
      </div>
      <div className="ad-change">
        <span>
          {p.no}番「{p.text}」
        </span>
        <span>調べた言葉</span>
        <span className="arrow" aria-label="から">
          →
        </span>
        <strong>広告を出す言葉に足す</strong>
      </div>
      <p className="approval-why">{p.reason}</p>
      <p className="ad-nums">
        <span>
          4週で 押された <strong className="num">{p.total.clicks.toLocaleString("ja-JP")}</strong>回
        </span>
        <span>
          かかったお金 <strong className="num">{yen(p.total.cost)}</strong>
        </span>
        <span>
          予約 <strong className="num">{p.total.bookings}</strong>件
        </span>
        <small className="hint">（調べた言葉の数。表からプログラムが入れました）</small>
      </p>
      <GateChecks checks={p.checks} />
      <div className="approval-buttons" role="group" aria-label="この足す案をどうするか">
        <button type="button" className="btn primary" onClick={approve} disabled={liveBusy} title={liveBusy ? LIVE_BUSY_TITLE : undefined}>
          承認
        </button>
        <button type="button" className="btn" onClick={skip}>
          見送り
        </button>
      </div>
      <p className="hint small">
        承認＝広告の管理画面の「広告を出す言葉」に1行足します（フレーズ一致。お金は動きません）。テスト用の広告アカウントにつながっている時は、元の形に戻してからこの1件を送ります。見送り＝案を閉じます。
      </p>
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
    </li>
  );
}
