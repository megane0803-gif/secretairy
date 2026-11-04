"use client";

// カルテのタブの右の列：録音からメモを作る（PC だけ）。入口は3つ（ファイルを選ぶ・落とす／画面で録音／録音フォルダ）。
// 声はこの PC のブラウザの外に出さない（Whisper を Web Worker の中で動かす）。文字にした中身は、要点とカルテを作るために Claude に送る。
// 要点ができたら、人が「〇〇様のメモに入れる」を押して施術のメモに入れ、今までどおり「カルテにする」→ 言葉の門 →「保存」（人）。

import { useEffect, useRef, useState } from "react";
import { CustomerName, Fold, MiniBar } from "@/components/parts";
import type { BookData } from "@/lib/book/data";
import { writeJournal } from "@/lib/journal";
import { setDesk } from "@/lib/karte/deskStore";
import { durationText, limitText, mbText } from "@/lib/recording/formats";
import { isComplete, notesDone, textDone, type Job } from "@/lib/recording/job";
import { combineNotes } from "@/lib/recording/notes";
import { useDevice } from "@/lib/recording/useDevice";
import { recording, useRecording } from "@/lib/recording/useRecording";
import { useRecordingSwitch } from "@/lib/recording/useRecordingSwitch";
import { useRules } from "@/lib/rules/useRules";
import type { RecordingSettings } from "@/lib/settings";
import { useKarteToday } from "./useKarteToday";

export const RECORDING_NOTICE = [
  "声はこの PC のブラウザの外に出しません。文字にした中身は、要点とカルテを作るために Claude に送ります。",
  "録音は、お客様の了解を得てから行ってください。",
];

type Props = {
  data: BookData;
  settings: RecordingSettings;
  maxTextChars: number;
  minIntervalSeconds: number;
  memoMaxChars: number;
  surnames: string[];
};

export function RecordingPanel(p: Props) {
  const device = useDevice();
  const { on, setOn } = useRecordingSwitch(p.settings.visible);
  return (
    <section className="panel rec-panel" aria-labelledby="rec-title">
      <div className="rec-head">
        <h2 id="rec-title">録音からメモを作る</h2>
        <label className="switch">
          <input type="checkbox" role="switch" checked={on} onChange={(e) => setOn(e.target.checked)} aria-label="「録音からメモを作る」を出す" />
          <span className="switch-track" aria-hidden>
            <span className="switch-knob" />
          </span>
          <span className="switch-text">{on ? "出している" : "隠している"}</span>
        </label>
      </div>
      {!on ? (
        <p className="hint">隠しています（動かない時に隠せます）。スイッチを入れると出ます。</p>
      ) : !device.known ? null : !device.pc ? (
        <p className="rec-pc-only">この機能は PC で開いてください</p>
      ) : (
        <RecordingBody {...p} folderOk={device.folder} recordOk={device.record} />
      )}
    </section>
  );
}

