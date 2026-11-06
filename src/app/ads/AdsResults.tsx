"use client";

// 広告タブの真ん中：「効いたかの判定」と「毎週の見直しの報告」（docs/SPEC.md §1.7.1・§1.7.2）。
// 判定はプログラム（verdict.ts）、報告の数もプログラム（weekly.ts）。AI は数を書かない。
// AI（Haiku）の一言は、AI で作った案の物だけに、1回だけ頼む（言葉の門を通った時だけ出す。AI につながらない時は出さない）。

import { useEffect, useRef, useState } from "react";
import { BigNumber, Checked, Fold } from "@/components/parts";
import { askAdsNote, judgementFacts, nextNoteTarget, reportFacts } from "@/lib/ads/noteClient";
import { actionPast, yen } from "@/lib/ads/report";
import { VERDICT_LABEL, type AdJudgement, type AdWeeklyReport } from "@/lib/ads/results";
import { useAdResults } from "@/lib/ads/useResults";
import { dueLabel } from "@/lib/ads/verdict";
import { reportLines, withNote } from "@/lib/ads/weekly";
import { writeJournal } from "@/lib/journal";
import { DEMO_TAG_NOTE } from "@/lib/notices";
import type { ShopSettings } from "@/lib/settings";

const MARK: Record<AdJudgement["verdict"], string> = { worked: "✓", revert: "↩", unknown: "？" };

function Compare({ label, before, after, unit, fmt }: { label: string; before: number; after: number; unit: string; fmt?: (n: number) => string }) {
  const f = fmt ?? ((n: number) => `${n.toLocaleString("ja-JP")}${unit}`);
  return (
    <div className="ad-compare-item">
      <BigNumber label={`${label}（後）`} value={after} unit={unit} />
      <span className="hint small">前 {f(before)}</span>
    </div>
  );
}

function JudgementCard({ j, shop }: { j: AdJudgement; shop: ShopSettings }) {
  const cls = j.verdict === "worked" ? "ok" : j.verdict === "revert" ? "ng" : "";
  return (
    <article className={`verdict ad-verdict ${cls}`} aria-label={`${j.no}番の判定`}>
      <div className="approval-what">
        <span className="tag who-program">プログラムの判定</span>
        {j.demo && <span className="tag text">デモ：判定日まで進めた</span>}
      </div>
      <p className="verdict-head">
        <span aria-hidden>{MARK[j.verdict]}</span> {VERDICT_LABEL[j.verdict]}
      </p>
      <p className="ad-change">
        <span>
          {j.no}番「{j.text}」を{actionPast(j.action)}
        </span>
        <span className="arrow" aria-hidden>
          →
        </span>
        <span>後の{j.weeks}週</span>
      </p>
      <div className="ad-compare">
        <Compare label="お金" before={j.before.cost} after={j.after.cost} unit="円" fmt={yen} />
        <Compare label="予約" before={j.before.bookings} after={j.after.bookings} unit="件" />
        <Compare label="押された回数" before={j.before.clicks} after={j.after.clicks} unit="回" />
      </div>
      <p className="verdict-what">{j.why}</p>
      {j.note && (
        <p className="ad-note">
          <span className="tag who-ai">AI の一言</span> {j.note}
        </p>
      )}
      {j.revert?.state === "pending" && <p className="problems small">戻す案は承認の箱にあります（決めるのはオーナーです）。</p>}
      {j.revert?.state === "approved" && <Checked>戻す案を承認して、元に戻しました</Checked>}
      {j.revert?.state === "skipped" && <p className="hint small">戻す案は見送りました（{actionPast(j.action)}ままです）。</p>}
      <Fold summary="くわしく（比べた数と決まり）">
        <ul>
          <li>
            判定日 {dueLabel(shop, j.due)}（承認の{j.weeks}週間後。ToDo「効いたか見る」の期限）
          </li>
          <li>
            前＝{actionPast(j.action)}前の{j.weeks}週、後＝{actionPast(j.action)}後の{j.weeks}週（どちらも広告を出す言葉みんなの数。後の数は前もって用意した数）
          </li>
          <li>
            {j.no}番そのものの前の{j.weeks}週：押された {j.word.clicks}回・{yen(j.word.cost)}・予約 {j.word.bookings}件
          </li>
        </ul>
      </Fold>
    </article>
  );
}

