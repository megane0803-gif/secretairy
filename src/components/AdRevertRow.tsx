"use client";

// 承認の箱の「戻す案」の行（広告）。効いたかの判定で予約が減った言葉を、止める前に戻すか、オーナーが決める。
// 戻すのは取り消せない操作なので、プログラムが勝手に戻さず、承認の箱に入れる（docs/SPEC.md §1.7.1）。
// 大きいカード1枚：「前 → 後」と理由1文、数（プログラムが入れた物）。ボタンは「承認」「見送り」（直すは無い）。
// 🔒 確定は人：戻すのは、人が画面の「承認」を押したときだけ（ブラウザの本物の操作か確かめる）。LINE には出さない。

import { actionPast, yen } from "@/lib/ads/report";
import { useAds } from "@/lib/ads/useAds";
import { approveRevert, pendingRevert, revertLabel, skipRevert } from "@/lib/ads/verdict";
import { writeJournal, type JournalWho } from "@/lib/journal";

export function AdRevertRow({ onDone }: { onDone?: (text: string) => void }) {
  const ads = useAds();
  const j = pendingRevert(ads.state);
  if (!j) return null;

  const press = (e: React.MouseEvent, how: "approve" | "skip") => {
    // 人がボタンを押したときだけ（スクリプトから押したことにはできない）
    if (!e.nativeEvent.isTrusted) return;
    const nowIso = new Date().toISOString();
    let journal: { who: JournalWho; text: string }[] = [];
    ads.update((a) => {
      const out = how === "approve" ? approveRevert(a, j.id, nowIso, ads.settings.channel) : skipRevert(a, j.id, nowIso);
      journal = out.journal;
      return out.ads;
    });
    writeJournal(...journal);
    onDone?.(how === "approve" ? `✓ ${ads.settings.channel}で ${revertLabel(j)}ことにしました` : `見送りました：${j.no}番は${actionPast(j.action)}ままです`);
  };

  return (
    <li className="approval ad-card">
      <div className="approval-what">
        <span className="tag hold">戻す案</span>
        <span className="tag who-program">プログラムの判定</span>
      </div>
      <div className="ad-change">
        <span>
          {j.no}番「{j.text}」
        </span>
        <span>{j.action === "stop" ? "止めている" : "外している"}</span>
        <span className="arrow" aria-label="から">
          →
        </span>
        <strong>{j.action === "stop" ? "また出す" : "外すのをやめる"}</strong>
      </div>
      <p className="approval-why">{j.why}</p>
      <p className="ad-nums">
        <span>
          {actionPast(j.action)}前の{j.weeks}週 → 後の{j.weeks}週
        </span>
        <span>
          予約 <strong className="num">{j.before.bookings}</strong>件 → <strong className="num">{j.after.bookings}</strong>件
        </span>
        <span>
          お金 <strong className="num">{yen(j.before.cost)}</strong> → <strong className="num">{yen(j.after.cost)}</strong>
        </span>
        <small className="hint">（数はプログラムが入れました）</small>
      </p>
      <div className="approval-buttons" role="group" aria-label="この戻す案をどうするか">
        <button type="button" className="btn primary" onClick={(e) => press(e, "approve")}>
          承認
        </button>
        <button type="button" className="btn" onClick={(e) => press(e, "skip")}>
          見送り
        </button>
      </div>
      <p className="hint small">承認＝広告でこの言葉を元に戻します（戻したあとは、また見直しで選べます）。見送り＝{actionPast(j.action)}ままにします。</p>
    </li>
  );
}
