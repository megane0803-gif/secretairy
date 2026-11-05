"use client";

// 試験10問の画面（docs/SPEC.md §1.13）。合言葉を打ってから、ボタン1つで10問を順に流し、合否と答えを表で出す。
// 窓口は今の /api/ai/ の物をそのまま使う。1問ごとに決まった秒数あける（1分10回の上限のため）。
// 守り：合言葉（EVAL_PASSCODE。中身は画面・表に出さない）・同時に1回だけ（この画面の中と、Web Locks でほかの画面とも）・止めるボタン・1回の試験で呼ぶ回数の上限。
// 結果はこの画面の表だけ。ブラウザにも残さず、どこにも送らない（台帳・LINE・日誌も変えない）。

import { useEffect, useRef, useState } from "react";
import { BigNumber, Fold } from "@/components/parts";
import type { BookData } from "@/lib/book/data";
import type { PostMemo } from "@/lib/data/types";
import { browserEvalAsk, startEval } from "@/lib/eval/ask";
import { buildQuestions, EVAL_PATHS, type EvalMode, type EvalQuestion } from "@/lib/eval/questions";
import { EvalBusyError, runEval, tally, UNRUN_LABEL, type EvalResult } from "@/lib/eval/run";

const LOCK_NAME = "secretairy-eval";

type RunMeta = { at: string; commit: string; models: { reserve: string; karte: string; posts: string }; mode: EvalMode };

function statusLabel(r: EvalResult): string {
  if (r.status === "pass") return "✓ 合格";
  if (r.status === "fail") return "✗ 不合格";
  return "流せなかった";
}

