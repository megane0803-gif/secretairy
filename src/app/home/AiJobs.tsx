"use client";

// ホームの「AI の仕事」（docs/SPEC.md §1.12）。これから来る物を押す前から1行ずつ並べ、オーナーが好きな時に押す。
// 行ごとの「動かす」と、上の「まとめて動かす」（上から1つずつ順に）。結果はそれぞれの場所（承認の箱・経理タブ・ToDo）に届き、
// 行は「動いている → 済み（結果）」に変わって、そのタブへ移れる。日誌にも1行ずつ流れる。
// 流れは src/lib/jobs/run.ts（テストと同じ物）。AI の窓口は今の /api/ai/ の物をそのまま使う。
// 🔒 AI は仮押さえ・案まで。確定は承認の箱で人が押す。

import Link from "next/link";
import { useRef, useState } from "react";
import { CustomerName } from "@/components/parts";
import { useAds } from "@/lib/ads/useAds";
import { NO_AI_MESSAGE } from "@/lib/ai/wire";
import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";
import { getAccounting, getJobSeeds } from "@/lib/data/seed";
import { writeJournal } from "@/lib/journal";
import { browserJobAsk } from "@/lib/jobs/ask";
import { browserJobStore } from "@/lib/jobs/browserStore";
import { adsBlocked, JOB_NAME, reserveText, runJobs, seedOf, type JobEnv, type JobMode, type JobOutcome } from "@/lib/jobs/run";
import { JOB_IDS, openJobs, type JobId } from "@/lib/jobs/state";
import { useJobs, useJobsSwitch } from "@/lib/jobs/useJobs";
import { useRules } from "@/lib/rules/useRules";
import type { JobsSettings } from "@/lib/settings";
import { TABS } from "@/lib/tabs";

type Phase = "running" | { note: string };

/** 何が動いて、結果がどこへ行くか（短く） */
const FLOW: Record<JobId, string> = {
  reserve: "AI が返事をして仮押さえ → 承認の箱へ",
  card: "自動のルールで仕分け → 迷う物は経理タブへ",
  ads: "AI が案を1つ → 確かめて承認の箱へ",
  memo: "AI が ToDo の文に → ToDo へ",
};

function noteOf(o: JobOutcome): string | null {
  if (o.kind === "skip") return o.note;
  if (o.kind === "limit") return "1回に AI を呼べる数を超えるので、動かしませんでした。もう一度押してください";
  if (o.kind === "no-ai") return NO_AI_MESSAGE;
  if (o.kind === "failed") return `うまくいきませんでした（${o.note}）。もう一度押してください`;
  return null;
}

