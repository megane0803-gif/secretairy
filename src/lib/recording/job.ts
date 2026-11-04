// 録音1つ＝ジョブ1つ。区切りごとに「文字にする（ブラウザの中）→ 要点にする（/api/ai/recording）」を進める。
// 区切りが1つ済むたびに置き場所（ブラウザの IndexedDB。テストでは memoryRecordingStore）に残すので、
// 途中で止めても、済んだ区切りの文字・要点は残り、続きから再開できる。声はどこにも送らない。

import type { SilenceSettings } from "../settings";
import type { AudioFormat } from "./formats";
import { cleanTranscript } from "./notes";
import type { ChunkPlan } from "./plan";
import { joinSpans, speechSpans, spansSeconds } from "./silence";

export type JobOrigin = "file" | "folder" | "recorder";
export type JobState = "waiting" | "running" | "stopped" | "done" | "failed";

export type Job = {
  id: string;
  name: string;
  origin: JobOrigin;
  /** recorder = 画面で録った物（ブラウザがしまった区切り） */
  format: AudioFormat | "recorder";
  size: number;
  lastModified: number;
  durationSec: number;
  chunks: ChunkPlan[];
  /** 区切りごとの文字（まだなら null。声が無かった区切りは ""） */
  texts: (string | null)[];
  /** 区切りごとの要点（まだなら null） */
  notes: (string[] | null)[];
  /** 区切りごとの、声のあった長さ（秒） */
  speechSec: (number | null)[];
  /** 言葉の門で外した要点の数 */
  removedNotes: number;
  createdAt: string;
  state: JobState;
  /** うまくいかなかったときの1文 */
  problem: string | null;
  /** 画面の録音：しまった区切りの id（順に） */
  segments?: string[];
};

/** ブラウザの中の置き場所（IndexedDB）。テストでは memoryRecordingStore */
export interface RecordingStore {
  getJob(id: string): Promise<Job | null>;
  putJob(job: Job): Promise<void>;
  listJobs(): Promise<Job[]>;
  deleteJob(id: string): Promise<void>;
  putSegment(id: string, data: Blob): Promise<void>;
  getSegment(id: string): Promise<Blob | null>;
  /** 読んだファイルの印（2回は読まない） */
  getSeen(): Promise<string[]>;
  addSeen(keys: string[]): Promise<void>;
  getMeta<T>(key: string): Promise<T | null>;
  setMeta(key: string, value: unknown): Promise<void>;
  /** 「最初に戻す」：文字・要点・録音の区切り・読んだ印・フォルダを全部消す */
  clear(): Promise<void>;
}

export function memoryRecordingStore(): RecordingStore {
  const jobs = new Map<string, Job>();
  const segments = new Map<string, Blob>();
  const meta = new Map<string, unknown>();
  let seen: string[] = [];
  const copy = <T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
  return {
    async getJob(id) {
      return jobs.has(id) ? copy(jobs.get(id)!) : null;
    },
    async putJob(job) {
      jobs.set(job.id, copy(job));
    },
    async listJobs() {
      return [...jobs.values()].map(copy);
    },
    async deleteJob(id) {
      jobs.delete(id);
    },
    async putSegment(id, data) {
      segments.set(id, data);
    },
    async getSegment(id) {
      return segments.get(id) ?? null;
    },
    async getSeen() {
      return [...seen];
    },
    async addSeen(keys) {
      seen = [...new Set([...seen, ...keys])];
    },
    async getMeta<T>(key: string) {
      return (meta.has(key) ? meta.get(key) : null) as T | null;
    },
    async setMeta(key, value) {
      meta.set(key, value);
    },
    async clear() {
      jobs.clear();
      segments.clear();
      meta.clear();
      seen = [];
    },
  };
}

export function newJob(p: { id: string; name: string; origin: JobOrigin; format: Job["format"]; size: number; lastModified: number; durationSec: number; chunks: ChunkPlan[]; nowIso: string; segments?: string[] }): Job {
  const n = p.chunks.length;
  return {
    id: p.id,
    name: p.name,
    origin: p.origin,
    format: p.format,
    size: p.size,
    lastModified: p.lastModified,
    durationSec: p.durationSec,
    chunks: p.chunks,
    texts: Array(n).fill(null),
    notes: Array(n).fill(null),
    speechSec: Array(n).fill(null),
    removedNotes: 0,
    createdAt: p.nowIso,
    state: "waiting",
    problem: null,
    ...(p.segments ? { segments: p.segments } : {}),
  };
}

