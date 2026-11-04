"use client";

// 画面の側の Whisper の窓口。Web Worker（whisper.worker.ts）を立て、モデルを選んで読み込み、音を渡して文字を受け取る。
// WebGPU が使えれば大きめのモデル、使えなければ小さいモデル（config/recording.json の models）。
// WebGPU で読み込めなかったときも、小さいモデルに自動で切り替える。声は Worker に渡すだけで、どこにも送らない。

import type { RecordingSettings, WhisperModel } from "../settings";
import type { WorkerIn, WorkerOut } from "./whisper.worker";

export type ModelStatus = {
  state: "idle" | "loading" | "ready" | "failed";
  model: WhisperModel | null;
  /** 読み込んだ大きさ（バイト。ファイルごとの合計） */
  loaded: number;
  total: number;
  /** このブラウザに覚えてあるか（前に読み込んだ） */
  cached: boolean;
  /** 小さいモデルに切り替えた理由 */
  note: string | null;
  problem: string | null;
};

export const IDLE_MODEL: ModelStatus = { state: "idle", model: null, loaded: 0, total: 0, cached: false, note: null, problem: null };

/** WebGPU が使えるか（使えればアダプターを1つもらえる） */
export async function hasWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!gpu && !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

/** そのモデルを、このブラウザが前に読み込んで覚えているか（transformers.js の Cache API） */
export async function isModelCached(model: WhisperModel): Promise<boolean> {
  try {
    if (typeof caches === "undefined") return false;
    const c = await caches.open("transformers-cache");
    return (await c.keys()).some((r) => r.url.includes(`/${model.id}/`) && r.url.includes(".onnx"));
  } catch {
    return false;
  }
}

export async function chooseModel(r: RecordingSettings): Promise<WhisperModel> {
  return (await hasWebGpu()) ? r.models.webgpu : r.models.wasm;
}

export class WhisperClient {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private seq = 0;
  private waiting = new Map<number, { resolve(t: string): void; reject(e: Error): void }>();
  private files = new Map<string, { loaded: number; total: number }>();
  status: ModelStatus = IDLE_MODEL;

  constructor(
    private settings: RecordingSettings,
    private onStatus: (s: ModelStatus) => void,
  ) {}

  private set(s: Partial<ModelStatus>) {
    this.status = { ...this.status, ...s };
    this.onStatus(this.status);
  }

  private spawn(): Worker {
    const w = new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === "progress") {
        this.files.set(m.file, { loaded: m.loaded, total: m.total });
        let loaded = 0;
        let total = 0;
        for (const f of this.files.values()) {
          loaded += f.loaded;
          total += f.total;
        }
        this.set({ loaded, total });
      } else if (m.type === "text") {
        this.waiting.get(m.id)?.resolve(m.text);
        this.waiting.delete(m.id);
      } else if (m.type === "error" && m.stage === "run" && m.id !== undefined) {
        this.waiting.get(m.id)?.reject(new Error(`文字にできませんでした（${m.message}）`));
        this.waiting.delete(m.id);
      }
    };
    return w;
  }

  private loadOn(model: WhisperModel): Promise<void> {
    const w = this.worker!;
    this.files.clear();
    return new Promise((resolve, reject) => {
      const onMsg = (e: MessageEvent<WorkerOut>) => {
        if (e.data.type === "ready") {
          w.removeEventListener("message", onMsg);
          resolve();
        } else if (e.data.type === "error" && e.data.stage === "load") {
          w.removeEventListener("message", onMsg);
          reject(new Error(e.data.message));
        }
      };
      w.addEventListener("message", onMsg);
      w.postMessage({ type: "load", model } satisfies WorkerIn);
    });
  }

  /** モデルを読み込む（1回だけ。読み込み中なら待つ） */
  load(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const model = this.status.model ?? (await chooseModel(this.settings));
      this.set({ state: "loading", model, cached: await isModelCached(model), problem: null, loaded: 0, total: 0 });
      this.worker ??= this.spawn();
      try {
        await this.loadOn(model);
      } catch (e) {
        const small = this.settings.models.wasm;
        if (model.id === small.id && model.device === small.device) throw e;
        // WebGPU で読み込めなかった：小さいモデルに切り替える
        this.worker.terminate();
        this.worker = this.spawn();
        this.set({ model: small, cached: await isModelCached(small), note: "大きいモデルを読み込めなかったので、小さいモデルに切り替えました", loaded: 0, total: 0 });
        await this.loadOn(small);
      }
      this.set({ state: "ready", cached: true });
    })().catch((e: unknown) => {
      this.ready = null;
      this.set({ state: "failed", problem: e instanceof Error ? e.message : String(e) });
      throw new Error("文字にするモデルを読み込めませんでした。ネットにつながっているか確かめて、「続きから」を押してください");
    });
    return this.ready;
  }

  /** 音（16kHz・1つの音の道）を文字にする。止めたら Worker ごと止める（次はブラウザに覚えたモデルから読みなおす） */
  async transcribe(audio: Float32Array, signal?: AbortSignal): Promise<string> {
    await this.load();
    const id = ++this.seq;
    return new Promise<string>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      const onAbort = () => {
        this.stop();
        reject(new Error("止めました"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.worker!.postMessage({ type: "run", id, audio, language: this.settings.language } satisfies WorkerIn, [audio.buffer]);
    });
  }

  /** 動いている文字起こしを止める（Worker を止める。モデルは次に覚えた物から読みなおす） */
  stop(): void {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    for (const w of this.waiting.values()) w.reject(new Error("止めました"));
    this.waiting.clear();
    if (this.status.state !== "idle") this.set({ state: "idle" });
  }
}