export function AiJobs({ data, settings }: { data: BookData; settings: JobsSettings }) {
  const book = useBook(data);
  const ads = useAds();
  const jobs = useJobs();
  const { rules } = useRules(data.seedRules);
  const sw = useJobsSwitch(settings.visible);
  const [mode, setMode] = useState<JobMode>("ai");
  const [phase, setPhase] = useState<Partial<Record<JobId, Phase>>>({});
  const [busy, setBusy] = useState(false);
  const [noAi, setNoAi] = useState(false);
  const running = useRef(false);

  const seeds = getJobSeeds();
  const reserveSeed = seedOf(seeds, "reserve");
  const memoSeed = seedOf(seeds, "memo");
  const customer = reserveSeed ? data.customers.find((c) => c.id === reserveSeed.customerId) : undefined;
  const guestText = reserveSeed ? reserveText(data, book.state, new Date(book.nowIso), reserveSeed) : null;
  const trialCount = getAccounting().trial.items.length;
  const adsNote = adsBlocked(ads.state, book.nowIso, ads.settings);
  const rows = JOB_IDS.filter((id) => seedOf(seeds, id));
  const open = openJobs(jobs, rows).filter((id) => !(id === "ads" && adsNote));

  async function run(ids: JobId[], how: JobMode = mode) {
    if (running.current) return;
    const todo = ids.filter((id) => open.includes(id));
    if (!todo.length) return;
    running.current = true;
    setBusy(true);
    setPhase((p) => {
      const next = { ...p };
      for (const id of todo) delete next[id];
      return next;
    });
    if (todo.length > 1) writeJournal({ who: "オーナー", text: `AI の仕事をまとめて動かした（${todo.length}行。上から順に${how === "script" ? "・決まった返事" : ""}）` });
    const env: JobEnv = {
      // 店の設定に「同じ時間に受ける人数」（ルールのタブで変えた分）を重ねた物
      data: book.data,
      rules,
      mode: how,
      store: browserJobStore(),
      ask: browserJobAsk,
      journal: writeJournal,
      now: () => new Date(),
      adSettings: ads.settings,
      seeds,
    };
    let down = false;
    try {
      await runJobs(todo, env, { left: settings.maxAiCallsPerPress }, (id, p) => {
        if (p !== "running" && p.kind === "no-ai") down = true;
        setPhase((cur) => {
          const next = { ...cur };
          if (p === "running") next[id] = "running";
          else {
            const note = noteOf(p);
            if (note) next[id] = { note };
            else delete next[id];
          }
          return next;
        });
      });
    } finally {
      running.current = false;
      setBusy(false);
      if (down) setNoAi(true);
      else if (how === "ai") setNoAi(false);
    }
  }

  const press = (ids: JobId[]) => (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    void run(ids);
  };

  const describe = (id: JobId) => {
    if (id === "reserve") return `${JOB_NAME.reserve} 1件`;
    if (id === "card") return `${JOB_NAME.card} ${trialCount}件`;
    if (id === "memo") return `${JOB_NAME.memo} 1件`;
    return JOB_NAME.ads;
  };

  return (
    <section className="brief ai-jobs" aria-labelledby="ai-jobs">
      <div className="page-head">
        <h2 id="ai-jobs">AI の仕事</h2>
        <label className="switch">
          <input type="checkbox" role="switch" checked={sw.on} onChange={(e) => sw.set(e.target.checked)} aria-label="「AI の仕事」の欄を出す" />
          <span className="switch-track" aria-hidden>
            <span className="switch-knob" />
          </span>
          <span className="switch-text">{sw.on ? "出している" : "隠している"}</span>
        </label>
      </div>

      {sw.on && (
        <>
          <div className="ai-jobs-top">
            <button type="button" className="btn primary" onClick={press(open)} disabled={busy || open.length === 0}>
              {busy ? "動いています…" : "まとめて動かす"}
            </button>
            <div className="chat-mode" role="group" aria-label="動かす物">
              <button type="button" className={mode === "ai" ? "chat-mode-on" : "chat-mode-off"} aria-pressed={mode === "ai"} onClick={() => setMode("ai")}>
                AI（Claude）
              </button>
              <button type="button" className={mode === "script" ? "chat-mode-on" : "chat-mode-off"} aria-pressed={mode === "script"} onClick={() => setMode("script")}>
                決まった返事（AI なし）
              </button>
            </div>
          </div>

          {noAi && (
            <div className="noai" role="alert">
              <strong>{NO_AI_MESSAGE}</strong>
              <span>承認の箱・ToDo・経理など、ほかの画面はそのまま使えます。</span>
              <button
                type="button"
                className="btn small"
                disabled={busy || open.length === 0}
                onClick={(e) => {
                  if (!e.nativeEvent.isTrusted) return;
                  setMode("script");
                  setNoAi(false);
                  void run(open, "script");
                }}
              >
                決まった返事で動かす（AI なし）
              </button>
            </div>
          )}

          <ol className="brief-list ai-jobs-list">
            {rows.map((id) => {
              const done = jobs.done[id];
              const p = phase[id];
              const note = id === "ads" && !done && adsNote ? adsNote : p && p !== "running" ? p.note : null;
              return (
                <li key={id} className={done ? "brief-item ai-job done" : "brief-item ai-job"} aria-busy={p === "running"}>
                  <div className="ai-job-head">
                    <span className="ai-job-what">
                      <strong>{describe(id)}</strong> <span className="arrow">→</span> {FLOW[id]}
                    </span>
                    {!done && (
                      <button type="button" className="btn small" onClick={press([id])} disabled={busy || !open.includes(id)}>
                        動かす
                      </button>
                    )}
                  </div>
                  {id === "reserve" && customer && guestText && !done && (
                    <p className="hint">
                      <CustomerName surname={customer.surname} fictional={customer.fictional} />「{guestText}」
                    </p>
                  )}
                  {id === "memo" && memoSeed && !done && <p className="hint">「{memoSeed.text}」</p>}
                  <p className="ai-job-state" role="status">
                    {done ? (
                      <>
                        <span className="tag ok">済み</span> {done.result}{" "}
                        <Link href={TABS[done.tab].path}>{TABS[done.tab].label}のタブへ →</Link>
                      </>
                    ) : p === "running" ? (
                      <span className="tag hold">動いている…</span>
                    ) : note ? (
                      <span className="hint">{note}</span>
                    ) : (
                      <span className="hint">これから</span>
                    )}
                  </p>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