function ReportCard({ r, lines, latest }: { r: AdWeeklyReport; lines: ReturnType<typeof reportLines>; latest: boolean }) {
  return (
    <article className={`ad-report${latest ? " latest" : ""}`} aria-label="見直しの報告">
      <div className="approval-what">
        <strong>見直しの報告</strong>
        <span className={r.mode === "script" ? "tag text" : "tag who-ai"}>{r.mode === "script" ? "決まった返事" : "AI"}</span>
        {r.fromJobs && <span className="tag text">AI の仕事から</span>}
      </div>
      <ol className="ad-report-lines">
        <li>
          <b>見た数字</b>
          <span>{lines.seen}</span>
        </li>
        <li>
          <b>止めた・外した言葉</b>
          <span>
            {lines.changed}
            {lines.changedReason && <small className="hint"> {lines.changedReason}</small>}
          </span>
        </li>
        <li>
          <b>止めなかった言葉とその理由</b>
          <ul>
            {lines.kept.map((k, i) => (
              <li key={i}>{k}</li>
            ))}
          </ul>
        </li>
        <li>
          <b>次に見る日</b>
          <span>{lines.next}</span>
        </li>
      </ol>
      {r.note && (
        <p className="ad-note">
          <span className="tag who-ai">AI の一言</span> {r.note}
        </p>
      )}
    </article>
  );
}

export function AdsResults() {
  const { ads, book, shop, today, waiting, judgeNextDemo } = useAdResults();
  const [msg, setMsg] = useState<string | null>(null);
  const judgements = ads.state.judgements ?? [];
  const reports = ads.state.reports ?? [];

  // AI の一言：AI で作った案の判定・報告に、1回だけ頼む（つながらない・門に当たった時は出さない）
  const busy = useRef(false);
  const [tick, setTick] = useState(0);
  const target = nextNoteTarget(ads.state);
  const targetKey = target ? `${target.kind}:${target.item.id}` : "";
  const { update, settings } = ads;
  useEffect(() => {
    if (!targetKey || busy.current || !target) return;
    busy.current = true;
    const { kind, item } = target;
    update((s) => withNote(s, kind, item.id, null));
    const facts = kind === "judgement" ? judgementFacts(item) : reportFacts(item, ads.state);
    void askAdsNote(facts, settings.gateWords)
      .then((note) => {
        if (!note) return;
        update((s) => withNote(s, kind, item.id, note));
        writeJournal({ who: "AI", text: `${kind === "judgement" ? `判定（${item.no}番）` : "見直しの報告"}に一言を付けた（言葉の門を通した）：${note}` });
      })
      .finally(() => {
        busy.current = false;
        setTick((n) => n + 1);
      });
    // target は targetKey が同じなら同じ物
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, tick]);

  const demo = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    const n = judgeNextDemo();
    setMsg(n > 0 ? "判定しました（デモ：判定日まで進めたことにしました）。日誌と ToDo にも出しています。" : "判定を待っている言葉はありません。");
  };

  const next = waiting[0];

  return (
    <>
      <section className="inline-box ad-results" aria-labelledby="ad-judge">
        <h2 id="ad-judge">効いたかの判定</h2>
        <p className="section-desc">承認した案が効いたかを、承認の{ads.settings.checkAfterDays}日後に、前と後の数でプログラムが比べます</p>
        {judgements.length === 0 && <p className="hint">まだ判定はありません。案を承認すると、{ads.settings.checkAfterDays}日後にここに出ます。</p>}
        {waiting.length > 0 && (
          <>
            <ul className="ad-waiting">
              {waiting.map((w) => (
                <li key={w.applied.proposalId}>
                  {w.applied.no}番「{ads.table.keywords.concat(ads.table.searchTerms).find((r) => r.no === w.applied.no)?.text ?? ""}」：判定日 {dueLabel(shop, w.due)}
                  {w.due <= today ? <span className="tag hold">今日</span> : null}
                </li>
              ))}
            </ul>
            <div className="reset-row">
              <span className="tag text" title={DEMO_TAG_NOTE}>
                デモ<span className="sr-only">（{DEMO_TAG_NOTE}）</span>
              </span>
              <button type="button" className="btn" onClick={demo}>
                判定日まで進める（デモ）
              </button>
              <small className="hint">
                {next ? `${next.applied.no}番を、判定日（${dueLabel(shop, next.due)}）まで進めたことにして判定します。` : ""}ホームの「翌日へ」で判定日まで進めても届きます。
              </small>
            </div>
          </>
        )}
        {msg && (
          <p className="hint" role="status">
            {msg}
          </p>
        )}
        {judgements.map((j) => (
          <JudgementCard key={j.id} j={j} shop={shop} />
        ))}
      </section>

      <section className="inline-box ad-results" aria-labelledby="ad-reports">
        <h2 id="ad-reports">毎週の見直しの報告</h2>
        {reports.length === 0 ? (
          <p className="hint">見直しを1回するたびに、ここに4行の報告を残します（見た数字・止めた言葉・止めなかった言葉・次に見る日）。</p>
        ) : (
          <>
            <ReportCard r={reports[0]} lines={reportLines(reports[0], ads.state, book.state, shop, ads.settings)} latest />
            {reports.length > 1 && (
              <Fold summary={`前の週の報告（${reports.length - 1}枚）`}>
                {reports.slice(1).map((r) => (
                  <ReportCard key={r.id} r={r} lines={reportLines(r, ads.state, book.state, shop, ads.settings)} latest={false} />
                ))}
              </Fold>
            )}
          </>
        )}
      </section>
    </>
  );
}
