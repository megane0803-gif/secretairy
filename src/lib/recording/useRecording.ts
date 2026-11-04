"use client";

// カルテのタブの「録音からメモを作る」の動き（画面の側）。入口は3つ（ファイル・画面の録音・録音フォルダ）で、どれも同じ流れに回す：
//   録音 → 区切る（plan.ts）→ 区切りごとに広げる（decode.ts）→ 黙っている所を飛ばす（silence.ts）→ Whisper で文字に（Web Worker）
//        → 名字を〔お客様〕にして /api/ai/recording で要点に（言葉の門つき）→ 全部の要点をまとめて「施術のメモ」へ（人が押す）
// 声はブラウザの外に出さない。文字にした中身は、要点とカルテを作るために Claude に送る。
// 残すのはブラウザの中（IndexedDB）だけ。「最初に戻す」で消える（store.ts の resetRecordings）。

import { useSyncExternalStore } from "react";
import { NO_AI_MESSAGE } from "../ai/wire";
import { writeJournal } from "../journal";
import { getDesk } from "../karte/deskStore";
import type { Rule } from "../rules/types";
import type { RecordingSettings } from "../settings";
import { blobReader, decodeMono } from "./decode";
import { folderFile, folderPermission, listFolder, pickFolder, type FolderHandle } from "./folder";
import { checkFile, durationText, lengthCheck } from "./formats";
import { isComplete, newJob, runJob, type Job } from "./job";
import { maskNames } from "./notes";
import { chunkBytes, planAudio, type AudioPlan, type ChunkPlan } from "./plan";
import { SegmentRecorder } from "./recorder";
import { fileKey, oldFileKeys, readyFiles } from "./seen";
import { getRecordingStore, onRecordingCleared, onRecordingReset } from "./store";
import { IDLE_MODEL, WhisperClient, chooseModel, isModelCached, type ModelStatus } from "./transcriber";
import { clipText, type NotesResponse } from "./wire";

export type RecorderView = { on: boolean; startedAt: number; level: number; quiet: boolean; segments: number; problem: string | null };
export type FolderView = { state: "none" | "prompt" | "watching" | "denied"; name: string | null; problem: string | null };

export type RecordingView = {
  loaded: boolean;
  jobs: Job[];
  running: string | null;
  queue: string[];
  model: ModelStatus;
  recorder: RecorderView;
  folder: FolderView;
  notice: string | null;
};

const EMPTY: RecordingView = {
  loaded: false,
  jobs: [],
  running: null,
  queue: [],
  model: IDLE_MODEL,
  recorder: { on: false, startedAt: 0, level: 0, quiet: false, segments: 0, problem: null },
  folder: { state: "none", name: null, problem: null },
  notice: null,
};

export type RecordingConfig = {
  settings: RecordingSettings;
  maxTextChars: number;
  minIntervalSeconds: number;
  surnames: string[];
  /** 今日（店の時間帯）の始まり。はじめてフォルダを選んだとき、これより前の録音は読まない */
  todayStartMs: number;
};

let view: RecordingView = EMPTY;
const listeners = new Set<() => void>();
const set = (f: (v: RecordingView) => Partial<RecordingView>) => {
  view = { ...view, ...f(view) };
  listeners.forEach((l) => l());
};

let config: RecordingConfig | null = null;
let rules: Rule[] = [];
let whisper: WhisperClient | null = null;
let abort: AbortController | null = null;
let recorder: SegmentRecorder | null = null;
let recorderJob: string | null = null;
let segmentChain: Promise<void> = Promise.resolve();
let folder: FolderHandle | null = null;
let folderTimer: ReturnType<typeof setInterval> | null = null;
let prevSizes: Record<string, number> = {};
let lastNotesAt = 0;
const files = new Map<string, File>();
const plans = new Map<string, AudioPlan>();

const store = () => getRecordingStore();

