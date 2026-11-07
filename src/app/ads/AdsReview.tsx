"use client";

// 広告タブの右の列：「AI に見直してもらう」。表とルールを /api/ai/ads へ送り、門を通った案を1つ承認の箱に入れる。
// 門を2回通らなかったら案は出さず、日誌に書く。1週間に1つまで・もう案がある時は新しく出さない。
// AI につながらない時は「今は AI につながりません」と出し、決まった返事（AI なし）で同じ流れを試せる。
// 押せない時（7日に1つまで・承認待ちがある）は、ボタンのすぐ下にふつうの字で理由と次に頼める日時を出し、
// その下に「デモ」の札と「広告を最初に戻す」を出す。押せる時は「最初に戻す」を欄の一番下に出す（いつも1か所だけ）。

import { scrollToId } from "@/lib/scroll";
import { useState } from "react";
import { GateChecks } from "@/components/AdApprovalRows";
import { askAdsReview } from "@/lib/ads/client";
import { checkDraft, proposalLabel, type GateCheck } from "@/lib/ads/gate";
import { addLabel, addRowsFrom } from "@/lib/ads/add";
import { featuredWords } from "@/lib/ads/featured";
import { canPropose, resetAds, withReview, type AdsState } from "@/lib/ads/state";
import { buildWeeklyReport, withReport } from "@/lib/ads/weekly";
import type { GatedProposal } from "@/lib/ads/gate";
import type { RejectedDraft } from "@/lib/ads/review";
import { demoClock, demoInstant } from "@/lib/calendar";
import { getAdsMaxAdds, getMenus, getShop } from "@/lib/settings";
import { useAds } from "@/lib/ads/useAds";
import type { AdsMode } from "@/lib/ads/wire";
import { AI_BUSY_MESSAGE, failText } from "@/lib/ai/busy";
import { NO_AI_MESSAGE } from "@/lib/ai/wire";
import { useBookState } from "@/lib/book/useBook";
import { writeJournal } from "@/lib/journal";
import { DEMO_TAG_NOTE } from "@/lib/notices";
import type { Rule } from "@/lib/rules/types";
import { useRules } from "@/lib/rules/useRules";

type Shown =
  | { kind: "ok"; text: string; checks: GateCheck[]; tries: number; adds: string[] }
  | { kind: "gate"; problems: string[]; checks: GateCheck[]; adds: string[] }
  | { kind: "note"; text: string };

const MAX_ADDS = getAdsMaxAdds();

/** 広告のタブの「承認待ち」の見出しの id（うまくいった直後のリンクの先） */
export const ADS_APPROVALS_ID = "ads-approvals";