export function EvalBoard({
  data,
  memos,
  postGateWords,
  intervalSeconds,
  maxCalls,
  maxPasscodeChars,
  karteLabels,
}: {
  data: BookData;
  memos: PostMemo[];
  postGateWords: string[];
  intervalSeconds: number;
  maxCalls: number;
  maxPasscodeChars: number;
  karteLabels: Record<string, string>;
}) {
  const [mode, setMode] = useState<EvalMode>("ai");
  // 合言葉は state に持たない（React が value の印として DOM に書かないように）。押した時に欄から読むだけ
  const passRef = useRef<HTMLInputElement>(null);
  const [hasPass, setHasPass] = useState(false);
  const [questions, setQuestions] = useState<EvalQuestion[]>([]);
  const [results, setResults] = useState<Record<number, EvalResult>>({});
  const [running, setRunning] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<RunMeta | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const stopRef = useRef(false);

  // 問いは押したその時の日付で作る（画面を開いた時にも、いまの日付で見せる）
  useEffect(() => {
    setQuestions(buildQuestions({ data, memos, postGateWords, now: new Date(), mode }));
  }, [data, memos, postGateWords, mode]);

  async function runLocked(passcode: string) {
    setProblem(null);
    const started = await startEval(passcode);
    if (!started.ok) {
      setProblem(started.message);
      return;
    }
    const now = new Date();
    const qs = buildQuestions({ data, memos, postGateWords, now, mode });
    setQuestions(qs);
    setResults({});
    setMeta({ at: now.toLocaleString("ja-JP", { timeZone: data.shop.timezone }), commit: started.commit, models: started.models, mode });
    stopRef.current = false;
    setRunning(qs[0]?.no ?? null);
    try {
      await runEval(qs, {
        ask: browserEvalAsk,
        intervalMs: intervalSeconds * 1000,
        maxCalls,
        mode,
        labels: karteLabels,
        shouldStop: () => stopRef.current,
        onResult: (r) => {
          setResults((m) => ({ ...m, [r.no]: r }));
          setRunning(r.no < qs.length ? r.no + 1 : null);
        },
      });
    } catch (e) {
      setProblem(e instanceof EvalBusyError ? e.message : `うまくいきませんでした（${e instanceof Error ? e.message : String(e)}）`);
    }
  }

  async function start() {
    if (busy) return;
    const passcode = passRef.current?.value ?? "";
    if (!passcode) {
      setProblem("合言葉を入れてください");
      return;
    }
    setBusy(true);
    try {
      // 同時に1回だけ：ほかの画面（タブ）で流している間は流さない（Web Locks。ブラウザに何も残さない）
      const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
      if (locks) {
        await locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
          if (!lock) setProblem("ほかの画面で試験を流しています（同時に1回だけ）");
          else await runLocked(passcode);
        });
      } else await runLocked(passcode);
    } finally {
      setRunning(null);
      setBusy(false);
    }
  }

  const done = questions.map((q) => results[q.no]).filter((r): r is EvalResult => !!r);
  const t = tally(done);
  const errors = done.filter((r) => r.status === "unrun");
  const copy =
    done.length && meta
      ? [
          `流した日時：${meta.at}・コミット：${meta.commit}・モデル：予約 ${meta.models.reserve}／カルテ ${meta.models.karte}／発信 ${meta.models.posts}（${meta.mode === "ai" ? "AI" : "決まった返事（AI なし）"}）`,
          `合格 ${t.pass}・不合格 ${t.fail}・流せなかった ${t.unrun}（${questions.length}問）`,
          "",
          "| 番号 | 問い | 合否 | 落ちた条件・流せなかった訳 |",
          "|---|---|---|---|",
          ...done.map(
            (r) =>
              `| ${r.no} | ${r.title} | ${statusLabel(r)} | ${
                r.status === "unrun" ? `${UNRUN_LABEL[r.unrun?.code ?? "network"]}：${r.unrun?.message ?? ""}` : r.checks.filter((c) => !c.ok).map((c) => `${c.label}${c.note ? `（${c.note}）` : ""}`).join("／") || "—"
              } |`,
          ),
        ].join("\n")
      : "";

  return (
    <main className="page-main eval">
      <div className="page-head">
        <h1>試験10問</h1>
      </div>
      <p className="eval-lead">
        架空の店の決まり（<code>config/</code>・<code>seed/</code>）から作った10問を、今の AI の窓口（{Object.values(EVAL_PATHS).join("・")}）に1問ずつ流し、
        合否をプログラムで判定します（判定に AI は使いません）。返事の文だけでなく、結果（仮押さえ・候補・お店への ToDo）でも見ます。
      </p>
      <ul className="eval-notes">
        <li>合言葉を入れてから流します。合言葉はこの画面にも表にも出しません。</li>
        <li>
          1問ごとに {intervalSeconds}秒 あけます（AI の窓口は1分10回までのため）。1回の試験で窓口を呼ぶのは {maxCalls}回 までです。同時に流せるのは1回だけです。
        </li>
        <li>試験は専用の架空の状態（最初の状態の台帳とルール）で流します。結果はこの画面の表だけに出し、どこにも送らず、ブラウザにも残しません（台帳・LINE・日誌も変えません）。</li>
        <li>AI につながらない・通信のまちがい・空の返事・途中で止まった・決まった返事（AI なし）だった問いは、合格にも不合格にも数えず「流せなかった」に分けます。</li>
      </ul>

      <form
        className="eval-controls"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <label className="eval-pass">
          合言葉
          <input
            type="password"
            autoComplete="off"
            ref={passRef}
            name="eval-passcode"
            maxLength={maxPasscodeChars}
            disabled={busy}
            onChange={(e) => setHasPass(e.target.value.length > 0)}
          />
        </label>
        <button type="submit" className="btn primary" disabled={busy || !hasPass}>
          {busy ? `流しています（${running ?? "-"} / ${questions.length}）` : "10問を流す"}
        </button>
        {busy && (
          <button type="button" className="btn" onClick={() => (stopRef.current = true)}>
            止める
          </button>
        )}
        <label className="eval-mode">
          <input type="checkbox" checked={mode === "script"} disabled={busy} onChange={(e) => setMode(e.target.checked ? "script" : "ai")} />
          決まった返事（AI なし）で形だけ試す（合否に数えない）
        </label>
      </form>

      {problem && (
        <p className="eval-problem" role="alert">
          {problem}
        </p>
      )}

      {meta && (
        <dl className="eval-meta">
          <div>
            <dt>流した日時</dt>
            <dd>{meta.at}</dd>
          </div>
          <div>
            <dt>コミット</dt>
            <dd>
              <code>{meta.commit}</code>
            </dd>
          </div>
          <div>
            <dt>モデル（設定）</dt>
            <dd>
              予約 <code>{meta.models.reserve}</code>・カルテ <code>{meta.models.karte}</code>・発信 <code>{meta.models.posts}</code>
              {meta.mode === "script" && "（今回は決まった返事。AI は使っていない）"}
            </dd>
          </div>
        </dl>
      )}

      {done.length > 0 && (
        <div className="bignums eval-score" aria-live="polite">
          <BigNumber label="合格" value={t.pass} unit={`/ ${questions.length}`} />
          <BigNumber label="不合格" value={t.fail} />
          <BigNumber label="流せなかった" value={t.unrun} />
        </div>
      )}

      {errors.length > 0 && (
        <div className="eval-errors">
          <strong>まちがい・流せなかった訳</strong>
          <ul>
            {errors.map((r) => (
              <li key={r.no}>
                {r.no}. {r.title}：{r.unrun?.message}
              </li>
            ))}
          </ul>
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
              const checks = r?.checks.length
                ? r.checks
                : q.checks.map((c) => ({ label: c.label, kind: c.kind, ok: null as boolean | null, note: undefined as string | undefined }));
              return (
                <tr key={q.id} className={r ? `is-${r.status}` : running === q.no ? "is-running" : ""}>
                  <td className="num" data-label="番号">
                    {q.no}
                  </td>
                  <td data-label="問い">
                    <strong>{q.title}</strong>
                    <div className="eval-src">
                      {q.kind === "accept" ? "通るべき（ふつうの予約）" : q.kind === "refuse" ? "断るべき" : q.kind === "health" ? "判断しない" : "書かない"}・{q.source}
                    </div>
                    {q.humanReview && (
                      <div className="eval-human">
                        <span className="tag">👀 人が読む</span> {q.humanReview}
                      </div>
                    )}
                  </td>
                  <td data-label="頼む文" className="eval-text">
                    {q.prompt}
                  </td>
                  <td data-label="合否" className="eval-status">
                    {r ? statusLabel(r) : running === q.no ? "流しています…" : "まだ"}
                    {r?.status === "unrun" && r.unrun && (
                      <div className="eval-src">
                        {UNRUN_LABEL[r.unrun.code]}
                        {r.unrun.message !== UNRUN_LABEL[r.unrun.code] ? `：${r.unrun.message}` : ""}
                      </div>
                    )}
                    {r && r.ms > 0 && <div className="eval-src">{(r.ms / 1000).toFixed(1)}秒</div>}
                  </td>
                  <td data-label="答え" className="eval-text">
                    {r?.answer ?? ""}
                  </td>
                  <td data-label="合格の条件">
                    <ul className="eval-checks">
                      {checks.map((c, i) => (
                        <li key={i} className={c.ok === null ? "" : c.ok ? "ok" : "ng"}>
                          <span aria-hidden>{c.ok === null ? "・" : c.ok ? "✓" : "✗"}</span> <span className="eval-kind">{c.kind === "result" ? "結果" : "文"}</span> {c.label}
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
          <textarea className="eval-copy" readOnly value={copy} rows={Math.min(18, copy.split("\n").length + 1)} />
        </Fold>
      )}
    </main>
  );
}