async function refresh(): Promise<void> {
  const jobs = await store().listJobs();
  jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  set(() => ({ jobs, loaded: true }));
}

function putView(job: Job): void {
  set((v) => {
    const i = v.jobs.findIndex((j) => j.id === job.id);
    const jobs = i >= 0 ? v.jobs.map((j) => (j.id === job.id ? job : j)) : [job, ...v.jobs];
    return { jobs };
  });
}

function getWhisper(): WhisperClient {
  if (!whisper) whisper = new WhisperClient(config!.settings, (model) => set(() => ({ model })));
  return whisper;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("止めました"));
    }, { once: true });
  });

/** 1つの区切りの文字を要点にする（名字は〔お客様〕に・上限の字数まで）。/api/ai/ の1分10回に収まるよう間を空ける */
async function summarize(text: string, signal?: AbortSignal): Promise<{ notes: string[]; removed: number }> {
  const c = config!;
  const wait = lastNotesAt + c.minIntervalSeconds * 1000 - Date.now();
  if (wait > 0) await sleep(wait, signal);
  const body = { mode: getDesk().mode, text: clipText(maskNames(text, c.surnames), c.maxTextChars), rules: rules.filter((r) => !r.locked) };
  for (let tryNo = 0; tryNo < 2; tryNo++) {
    lastNotesAt = Date.now();
    let res: Response;
    try {
      res = await fetch("/api/ai/recording", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    } catch {
      if (signal?.aborted) throw new Error("止めました");
      throw new Error(NO_AI_MESSAGE);
    }
    if (res.status === 429 && tryNo === 0) {
      // 1分の回数の上限：少し待ってから1回だけ送りなおす
      await sleep(60_000, signal);
      continue;
    }
    let out: NotesResponse | null = null;
    try {
      out = (await res.json()) as NotesResponse;
    } catch {
      out = null;
    }
    if (!out || (!out.ok && out.code === "no-ai")) throw new Error(NO_AI_MESSAGE);
    if (!out.ok) throw new Error(out.message);
    return { notes: out.notes, removed: out.removed.length };
  }
  throw new Error("AI を呼ぶ回数の上限に来ました。少し待ってから続きから押してください");
}

async function fileOf(job: Job): Promise<File | null> {
  const f = files.get(job.id);
  if (f) return f;
  if (job.origin === "folder" && folder) {
    const file = await folderFile(folder, job.name);
    if (file && fileKey(file) === job.id) {
      files.set(job.id, file);
      return file;
    }
  }
  return null;
}

async function audioOf(chunk: ChunkPlan, job: Job): Promise<Float32Array> {
  const rate = config!.settings.sampleRate;
  if (job.origin === "recorder") {
    const id = job.segments?.[chunk.index];
    const blob = id ? await store().getSegment(id) : null;
    if (!blob) throw new Error("しまった録音の区切りが見つかりません");
    return decodeMono(await blob.arrayBuffer(), rate);
  }
  const file = await fileOf(job);
  if (!file) throw new Error("同じファイルをもう一度選ぶと、続きから読みます");
  let plan = plans.get(job.id);
  if (!plan) {
    const p = await planAudio(job.format as AudioPlan["format"], file.size, blobReader(file), config!.settings.chunkSeconds);
    if (!p || p.chunks.length !== job.chunks.length) throw new Error("前と同じ形で読めませんでした");
    plans.set(job.id, p);
    plan = p;
  }
  return decodeMono(await chunkBytes(plan, chunk, blobReader(file)), rate);
}

/** 順番待ちの次を動かす（1つずつ） */
async function pump(): Promise<void> {
  if (view.running || !config) return;
  const id = view.queue[0];
  if (!id) return;
  set((v) => ({ running: id, queue: v.queue.slice(1) }));
  abort = new AbortController();
  const signal = abort.signal;
  const before = await store().getJob(id);
  try {
    const job = await runJob(id, {
      store: store(),
      audioOf,
      sampleRate: config.settings.sampleRate,
      silence: config.settings.silence,
      transcribe: (audio) => getWhisper().transcribe(audio, signal),
      summarize: (text) => summarize(text, signal),
      signal,
      onChange: putView,
    });
    if (job.state === "done" && before && !isComplete(before)) {
      writeJournal({ who: "プログラム", text: `録音を文字にして要点にした（${job.name}・${job.chunks.length}区切り・要点${job.notes.flat().length}行。声はブラウザの外に出していない）` });
      if (job.removedNotes > before.removedNotes)
        writeJournal({ who: "プログラム", text: `言葉の門：録音の要点から${job.removedNotes - before.removedNotes}行を載せていません（その区切りの文字に無い言葉や数字）` });
    } else if (job.problem) writeJournal({ who: "プログラム", text: `録音の文字起こしを止めた（${job.name}：${job.problem}）` });
  } catch (e) {
    set(() => ({ notice: e instanceof Error ? e.message : "うまくいきませんでした" }));
  } finally {
    abort = null;
    set(() => ({ running: null }));
    void pump();
  }
}

function enqueue(id: string): void {
  if (view.running === id || view.queue.includes(id)) return;
  set((v) => ({ queue: [...v.queue, id] }));
  void pump();
}

export const recording = {
  /** 画面を開いた時に1回。保存してある物を読み、録音フォルダがあれば見はじめる */
  async init(c: RecordingConfig): Promise<void> {
    const first = !config;
    config = c;
    if (!first) return;
    onRecordingReset(() => {
      abort?.abort();
      whisper?.stop();
      void recording.stopRecording(true);
      stopWatching();
      folder = null;
      files.clear();
      plans.clear();
      set(() => ({ queue: [], folder: EMPTY.folder, notice: null }));
    });
    onRecordingCleared(() => void refresh());
    // 前に開いていた間に動いていた物は「止めた」にする（続きから押せる）
    for (const j of await store().listJobs()) if (j.state === "running") await store().putJob({ ...j, state: "stopped" });
    await refresh();
    // モデルの大きさを先に出す（読み込みはまだしない）
    const model = await chooseModel(c.settings);
    if (view.model.state === "idle") set(() => ({ model: { ...IDLE_MODEL, model, cached: false } }));
    const cached = await isModelCached(model);
    if (view.model.state === "idle") set((v) => ({ model: { ...v.model, cached } }));
    // 録音フォルダ
    const h = await store().getMeta<FolderHandle>("folder").catch(() => null);
    if (h) {
      const perm = await folderPermission(h, false);
      folder = h;
      if (perm === "granted") startWatching(h);
      else set(() => ({ folder: { state: "prompt", name: h.name, problem: null } }));
    }
  },

  setRules(r: Rule[]): void {
    rules = r;
  },

  /** ファイルを選んだ・落とした・フォルダで見つけた */
  async addFile(file: File, origin: "file" | "folder" = "file"): Promise<void> {
    const c = config!;
    const check = checkFile(file, c.settings);
    if (!check.ok) {
      set(() => ({ notice: check.reason }));
      return;
    }
    const id = fileKey(file);
    files.set(id, file);
    const had = await store().getJob(id);
    if (had) {
      if (isComplete(had)) set(() => ({ notice: `${file.name} はもう文字にしてあります` }));
      else {
        set(() => ({ notice: `${file.name} を続きから読みます` }));
        enqueue(id);
      }
      return;
    }
    let plan: AudioPlan | null = null;
    try {
      plan = await planAudio(check.format, file.size, blobReader(file), c.settings.chunkSeconds);
    } catch {
      plan = null;
    }
    if (!plan || !plan.chunks.length) {
      set(() => ({ notice: `${file.name} は読めませんでした（m4a は中が aac の物を受けます）` }));
      return;
    }
    const tooLong = lengthCheck(plan.durationSec, c.settings);
    if (tooLong) {
      set(() => ({ notice: tooLong }));
      return;
    }
    plans.set(id, plan);
    const job = newJob({
      id,
      name: file.name,
      origin,
      format: check.format,
      size: file.size,
      lastModified: file.lastModified,
      durationSec: plan.durationSec,
      chunks: plan.chunks.map(({ index, startSec, endSec, start, end }) => ({ index, startSec, endSec, start, end })),
      nowIso: new Date().toISOString(),
    });
    await store().putJob(job);
    await store().addSeen([id]);
    putView(job);
    set(() => ({ notice: null }));
    writeJournal({ who: "プログラム", text: `録音を受けた（${file.name}・${durationText(plan.durationSec)}・${job.chunks.length}区切り${origin === "folder" ? "・録音フォルダから" : ""}）` });
    enqueue(id);
  },

  resume(id: string): void {
    enqueue(id);
  },

  /** 動いている文字起こしを止める（済んだ区切りは残る） */
  stop(): void {
    abort?.abort();
    set((v) => ({ queue: v.queue.filter((q) => q !== v.running) }));
  },

  async remove(id: string): Promise<void> {
    if (view.running === id) return;
    await store().deleteJob(id);
    files.delete(id);
    plans.delete(id);
    set((v) => ({ jobs: v.jobs.filter((j) => j.id !== id), queue: v.queue.filter((q) => q !== id) }));
  },

  /** 画面の録音を始める */
  async startRecording(): Promise<void> {
    const c = config!;
    if (recorder) return;
    const startedAt = Date.now();
    const id = `rec-${startedAt}`;
    const job = newJob({ id, name: `画面で録音 ${new Date(startedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`, origin: "recorder", format: "recorder", size: 0, lastModified: startedAt, durationSec: 0, chunks: [], nowIso: new Date(startedAt).toISOString(), segments: [] });
    const r = new SegmentRecorder(c.settings.recorder.segmentSeconds, c.settings.recorder.quietLevel, c.settings.recorder.quietWarnSeconds, {
      onSegment: (blob, index, seconds) => {
        segmentChain = segmentChain.then(async () => {
          const segId = `${id}-${index}`;
          await store().putSegment(segId, blob);
          const j = (await store().getJob(id)) ?? job;
          const startSec = j.durationSec;
          const next: Job = {
            ...j,
            size: j.size + blob.size,
            durationSec: startSec + seconds,
            segments: [...(j.segments ?? []), segId],
            chunks: [...j.chunks, { index: j.chunks.length, startSec, endSec: startSec + seconds, start: 0, end: blob.size }],
            texts: [...j.texts, null],
            notes: [...j.notes, null],
            speechSec: [...j.speechSec, null],
          };
          await store().putJob(next);
          putView(next);
          set((v) => ({ recorder: { ...v.recorder, segments: next.chunks.length } }));
        });
        return segmentChain;
      },
      onLevel: (level, quiet) => {
        set((v) => ({ recorder: { ...v.recorder, level, quiet } }));
        // 長さの上限に来たら止める
        if (Date.now() - startedAt >= c.settings.maxSeconds * 1000) void recording.stopRecording();
      },
    });
    try {
      await store().putJob({ ...job, state: "stopped" });
      putView({ ...job, state: "stopped" });
      await r.start();
    } catch {
      await store().deleteJob(id);
      set((v) => ({ jobs: v.jobs.filter((j) => j.id !== id), recorder: { ...EMPTY.recorder, problem: "マイクを使えませんでした。ブラウザのマイクの許可と、PC につないだマイクを確かめてください" } }));
      return;
    }
    recorder = r;
    recorderJob = id;
    set(() => ({ recorder: { on: true, startedAt, level: 0, quiet: false, segments: 0, problem: null } }));
    writeJournal({ who: "オーナー", text: "画面で録音を始めた（区切りはブラウザの中にしまう）" });
  },

  /** 画面の録音を止めて、同じ流れに回す。drop = 最初に戻すときは回さない */
  async stopRecording(drop = false): Promise<void> {
    const r = recorder;
    const id = recorderJob;
    if (!r || !id) return;
    recorder = null;
    recorderJob = null;
    await r.stop();
    await segmentChain;
    set(() => ({ recorder: EMPTY.recorder }));
    if (drop) return;
    const j = await store().getJob(id);
    if (!j || !j.chunks.length) {
      if (j) await store().deleteJob(id);
      await refresh();
      return;
    }
    writeJournal({ who: "オーナー", text: `画面の録音を止めた（${durationText(j.durationSec)}・${j.chunks.length}区切り）` });
    enqueue(id);
  },

  /** 録音フォルダを選ぶ（人のボタン。ブラウザが許可を聞く） */
  async chooseFolder(): Promise<void> {
    let h: FolderHandle;
    try {
      h = await pickFolder();
    } catch {
      return;
    }
    const c = config!;
    try {
      await store().setMeta("folder", h);
    } catch {
      // 覚えられないブラウザでも、開いている間は見る
    }
    // はじめて選んだ：今日より前の録音は「前からあった物」として読まない
    const list = await listFolder(h);
    await store().addSeen(oldFileKeys(list.map((l) => l.entry), c.settings.accept, c.todayStartMs));
    folder = h;
    prevSizes = {};
    writeJournal({ who: "オーナー", text: `録音フォルダを選んだ（${h.name}。画面を開いている間、新しい録音を読みます）` });
    startWatching(h);
  },

  /** 前に選んだフォルダの許可をもう一度もらう（人のボタン） */
  async regrantFolder(): Promise<void> {
    if (!folder) return;
    const perm = await folderPermission(folder, true);
    if (perm === "granted") startWatching(folder);
    else set(() => ({ folder: { state: "denied", name: folder?.name ?? null, problem: "フォルダを読む許可がありません" } }));
  },

  async forgetFolder(): Promise<void> {
    stopWatching();
    folder = null;
    await store().setMeta("folder", null).catch(() => undefined);
    set(() => ({ folder: EMPTY.folder }));
  },

  clearNotice(): void {
    set(() => ({ notice: null }));
  },
};

function stopWatching(): void {
  if (folderTimer) clearInterval(folderTimer);
  folderTimer = null;
}

/** 録音フォルダを見る：開いた時にまとめて拾い、そのあと pollSeconds ごとに見る */
function startWatching(h: FolderHandle): void {
  stopWatching();
  const c = config!;
  set(() => ({ folder: { state: "watching", name: h.name, problem: null } }));
  // 前に止まったフォルダの録音は、続きから読む
  for (const j of view.jobs) if (j.origin === "folder" && !isComplete(j) && j.state !== "failed") enqueue(j.id);
  const look = async () => {
    try {
      const list = await listFolder(h);
      const seen = new Set(await store().getSeen());
      const { ready, sizes } = readyFiles(list.map((l) => l.entry), seen, prevSizes, c.settings.accept, Date.now(), c.settings.folder.pollSeconds * 2000);
      prevSizes = sizes;
      for (const e of ready) {
        const f = list.find((l) => l.entry.name === e.name)?.file;
        // 読めなかった物も、2回は読まない
        await store().addSeen([fileKey(e)]);
        if (f) await recording.addFile(f, "folder");
      }
    } catch {
      set(() => ({ folder: { state: "prompt", name: h.name, problem: "フォルダを読めませんでした。許可しなおしてください" } }));
      stopWatching();
    }
  };
  void look();
  folderTimer = setInterval(() => void look(), c.settings.folder.pollSeconds * 1000);
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

export function useRecording(): RecordingView {
  return useSyncExternalStore(subscribe, () => view, () => EMPTY);
}
