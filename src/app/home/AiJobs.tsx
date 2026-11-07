"use client";

// ホームの「AI に頼める仕事」（docs/SPEC.md §1.12）。これから来る物を押す前から1行ずつ並べ、オーナーが好きな時に押す。
// 行ごとの「動かす」と、一番上の行の「AI の仕事をまとめて動かす」（上から1つずつ順に）。結果はそれぞれの場所（承認の箱・経理タブ・ToDo）に届き、
// 行は「動いている → 済み（結果）」に変わって、そのタブへ移れる。日誌にも1行ずつ流れる。
// 流れは src/lib/jobs/run.ts（テストと同じ物）。AI の窓口は今の /api/ai/ の物をそのまま使う。
// 動いている印・二重に動かさない止め・モード（AI か決まった返事か）は AiJobsProvider の1か所で持ち、
// 上のボタン（AiJobsRunBar）と下の一覧（AiJobsSection）の両方から使う。
// 🔒 AI は仮押さえ・案まで。確定は承認の箱で人が押す。

import Link from "next/link";
import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { JumpLink } from "@/components/JumpLink";
import { ActorTag, CustomerName } from "@/components/parts";
import { RememberFold } from "@/components/RememberFold";
import { useAds } from "@/lib/ads/useAds";
import { AI_BUSY_MESSAGE, AI_FAILED_MESSAGE } from "@/lib/ai/busy";
import { NO_AI_MESSAGE } from "@/lib/ai/wire";
import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";
import { getAccounting, getJobSeeds } from "@/lib/data/seed";
import { openHomeFold } from "@/lib/home/useHomeFolds";
import { writeJournal } from "@/lib/journal";
import { browserJobAsk } from "@/lib/jobs/ask";
import { browserJobStore } from "@/lib/jobs/browserStore";
import { adsBlocked, JOB_NAME, reserveText, runJobs, seedOf, type JobEnv, type JobMode, type JobOutcome } from "@/lib/jobs/run";
import { JOB_IDS, jobDoneLink, openJobs, type JobDone, type JobId } from "@/lib/jobs/state";
import { useJobs, useJobsSwitch } from "@/lib/jobs/useJobs";
import { useRules } from "@/lib/rules/useRules";
import { useSiteStops } from "@/lib/book/useSiteStops";
import type { JobsSettings } from "@/lib/settings";
import { TABS } from "@/lib/tabs";

type Phase = "running" | { note: string };

/** 何が動いて、結果がどこへ行くか（短く） */
const FLOW: Record<JobId, string> = {
  reserve: "AI が返事をして仮押さえ → 承認BOXへ",
  card: "自動のルールで仕分け → 迷う物は経理タブへ",
  ads: "AI が案を1つ → 確かめて承認BOXへ",
  memo: "AI が ToDo の文に → ToDo へ",
  site: "空いている枠に入る → 台帳へ（承認BOXは通さない・AI なし）",
};

/** 一覧の欄の id（上のボタンから開いて、見える所まで動かす） */
const SECTION_ID = "ai-jobs";
const RUNBAR_ID = "ai-jobs-run";

function noteOf(o: JobOutcome): string | null {
  if (o.kind === "skip") return o.note;
  if (o.kind === "limit") return "1回に AI を呼べる数を超えるので、動かしませんでした。もう一度押してください";
  if (o.kind === "no-ai") return NO_AI_MESSAGE;
  if (o.kind === "busy") return AI_BUSY_MESSAGE;
  if (o.kind === "failed") return o.note.trim() ? `うまくいきませんでした（${o.note}）。もう一度押してください` : AI_FAILED_MESSAGE;
  return null;
}

function useAiJobsState(data: BookData, settings: JobsSettings) {
  const book = useBook(data);
  const ads = useAds();
  const jobs = useJobs();
  const { rules } = useRules(data.seedRules);
  const { stops: siteStops } = useSiteStops();
  const sw = useJobsSwitch(settings.visible);
  const [mode, setMode] = useState<JobMode>("ai");
  const [phase, setPhase] = useState<Partial<Record<JobId, Phase>>>({});
  const [busy, setBusy] = useState(false);
  const [noAi, setNoAi] = useState(false);
  const running = useRef(false);

  const seeds = getJobSeeds();
  // 広告タブと同じ時計（「翌日へ」で進めた日付）で「7日に1つ」を数える
  const adsNote = adsBlocked(ads.state, book.demoNowIso, ads.settings);
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
      // 予約サイトで止めた時間（予約サイトから入る行だけに効く）
      siteStops,
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
      if (down) {
        setNoAi(true);
        // 「決まった返事で動かす」は上のボタンのすぐ下に出すので、そこが見えるように
        window.requestAnimationFrame(() => document.getElementById(RUNBAR_ID)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
      } else if (how === "ai") setNoAi(false);
    }
  }

  return { data, book, jobs, sw, mode, setMode, phase, busy, noAi, setNoAi, seeds, adsNote, rows, open, run };
}

type AiJobsValue = ReturnType<typeof useAiJobsState>;
const AiJobsContext = createContext<AiJobsValue | null>(null);

