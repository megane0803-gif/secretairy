"use client";

// 承認の箱の、広告の案の行。ホームの承認の箱と、広告タブの中に同じ行を出す。
// 大きいカード1枚：「前 → 後」と理由1文、数（表からプログラムが入れた物）、プログラムの確認（✓ 3つ）。
// ボタンは「承認／直す／見送り」。押すとプログラムが実行する（直すの出しなおしだけ AI を1回使う）。
// 🔒 確定は人：止める・外すのは、人が画面の「承認」を押したときだけ。押した事（ブラウザの本物の操作か）を確かめてから呼ぶ。

import { useState } from "react";
import { askAdsReview } from "@/lib/ads/client";
import { checkDraft, proposalLabel, type GateCheck } from "@/lib/ads/gate";
import { actionVerb, yen, type AdAction } from "@/lib/ads/report";
import { approveAd, withAdFixed, withAdFixUsed, withAdSkipped, type AdProposal } from "@/lib/ads/state";
import { useAds } from "@/lib/ads/useAds";
import { MAX_FIX_CHARS, type AdsMode } from "@/lib/ads/wire";
import { NO_AI_MESSAGE } from "@/lib/ai/wire";
import { shopToday } from "@/lib/calendar";
import { useBookState } from "@/lib/book/useBook";
import { writeJournal, type JournalWho } from "@/lib/journal";
import type { Rule } from "@/lib/rules/types";
import { useRules } from "@/lib/rules/useRules";
import { getShop } from "@/lib/settings";

/** プログラムの確認（✓ の印を3つ） */
export function GateChecks({ checks }: { checks: GateCheck[] }) {
  return (
    <ul className="gate" aria-label="プログラムの確認">
      {checks.map((c) => (
        <li key={c.id} className={c.ok === true ? "ok" : c.ok === false ? "ng" : "skip"}>
          <span aria-hidden>{c.ok === true ? "✓" : c.ok === false ? "✗" : "ー"}</span> {c.label}
          {c.ok === false && c.reason ? `：${c.reason}` : c.ok === null ? "（見ていない）" : ""}
        </li>
      ))}
    </ul>
  );
}

function before(a: AdAction): string {
  return a === "stop" ? "出している" : "広告が出る";
}

function after(a: AdAction): string {
  return a === "stop" ? "止める" : "外す（この言葉では出さない）";
}

