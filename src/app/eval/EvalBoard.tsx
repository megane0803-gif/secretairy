"use client";

// 試験10問の画面（docs/SPEC.md §1.13）。ボタン1つで10問を順に流し、合否と答えを表で出す。
// 窓口は今の /api/ai/ の物をそのまま使う。1問ごとに決まった秒数あける（1分10回の上限のため）。
// 結果はこの画面の表だけ。ブラウザにも残さず、どこにも送らない（日誌にも書かない）。

import { useEffect, useRef, useState } from "react";
import { BigNumber, Fold } from "@/components/parts";
import type { BookData } from "@/lib/book/data";
import type { PostMemo } from "@/lib/data/types";
import { browserEvalAsk } from "@/lib/eval/ask";
import { buildQuestions, EVAL_PATHS, type EvalMode, type EvalQuestion } from "@/lib/eval/questions";
import { runEval, tally, type EvalResult, type EvalStatus } from "@/lib/eval/run";

const STATUS_LABEL: Record<EvalStatus, string> = {
  pass: "✓ 合格",
  fail: "✗ 不合格",
  "no-ai": "AI につながらない",
  error: "窓口が受けなかった",
  skipped: "流していない",
};

export function EvalBoard({
  data,
  memos,
  postGateWords,
  intervalSeconds,
  karteLabels,
}: {
  data: BookData;
  memos: PostMemo[];
  postGateWords: string[];
  intervalSeconds: number;
  karteLabels: Record<string, string>;
}) {
  const [mode, setMode] = useState<EvalMode>("ai");
  const [questions, setQuestions] = useState<EvalQuestion[]>([]);
  const [results, setResults] = useState<Record<number, EvalResult>>({});
  const [running, setRunning] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const stopRef = useRef(false);

  // 問いは押したその時の日付で作る（画面を開いた時にも、いまの日付で見せる）
  useEffect(() => {
    setQuestions(buildQuestions({ data, memos, postGateWords, now: new Date(), mode }));
  }, [data, memos, postGateWords, mode]);

  async function start() {
    if (busy) return;
    const now = new Date();
    const qs = buildQuestions({ data, memos, postGateWords, now, mode });
    setQuestions(qs);
    setResults({});
    setBusy(true);
    setStartedAt(now.toLocaleString("ja-JP", { timeZone: data.shop.timezone }));
    stopRef.current = false;
    setRunning(qs[0]?.no ?? null);
    await runEval(qs, {
      ask: browserEvalAsk,
      intervalMs: intervalSeconds * 1000,
      shouldStop: () => stopRef.current,
      labels: karteLabels,
      onResult: (r) => {
        setResults((m) => ({ ...m, [r.no]: r }));
        setRunning(r.no < qs.length ? r.no + 1 : null);
      },
    });
    setRunning(null);
    setBusy(false);
  }

  const done = questions.map((q) => results[q.no]).filter((r): r is EvalResult => !!r);
  const t = tally(done);
  const copy = done.length
    ? [
        `流した日時：${startedAt ?? ""}（${mode === "ai" ? "AI" : "決まった返事（AI なし）"}）`,
        `合格 ${t.pass} / ${questions.length}`,
        "",
        "| 番号 | 問い | 合否 | 落ちた条件 |",
        "|---|---|---|---|",
        ...done.map((r) => `| ${r.no} | ${r.title} | ${STATUS_LABEL[r.status]} | ${r.checks.filter((c) => !c.ok).map((c) => `${c.label}${c.note ? `（${c.note}）` : ""}`).join("／") || "—"} |`),
      ].join("\n")
    : "";

  return (
    <main className="page-main eval">
      <div className="page-head">
        <h1>試験10問</h1>
      </div>
      <p className="eval-lead">
        架空の店の決まり（<code>config/</code>・<code>seed/</code>）から作った10問を、今の AI の窓口（{Object.values(EVAL_PATHS).join("・")}）に1問ずつ流し、
        合否をプログラムで判定します（判定に AI は使いません）。
      </p>
      <ul className="eval-notes">
        <li>1問ごとに {intervalSeconds}秒 あけます（AI の窓口は1分10回までのため）。10問で2分ほどかかります。</li>
        <li>結果はこの画面の表だけに出します。どこにも送らず、ブラウザにも残しません（台帳・日誌も変えません）。</li>
        <li>送る台帳とルールは最初の状態の物です。このページは左のタブには出していません。</li>
      </ul>

      <div className="eval-controls">
        <button type="button" className="btn primary" onClick={start} disabled={busy}>
          {busy ? `流しています（${running ?? "-"} / ${questions.length}）` : "10問を流す"}
        </button>
        {busy && (
          <button type="button" className="btn" onClick={() => (stopRef.current = true)}>
            止める
          </button>
        )}
        <label className="eval-mode">
          <input type="checkbox" checked={mode === "script"} disabled={busy} onChange={(e) => setMode(e.target.checked ? "script" : "ai")} />
          決まった返事（AI なし）で形だけ試す
        </label>
      </div>

      {done.length > 0 && (
        <div className="bignums eval-score" aria-live="polite">
          <BigNumber label="合格" value={t.pass} unit={`/ ${questions.length}`} />
          <BigNumber label="不合格" value={t.fail} />
          {t.other > 0 && <BigNumber label="流せなかった" value={t.other} />}
        </div>
      )}

      <div className="eval-table-wrap">
        <table className="table eval-table">
          <thead>
            <tr>
              <th>番号</th>
              <th>問い（決まりのある所）</th>
              <th>頼む文</th>
              <th>合否</th>
              <th>答え</th>
              <th>合格の条件</th>
            </tr>
          </thead>
          <tbody>
            {questions.map((q) => {
              const r = results[q.no];
              const checks = r?.checks.length ? r.checks : q.checks.map((c) => ({ label: c.label, ok: null as boolean | null, note: undefined as string | undefined }));
              return (
                <tr key={q.id} className={r ? `is-${r.status}` : running === q.no ? "is-running" : ""}>
                  <td className="num" data-label="番号">{q.no}</td>
                  <td data-label="問い">
                    <strong>{q.title}</strong>
                    <div className="eval-src">{q.source}</div>
                  </td>
                  <td data-label="頼む文" className="eval-text">{q.prompt}</td>
                  <td data-label="合否" className="eval-status">
                    {r ? STATUS_LABEL[r.status] : running === q.no ? "流しています…" : "まだ"}
                    {r && r.ms > 0 && <div className="eval-src">{(r.ms / 1000).toFixed(1)}秒</div>}
                  </td>
                  <td data-label="答え" className="eval-text">{r?.answer ?? ""}</td>
                  <td data-label="合格の条件">
                    <ul className="eval-checks">
                      {checks.map((c, i) => (
                        <li key={i} className={c.ok === null ? "" : c.ok ? "ok" : "ng"}>
                          <span aria-hidden>{c.ok === null ? "・" : c.ok ? "✓" : "✗"}</span> {c.label}
                          {c.note && <span className="eval-src">（{c.note}）</span>}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {copy && !busy && (
        <Fold summary="README に写す形">
          <textarea className="eval-copy" readOnly value={copy} rows={Math.min(16, copy.split("\n").length + 1)} />
        </Fold>
      )}
    </main>
  );
}