function useAiJobs(): AiJobsValue {
  const v = useContext(AiJobsContext);
  if (!v) throw new Error("AiJobsProvider の中で使ってください");
  return v;
}

/** 動いている印・二重に動かさない止め・モードを1か所で持つ。上のボタンと下の一覧をこの中に置く */
export function AiJobsProvider({ data, settings, children }: { data: BookData; settings: JobsSettings; children: ReactNode }) {
  const value = useAiJobsState(data, settings);
  return <AiJobsContext.Provider value={value}>{children}</AiJobsContext.Provider>;
}

/** 下の「AI に頼める仕事」を開いて、進み具合が見える所まで動かす */
function showSection() {
  openHomeFold("jobs");
  window.requestAnimationFrame(() => document.getElementById(SECTION_ID)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
}

/** 一番上の行（承認待ちの隣）の「AI の仕事をまとめて動かす」と、AI／決まった返事の切り替え。表示スイッチが切れている時は出さない */
export function AiJobsRunBar() {
  const { sw, mode, setMode, busy, noAi, setNoAi, open, run } = useAiJobs();
  if (!sw.on) return null;

  return (
    <div className="ai-jobs-run" id={RUNBAR_ID}>
      <div className="ai-jobs-top">
        <button
          type="button"
          className="btn primary"
          onClick={(e) => {
            if (!e.nativeEvent.isTrusted) return;
            showSection();
            void run(open);
          }}
          disabled={busy || open.length === 0}
        >
          {busy ? "動いています…" : "AI の仕事をまとめて動かす"}
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
          <span>承認BOX・ToDo・経理など、ほかの画面はそのまま使えます。</span>
          <button
            type="button"
            className="btn small"
            disabled={busy || open.length === 0}
            onClick={(e) => {
              if (!e.nativeEvent.isTrusted) return;
              setMode("script");
              setNoAi(false);
              showSection();
              void run(open, "script");
            }}
          >
            決まった返事で動かす（AI なし）
          </button>
        </div>
      )}
    </div>
  );
}

/** 「AI に頼める仕事」の欄（5行）。畳める。閉じても行の部品は外さない（動いている途中の印も Provider にある） */
export function AiJobsSection() {
  const { data, book, jobs, sw, phase, busy, seeds, adsNote, rows, open, run } = useAiJobs();

  const reserveSeed = seedOf(seeds, "reserve");
  const memoSeed = seedOf(seeds, "memo");
  const customer = reserveSeed ? data.customers.find((c) => c.id === reserveSeed.customerId) : undefined;
  const guestText = reserveSeed ? reserveText(data, book.state, new Date(book.nowIso), reserveSeed) : null;
  const trialCount = getAccounting().trial.items.length;
  const doneCount = rows.filter((id) => jobs.done[id]).length;

  const press = (ids: JobId[]) => (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    void run(ids);
  };

  const describe = (id: JobId) => {
    if (id === "reserve") return `${JOB_NAME.reserve} 1件`;
    if (id === "card") return `${JOB_NAME.card} ${trialCount}件`;
    if (id === "memo") return `${JOB_NAME.memo} 1件`;
    if (id === "site") return "予約サイトから予約 1件";
    return JOB_NAME.ads;
  };

  return (
    <RememberFold
      id="jobs"
      anchor={SECTION_ID}
      title="AI に頼める仕事"
      tag={<ActorTag actor="ai" note="AI なしの時は決まった返事" />}
      count={sw.on ? `${rows.length}行（済み${doneCount}）` : undefined}
      desc="押すと、返事・案・仕分けまで進めます（AI なしの時は決まった返事）。AI の案を決めるのはオーナーです"
      aside={
        <label className="switch">
          <input type="checkbox" role="switch" checked={sw.on} onChange={(e) => sw.set(e.target.checked)} aria-label="「AI に頼める仕事」の欄を出す" />
          <span className="switch-track" aria-hidden>
            <span className="switch-knob" />
          </span>
          <span className="switch-text">{sw.on ? "出している" : "隠している"}</span>
        </label>
      }
    >
      {sw.on && (
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
                    <CustomerName surname={customer.surname} />「{guestText}」
                  </p>
                )}
                {id === "memo" && memoSeed && !done && <p className="hint">「{memoSeed.text}」</p>}
                <p className="ai-job-state" role="status">
                  {done ? (
                    <>
                      <span className="tag ok">済み</span> {done.result} <DoneLink done={done} />
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
      )}
    </RememberFold>
  );
}

/** 済んだ行の結果のリンク。承認の箱に入った物は同じページの承認の箱へ、ほかは結果が届いたタブへ（jobs/state.ts の jobDoneLink） */
function DoneLink({ done }: { done: JobDone }) {
  const to = jobDoneLink(done);
  if (to.kind === "approvals")
    return (
      <JumpLink to="approvals" title="このページの承認BOXへ">
        承認BOXで決める ↓
      </JumpLink>
    );
  return <Link href={TABS[to.tab].path}>{TABS[to.tab].label}のタブへ →</Link>;
}