export function AdApprovalRows({ seedRules, standalone = false }: { seedRules: Rule[]; standalone?: boolean }) {
  const ads = useAds();
  const bookState = useBookState();
  const { rules } = useRules(seedRules);
  const [done, setDone] = useState<string | null>(null);
  const [fixOpen, setFixOpen] = useState(false);
  const [fixText, setFixText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [noAi, setNoAi] = useState(false);

  const p = ads.pending;

  const approve = (e: React.MouseEvent, x: AdProposal) => {
    // 人がボタンを押したときだけ（スクリプトから押したことにはできない）
    if (!e.nativeEvent.isTrusted) return;
    const shop = getShop();
    const nowIso = new Date().toISOString();
    const today = shopToday(shop).today.date;
    // 広告（架空）・ToDo・日誌を同じ1回で変える（書く直前に読みなおした物で）
    let journal: { who: JournalWho; text: string }[] = [];
    ads.update((a) => {
      let next = a;
      bookState.update((b) => {
        const out = approveAd(a, b, x.id, { nowIso, today, shop, settings: ads.settings });
        next = out.ads;
        journal = out.journal;
        return out.book;
      });
      return next;
    });
    writeJournal(...journal);
    setDone(`✓ ${ads.settings.channel}で ${x.no}番「${x.text}」を${x.action === "stop" ? "止めました" : "外しました"}。ToDo に「効いたか見る」を足しました`);
    setFixOpen(false);
  };

  const skip = (e: React.MouseEvent, x: AdProposal) => {
    if (!e.nativeEvent.isTrusted) return;
    ads.update((a) => withAdSkipped(a, x.id, new Date().toISOString()));
    writeJournal({ who: "オーナー", text: `見送り：広告の案「${proposalLabel(x)}」を閉じた（広告は変えていない）` });
    setDone(`見送りました：${x.no}番を${actionVerb(x.action)}案を閉じました`);
    setFixOpen(false);
  };

  async function sendFix(x: AdProposal, mode: AdsMode) {
    const text = fixText.trim().slice(0, MAX_FIX_CHARS);
    if (!text || busy || x.fixed) return;
    setBusy(true);
    setNote(null);
    writeJournal({ who: "オーナー", text: `直す${mode === "script" ? "（決まった返事で）" : ""}：広告の案「${proposalLabel(x)}」に「${text}」と一言` });
    const res = await askAdsReview({
      mode,
      table: ads.table,
      rules: rules.filter((r) => !r.locked),
      fix: { text, current: { action: x.action, no: x.no } },
    });
    setBusy(false);
    if (!res.ok && res.code !== "gate") {
      if (res.code === "no-ai") {
        setNoAi(true);
        setNote(`${NO_AI_MESSAGE}。案はそのままです。`);
      } else setNote(`うまくいきませんでした。${res.message}。一言を短くして送ってください。`);
      return;
    }
    setNoAi(false);
    writeJournal(...res.steps);
    if (res.ok) {
      // 受け取った案を、この画面でももう一度門で確かめる
      const again = checkDraft(ads.table, ads.settings.towns, { tool: res.proposal.action === "stop" ? "stop_keyword" : "exclude_term", action: res.proposal.action, no: res.proposal.no, reason: res.proposal.reason, extraKeys: [] });
      if (again.ok) {
        ads.update((a) => withAdFixed(a, x.id, again.proposal, ads.table, again.checks));
        setNote(`出しなおしました：${proposalLabel(again.proposal)}。もう一度見て押してください（直すは1回までです）`);
        setFixOpen(false);
        return;
      }
    }
    ads.update((a) => withAdFixUsed(a, x.id));
    setNote(`直した案はプログラムの確認を通らなかったので、前の案のままです${!res.ok ? `（${res.problems.join("。")}）` : ""}。直すは1回までです。`);
    setFixOpen(false);
  }

  const row = p ? (
    <li className="approval ad-card">
      <div className="approval-what">
        <span className="tag hold">広告の案</span>
        <span className="tag fictional">架空</span>
        <span className="tag who-ai">{p.mode === "script" ? "決まった返事" : "AI"}</span>
        {p.fixed && <span className="tag">直した</span>}
      </div>
      <div className="ad-change">
        <span>
          {p.no}番「{p.text}」
        </span>
        <span>{before(p.action)}</span>
        <span className="arrow" aria-label="から">
          →
        </span>
        <strong>{after(p.action)}</strong>
      </div>
      {p.before && (
        <p className="hint small">
          直す前：{p.before.no}番「{p.before.text}」を{actionVerb(p.before.action)}
        </p>
      )}
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
        <small className="hint">（数は表からプログラムが入れました）</small>
      </p>
      <GateChecks checks={p.checks} />
      <div className="approval-buttons" role="group" aria-label="この広告の案をどうするか">
        <button type="button" className="btn primary" onClick={(e) => approve(e, p)} disabled={busy}>
          承認
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setFixOpen((v) => !v)}
          disabled={busy || p.fixed}
          title={p.fixed ? "直すは1回までです" : "一言で AI に1回だけ出しなおしてもらいます"}
        >
          直す
        </button>
        <button type="button" className="btn" onClick={(e) => skip(e, p)} disabled={busy}>
          見送り
        </button>
      </div>
      {p.fixed && <p className="hint small">直すは1回までです。承認か見送りを押してください。</p>}
      {fixOpen && !p.fixed && (
        <form
          className="ad-fix"
          onSubmit={(e) => {
            e.preventDefault();
            void sendFix(p, p.mode);
          }}
        >
          <input
            value={fixText}
            onChange={(e) => setFixText(e.target.value)}
            placeholder="例：3番を止めて"
            maxLength={MAX_FIX_CHARS}
            aria-label="直す一言"
            disabled={busy}
          />
          <button type="submit" className="btn small" disabled={busy || !fixText.trim()}>
            {busy ? "出しなおし中…" : "出しなおす"}
          </button>
        </form>
      )}
      {noAi && (
        <div className="noai" role="alert">
          <strong>{NO_AI_MESSAGE}</strong>
          <button type="button" className="btn small" onClick={() => void sendFix(p, "script")} disabled={busy || !fixText.trim()}>
            決まった返事で試す（AI なし）
          </button>
        </div>
      )}
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
    </li>
  ) : null;

  if (!standalone) return row;
  return (
    <>
      {row ? <ul className="approvals compact">{row}</ul> : <p className="checked">✓ 広告の案の承認待ちはありません</p>}
      {done && !row && (
        <p className="hint" role="status">
          {done}
        </p>
      )}
    </>
  );
}