export function AdsReview({ seedRules, timezone }: { seedRules: Rule[]; timezone: string }) {
  const ads = useAds();
  const book = useBookState();
  const { rules } = useRules(seedRules);
  const [mode, setMode] = useState<AdsMode>("ai");
  const [busy, setBusy] = useState(false);
  const [noAi, setNoAi] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);

  // 「7日に1つ」は「翌日へ」で進めた日付の時計で数える（作った時刻・画面・送る前・保存する時の全部で同じ。calendar.ts の demoInstant）
  const clockIso = () => demoInstant(getShop(), new Date(), book.state.dayOffset).toISOString();
  const can = canPropose(ads.state, clockIso(), ads.settings);
  const nextLabel =
    !can.ok && can.nextAt
      ? new Date(can.nextAt).toLocaleString("ja-JP", { timeZone: timezone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      : null;

  async function ask(useMode: AdsMode) {
    if (busy) return;
    const c = canPropose(ads.state, clockIso(), ads.settings);
    if (!c.ok) return;
    setBusy(true);
    setShown(null);
    writeJournal({ who: "オーナー", text: `広告の見直しを頼んだ（${useMode === "script" ? "決まった返事・AI なし" : "AI"}）` });
    const table = ads.table;
    const res = await askAdsReview({ mode: useMode, table, rules: rules.filter((r) => !r.locked) });
    setBusy(false);
    // 見直しを1回するたびに、報告を1枚残す（数はプログラムが表から入れる。weekly.ts）
    const report = (x: { proposal?: GatedProposal & { id: string }; failed?: string; rejected?: RejectedDraft[] }) => {
      const shop = getShop();
      return buildWeeklyReport({
        id: `rp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        nowIso: clockIso(),
        today: demoClock(shop, new Date(), book.state.dayOffset).today.date,
        table,
        shop,
        settings: ads.settings,
        mode: useMode,
        ...x,
      });
    };
    if (!res.ok) {
      if (res.code === "no-ai") {
        writeJournal({ who: "プログラム", text: `${NO_AI_MESSAGE}でした。広告の案は出していません` });
        setNoAi(true);
        return;
      }
      if (res.code === "busy") {
        // 混んでいる（1分10回まで）：案は作らず、待ってから押しなおせる（「今は AI につながりません」とは分ける）
        writeJournal({ who: "プログラム", text: "AI の窓口が混んでいたので、広告の案は出していません" });
        setShown({ kind: "note", text: AI_BUSY_MESSAGE });
        return;
      }
      if (res.code === "bad-request") {
        if (useMode === "ai") setNoAi(false);
        setShown({ kind: "note", text: failText(res.message, "画面を開きなおしてから押してください。") });
        return;
      }
    }
    if (useMode === "ai") setNoAi(false);
    const nowIso = clockIso();
    const id = `ad-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    // 止める・外すの案（今と同じ流れ）：受け取った案を、この画面でももう一度門で確かめる
    const again = res.ok
      ? checkDraft(ads.table, ads.settings.towns, {
          tool: res.proposal.action === "stop" ? "stop_keyword" : "exclude_term",
          action: res.proposal.action,
          no: res.proposal.no,
          reason: res.proposal.reason,
          extraKeys: [],
        })
      : null;
    const stop = again?.ok ? again : null;
    // 足す案（止める・外すの結果に関係なく）：画面でも足す用の4つと言葉の門で確かめなおす。同じ回に外す言葉は足さない
    const addPart = addRowsFrom(table, featuredWords(ads.settings, getMenus()), res.adds?.picks, {
      baseId: id,
      maxAdds: MAX_ADDS,
      ...(stop?.proposal.action === "exclude" ? { skipNo: stop.proposal.no } : {}),
    });
    const addSteps = [...(res.adds?.steps ?? []), ...addPart.refused];
    const addLabels = addPart.rows.map((r) => addLabel({ no: r.no, text: table.searchTerms.find((t) => t.no === r.no)?.text ?? "" }));
    const addLine = addLabels.length ? [{ who: "プログラム" as const, text: `承認の箱に入れた：足す案 ${addLabels.map((l) => `「${l}」`).join("・")}` }] : [];
    const withAdds = (s: AdsState) => (addPart.rows.length ? withReview(s, { adds: addPart.rows }, table, { nowIso, mode: useMode }, ads.settings) : s);

    if (!res.ok || !stop) {
      const problems = !res.ok ? res.problems : again && !again.ok ? again.problems : [];
      const checks = !res.ok ? res.checks : again && !again.ok ? again.checks : [];
      const failed = !res.ok
        ? `案はプログラムの確認を通らなかったので、出しませんでした（${problems.join("。")}）`
        : `案は画面の確認を通らなかったので、出しませんでした（${problems.join("。")}）`;
      writeJournal(
        ...res.steps,
        ...(res.ok ? [{ who: "プログラム" as const, text: `画面の確認で弾いた：${problems.join("。")}（案は出さなかった）` }] : []),
        ...addSteps,
        ...addLine,
      );
      ads.update((s) => withReport(withAdds(s), report({ failed, rejected: res.rejected }), ads.settings));
      setShown({ kind: "gate", problems, checks, adds: addLabels });
      return;
    }
    const weekly = report({ proposal: { ...stop.proposal, id }, rejected: res.rejected });
    ads.update((s) => {
      const next = withReview(s, { proposal: { ...stop.proposal, id, checks: stop.checks }, adds: addPart.rows }, table, { nowIso, mode: useMode }, ads.settings);
      return next === s ? s : withReport(next, weekly, ads.settings);
    });
    writeJournal(
      ...res.steps,
      { who: "プログラム", text: `承認の箱に入れた：広告の案「${proposalLabel(stop.proposal)}」（見直しの報告も広告タブに残した）` },
      ...addSteps,
      ...addLine,
    );
    setShown({ kind: "ok", text: proposalLabel(stop.proposal), checks: stop.checks, tries: res.tries, adds: addLabels });
  }

  const reset = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    let nextAds = ads.state;
    book.update((b) => {
      const out = resetAds(b);
      nextAds = out.ads;
      return out.book;
    });
    ads.update(() => nextAds);
    writeJournal({ who: "オーナー", text: "広告を最初に戻した（止めた・外した言葉と広告の案、効いたかの判定・見直しの報告、広告から足した ToDo を消した）" });
    setShown({ kind: "note", text: "広告を最初に戻しました。" });
  };

  // 「最初に戻す」は試すための物なので「デモ」の札を付ける。部品は1つで、押せる時と押せない時で置く所だけ変える
  const demoTag = (
    <span className="tag text" title={DEMO_TAG_NOTE}>
      デモ<span className="sr-only">（{DEMO_TAG_NOTE}）</span>
    </span>
  );
  const resetButton = (
    <button type="button" className="btn small" onClick={reset}>
      広告を最初に戻す
    </button>
  );
  const resetNote = <small className="hint">止めた・外した言葉と案・判定・報告を消します（日誌には残ります）</small>;

  return (
    <div className="ad-review">
      <p className="hint">
        4週分の表を AI が見て、「N番を止める」か「N番を外す」を1つだけ出します。プログラムが確かめてから承認の箱に入れます。決めるのはオーナーです。
      </p>
      <div className="chat-mode" role="group" aria-label="案を作る物">
        <button type="button" className={mode === "ai" ? "chat-mode-on" : "chat-mode-off"} aria-pressed={mode === "ai"} onClick={() => setMode("ai")}>
          AI（Claude）
        </button>
        <button
          type="button"
          className={mode === "script" ? "chat-mode-on" : "chat-mode-off"}
          aria-pressed={mode === "script"}
          onClick={() => setMode("script")}
          title="AI を使わず、決まった返事で同じ流れを試します"
        >
          決まった返事（AI なし）
        </button>
      </div>
      <button type="button" className="btn primary big" onClick={() => void ask(mode)} disabled={busy || !can.ok}>
        {busy ? "見直しています…" : "AI に見直してもらう"}
      </button>
      {/* うまくいった直後は、入れた事と決める所へのリンクを先に（押せない理由はその下に、ふつうの字で） */}
      {shown?.kind === "ok" && (
        <div role="status">
          <p className="checked">
            <span aria-hidden>✓</span> 承認の箱に入れました：{shown.text}
            {shown.tries > 1 && "（1回弾いて、作り直した案です）"}。
            <a
              href={`#${ADS_APPROVALS_ID}`}
              className="ad-review-go"
              onClick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                scrollToId(ADS_APPROVALS_ID, { hash: true });
              }}
            >
              <span className="sp-inline">すぐ下で決める ↓</span>
              <span className="pc-inline">左の承認待ちで決める ←</span>
            </a>
          </p>
          <strong>プログラムの確認</strong>
          <GateChecks checks={shown.checks} />
          {shown.adds.length > 0 && <p className="checked">✓ 足す案も入れました：{shown.adds.join("・")}</p>}
        </div>
      )}
      {!can.ok && (
        <>
          <p className="ad-review-why" role={shown?.kind === "ok" ? undefined : "status"}>
            {can.reason}
            {nextLabel && `次は ${nextLabel} から頼めます。`}
          </p>
          <div className="ad-review-reset">
            <p>
              {demoTag} 広告を最初に戻すと、もう一度試せます
            </p>
            {resetButton}
          </div>
        </>
      )}

      {noAi && (
        <div className="noai" role="alert">
          <strong>{NO_AI_MESSAGE}</strong>
          <span>表・承認の箱・日誌など、ほかの画面はそのまま使えます。</span>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setMode("script");
              setNoAi(false);
              void ask("script");
            }}
            disabled={busy || !can.ok}
          >
            決まった返事で試す（AI なし）
          </button>
        </div>
      )}

      {shown?.kind === "gate" && (
        <div role="status">
          <p className="problems">プログラムの確認を通らなかったので、案は出しませんでした（日誌に書きました）。</p>
          <ul className="gate">
            {shown.problems.map((p, i) => (
              <li key={i} className="ng">
                ✗ {p}
              </li>
            ))}
          </ul>
          <strong>プログラムの確認</strong>
          <GateChecks checks={shown.checks} />
          {shown.adds.length > 0 && <p className="checked">✓ 足す案は承認の箱に入れました：{shown.adds.join("・")}</p>}
        </div>
      )}
      {shown?.kind === "note" && (
        <p className="hint" role="status">
          {shown.text}
        </p>
      )}

      {can.ok && (
        <div className="reset-row">
          {resetButton}
          {demoTag}
          {resetNote}
        </div>
      )}
    </div>
  );
}