function RecordingBody(p: Props & { folderOk: boolean; recordOk: boolean }) {
  const s = p.settings;
  const v = useRecording();
  const { book, selected, key, saved } = useKarteToday(p.data);
  const { rules } = useRules(p.data.seedRules);
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    recording.setRules(rules);
  }, [rules]);
  useEffect(() => {
    void recording.init({
      settings: s,
      maxTextChars: p.maxTextChars,
      minIntervalSeconds: p.minIntervalSeconds,
      surnames: p.surnames,
      todayStartMs: new Date(`${book.today.date}T00:00:00`).getTime(),
    });
  }, [s, p.maxTextChars, p.minIntervalSeconds, p.surnames, book.today.date]);
  useEffect(() => {
    if (!v.recorder.on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [v.recorder.on]);

  const accept = s.accept.map((e) => `.${e}`).join(",");
  const addFiles = (list: FileList | null) => {
    for (const f of Array.from(list ?? [])) void recording.addFile(f, "file");
  };

  const putIntoMemo = (job: Job) => {
    if (!selected || !key) return;
    const { memo, lines, dropped } = combineNotes(job.notes, p.memoMaxChars);
    if (!memo) return;
    setDesk((d) => ({ memos: { ...d.memos, [key]: memo }, sources: { ...(d.sources ?? {}), [key]: "recording" } }));
    writeJournal({
      who: "オーナー",
      text: `録音の要点を施術のメモに入れた（${selected.customer.surname}（架空）様・${lines.length}行${dropped ? `・入りきらない${dropped}行は入れていない` : ""}。カルテにする・保存は人が押す）`,
    });
  };

  const m = v.model;
  const model = m.model;

  return (
    <div className="rec-body">
      <ul className="rec-notice">
        {RECORDING_NOTICE.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>

      <div
        className={over ? "rec-drop over" : "rec-drop"}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <p>録音のファイルをここに落とす</p>
        <button type="button" className="btn primary" onClick={() => inputRef.current?.click()}>
          ファイルを選ぶ
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <p className="hint">
          受けるのは {s.accept.join("・")}（{limitText(s)}）。2〜4時間の録音でも読めます。
        </p>
      </div>

      {p.recordOk && (
        <div className="rec-mic">
          {v.recorder.on ? (
            <>
              <p className="rec-mic-now">
                <span className="rec-dot" aria-hidden /> 録音中 <span className="num">{clock((now - v.recorder.startedAt) / 1000)}</span>
                <span className="hint">（しまった区切り {v.recorder.segments}）</span>
              </p>
              <MiniBar value={Math.round(Math.min(1, v.recorder.level * 8) * 100)} max={100} label="音の大きさ" />
              {v.recorder.quiet && (
                <p className="form-problem" role="alert">
                  音が入っていません。マイクの電源・つなぎ方・ブラウザのマイクの選び方を確かめてください。
                </p>
              )}
              <button type="button" className="btn danger" onClick={() => void recording.stopRecording()}>
                止める
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={() => void recording.startRecording()}>
              🎙 録音
            </button>
          )}
          <p className="hint">録音の機能が無いマイク向け。PC につないだマイク（受信機など）から、このブラウザが録ります。{Math.round(s.recorder.segmentSeconds / 60)}分ごとに区切ってブラウザの中にしまいます。</p>
          {v.recorder.problem && <p className="form-problem">{v.recorder.problem}</p>}
        </div>
      )}

      {p.folderOk && (
        <div className="rec-folder">
          {v.folder.state === "watching" ? (
            <p>
              ✓ 録音フォルダ「{v.folder.name}」を見ています（画面を開いている間、{s.folder.pollSeconds}秒ごと）
              <button type="button" className="btn small" onClick={() => void recording.forgetFolder()}>
                やめる
              </button>
            </p>
          ) : v.folder.state === "prompt" || v.folder.state === "denied" ? (
            <p>
              録音フォルダ「{v.folder.name}」を読むには、もう一度許可がいります。
              <button type="button" className="btn small" onClick={() => void recording.regrantFolder()}>
                許可する
              </button>
            </p>
          ) : (
            <button type="button" className="btn" onClick={() => void recording.chooseFolder()}>
              録音フォルダを選ぶ
            </button>
          )}
          <p className="hint">最初に1回選んで許可すると、新しく入った録音を読みます。閉じている間に入った物も、開いた時にまとめて読みます。読んだファイルは2回は読みません（はじめて選んだ時、今日より前の録音は読みません）。</p>
          {v.folder.problem && <p className="form-problem">{v.folder.problem}</p>}
        </div>
      )}

      {model && (
        <p className="hint rec-model">
          文字にするモデル：{model.label}（{model.device === "webgpu" ? "WebGPU" : "WebGPU なし"}・約{model.approxMB.toLocaleString("ja-JP")}MB）。
          {m.state === "loading"
            ? m.total > 0
              ? `読み込み中 ${mbText(m.loaded)} / ${mbText(m.total)}`
              : "読み込み中…"
            : m.cached
              ? "このブラウザに覚えてあるので、すぐ始まります。"
              : "初回は読み込みに時間がかかります（2回目からはこのブラウザに覚えさせます）。"}
          {m.note && <> {m.note}</>}
          {m.problem && <> モデルを読み込めませんでした（{m.problem}）。ネットにつながっているか確かめてください。動かない時は、上のスイッチで隠せます。</>}
        </p>
      )}

      {v.notice && (
        <p className="form-problem" role="status">
          {v.notice}{" "}
          <button type="button" className="btn small" onClick={() => recording.clearNotice()}>
            閉じる
          </button>
        </p>
      )}

      {v.jobs.length > 0 && (
        <ul className="rec-jobs">
          {v.jobs.map((j) => (
            <JobRow
              key={j.id}
              job={j}
              running={v.running === j.id}
              waiting={v.queue.includes(j.id)}
              memoMaxChars={p.memoMaxChars}
              target={selected && !saved ? <CustomerName surname={selected.customer.surname} fictional={selected.customer.fictional} /> : null}
              onMemo={() => putIntoMemo(j)}
            />
          ))}
        </ul>
      )}
      <p className="hint">要点にするのは、施術のメモの「AI（Claude）／決まった返事（AI なし）」の切りかえに従います。要点にも言葉の門（プログラム）を通します。</p>
    </div>
  );
}

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function JobRow({ job, running, waiting, memoMaxChars, target, onMemo }: { job: Job; running: boolean; waiting: boolean; memoMaxChars: number; target: React.ReactNode; onMemo: () => void }) {
  const total = job.chunks.length;
  const texts = textDone(job);
  const notes = notesDone(job);
  const complete = isComplete(job);
  const combined = combineNotes(job.notes, memoMaxChars);
  const state = running ? "文字にしています…" : waiting ? "順番を待っています" : complete ? "済み" : job.state === "failed" ? "うまくいきませんでした" : job.origin === "recorder" && total === 0 ? "録音中" : "止めています";
  return (
    <li className="rec-job">
      <p className="rec-job-head">
        <strong>{job.name}</strong>
        <span className="hint">
          {durationText(job.durationSec)}・{state}
        </span>
      </p>
      <p className="rec-job-count">
        <span className="num">{texts}</span> / {total} 区切り
        <span className="hint">（要点 {notes} / {total}）</span>
      </p>
      <MiniBar value={texts + notes} max={Math.max(1, total * 2)} label="済んだ区切り" />
      {job.problem && <p className="form-problem">{job.problem}</p>}
      <div className="form-buttons">
        {running ? (
          <button type="button" className="btn" onClick={() => recording.stop()}>
            止める
          </button>
        ) : (
          !complete &&
          !waiting &&
          total > 0 && (
            <button type="button" className="btn" onClick={() => recording.resume(job.id)}>
              続きから
            </button>
          )
        )}
        {complete && (
          <button type="button" className="btn primary" disabled={!target || !combined.memo} onClick={onMemo}>
            {target ? <>{target}のメモに入れる</> : "メモに入れる（今日のお客様を選ぶ）"}
          </button>
        )}
        {!running && (
          <button type="button" className="btn small" onClick={() => void recording.remove(job.id)}>
            消す
          </button>
        )}
      </div>
      {(complete || notes > 0) && (
        <Fold summary={`要点 ${combined.lines.length}行${combined.dropped ? `（入りきらない ${combined.dropped}行）` : ""}${job.removedNotes ? `・言葉の門で外した ${job.removedNotes}行` : ""}`}>
          {combined.memo ? <pre className="karte-memo-text">{combined.memo}</pre> : <p className="hint">カルテに要る所はありませんでした。</p>}
        </Fold>
      )}
      {texts > 0 && (
        <Fold summary="文字（区切りごと）">
          <ol className="rec-texts">
            {job.texts.map((t, i) =>
              t === null ? null : (
                <li key={i}>
                  <small className="hint">
                    {durationText(job.chunks[i].startSec)}〜・声 {durationText(job.speechSec[i] ?? 0)}
                  </small>
                  <p>{t || "（声がありませんでした）"}</p>
                </li>
              ),
            )}
          </ol>
        </Fold>
      )}
    </li>
  );
}
