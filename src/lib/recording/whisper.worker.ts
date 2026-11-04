// Web Worker の中で Whisper（transformers.js）を動かし、声を文字にする。声はこの中だけで扱い、どこにも送らない。
// モデルは最初に1回だけ読み込み、ブラウザ（Cache API）に覚えさせる（2回目からは読み込みが速い）。

import { env, pipeline } from "@huggingface/transformers";
import type { WhisperModel } from "../settings";

export type WorkerIn =
  | { type: "load"; model: WhisperModel }
  | { type: "run"; id: number; audio: Float32Array; language: string };

export type WorkerOut =
  | { type: "progress"; file: string; loaded: number; total: number }
  | { type: "ready"; model: string }
  | { type: "text"; id: number; text: string }
  | { type: "error"; stage: "load" | "run"; id?: number; message: string };

env.allowLocalModels = false;
env.useBrowserCache = true;

type Asr = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;
let asr: Asr | null = null;

const post = (m: WorkerOut) => (self as unknown as { postMessage(m: WorkerOut): void }).postMessage(m);

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  if (msg.type === "load") {
    try {
      const make = pipeline as unknown as (task: string, model: string, options: Record<string, unknown>) => Promise<Asr>;
      asr = await make("automatic-speech-recognition", msg.model.id, {
        device: msg.model.device,
        dtype: msg.model.dtype,
        progress_callback: (p: { status?: string; file?: string; loaded?: number; total?: number }) => {
          if (p.status === "progress" && p.file) post({ type: "progress", file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0 });
        },
      });
      post({ type: "ready", model: msg.model.id });
    } catch (err) {
      asr = null;
      post({ type: "error", stage: "load", message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  if (msg.type === "run") {
    if (!asr) {
      post({ type: "error", stage: "run", id: msg.id, message: "モデルを読み込んでいません" });
      return;
    }
    try {
      const out = await asr(msg.audio, { language: msg.language, task: "transcribe", chunk_length_s: 30, stride_length_s: 5 });
      const text = Array.isArray(out) ? out.map((o) => o.text).join("") : out.text;
      post({ type: "text", id: msg.id, text: text.trim() });
    } catch (err) {
      post({ type: "error", stage: "run", id: msg.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
};