/** 文字にした区切りの数 */
export const textDone = (j: Job) => j.texts.filter((t) => t !== null).length;
/** 要点にした区切りの数 */
export const notesDone = (j: Job) => j.notes.filter((t) => t !== null).length;
export const isComplete = (j: Job) => j.chunks.length > 0 && textDone(j) === j.chunks.length && notesDone(j) === j.chunks.length;

/** 続きはどの区切りからか（全部済んでいれば null） */
export function nextChunk(j: Job): number | null {
  for (let i = 0; i < j.chunks.length; i++) if (j.texts[i] === null || j.notes[i] === null) return i;
  return null;
}

export class StopError extends Error {}

export type SummarizeResult = { notes: string[]; removed: number };

export type JobDeps = {
  store: RecordingStore;
  /** 1つの区切りを広げた音（1つの音の道・sampleRate） */
  audioOf(chunk: ChunkPlan, job: Job): Promise<Float32Array>;
  sampleRate: number;
  silence: SilenceSettings;
  /** 声のある所だけをつないだ音を文字にする（ブラウザの Web Worker の Whisper。テストでは決まった結果） */
  transcribe(audio: Float32Array, chunk: ChunkPlan): Promise<string>;
  /** 1つの区切りの文字を要点にする（/api/ai/recording。テストでは決まった返事）。AI につながらないときは投げる */
  summarize(text: string, chunk: ChunkPlan): Promise<SummarizeResult>;
  signal?: AbortSignal;
  onChange?(job: Job): void;
};

/**
 * ジョブを続きから進める。止めた（signal）・うまくいかなかったときも、済んだ区切りは残す。
 * 要点にできなかった（AI につながらない）ときは、文字にするのは最後まで続け、要点はあとで再開する。
 */
export async function runJob(id: string, d: JobDeps): Promise<Job> {
  let job = await d.store.getJob(id);
  if (!job) throw new Error("ジョブがありません");
  const save = async (patch: Partial<Job>) => {
    job = { ...job!, ...patch };
    await d.store.putJob(job);
    d.onChange?.(job);
  };
  const stopped = () => d.signal?.aborted;
  await save({ state: "running", problem: null });
  let summarizeProblem: string | null = null;
  try {
    for (let i = 0; i < job.chunks.length; i++) {
      const chunk = job.chunks[i];
      if (stopped()) throw new StopError();
      if (job.texts[i] === null) {
        const audio = await d.audioOf(chunk, job);
        if (stopped()) throw new StopError();
        const spans = speechSpans(audio, d.sampleRate, d.silence);
        let text = "";
        if (spans.length) text = cleanTranscript(await d.transcribe(joinSpans(audio, d.sampleRate, spans), chunk));
        if (stopped()) throw new StopError();
        const texts = [...job.texts];
        const speech = [...job.speechSec];
        texts[i] = text;
        speech[i] = spansSeconds(spans);
        await save({ texts, speechSec: speech });
      }
      if (job.notes[i] === null && !summarizeProblem) {
        const text = job.texts[i] ?? "";
        let result: SummarizeResult = { notes: [], removed: 0 };
        if (text.trim()) {
          try {
            result = await d.summarize(text, chunk);
          } catch (e) {
            if (stopped()) throw new StopError();
            summarizeProblem = e instanceof Error && e.message ? e.message : "要点にできませんでした";
            continue;
          }
        }
        const notes = [...job.notes];
        notes[i] = result.notes;
        await save({ notes, removedNotes: job.removedNotes + result.removed });
      }
    }
    if (summarizeProblem) await save({ state: "stopped", problem: `要点にできなかった区切りがあります（${summarizeProblem}）。文字は残してあるので、あとで続きから要点にできます` });
    else await save({ state: "done", problem: null });
  } catch (e) {
    if (e instanceof StopError || stopped()) await save({ state: "stopped", problem: null });
    else await save({ state: "failed", problem: e instanceof Error && e.message ? e.message : "うまくいきませんでした" });
  }
  return job;
}
