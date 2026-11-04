// 録音のファイルを、10分くらいずつの区切りに分ける（どこからどこまでかを決めるだけ。広げるのは区切りごと）。
// 区切りの中身は、ブラウザがそのまま広げられる小さな音のファイル（wav・mp3・aac）にして返す。

import type { AudioFormat } from "./formats";
import { planFrames, type ByteReader } from "./frames";
import { parseMp4Audio, planSamples, samplesToAdts, type Mp4Audio } from "./mp4";
import { parseWav, wavHeader, wavSeconds, type WavInfo } from "./wav";

/** 1つの区切り（ジョブに残す形。JSON にできる） */
export type ChunkPlan = {
  index: number;
  startSec: number;
  endSec: number;
  /** ファイルのどのバイトからどのバイトまでか（m4a はこまの番号） */
  start: number;
  end: number;
};

export type AudioPlan = {
  format: AudioFormat;
  durationSec: number;
  chunks: ChunkPlan[];
  /** 区切りの中身を作るのに使う（JSON にはしない） */
  wav?: WavInfo;
  mp4?: Mp4Audio;
};

/** wav は中身の大きさと1秒の大きさから、そのまま切れ目を決める */
export function planWav(w: WavInfo, chunkSeconds: number): ChunkPlan[] {
  const per = Math.max(w.blockAlign, Math.floor((chunkSeconds * w.sampleRate)) * w.blockAlign);
  const out: ChunkPlan[] = [];
  for (let off = 0; off < w.dataBytes; off += per) {
    const end = Math.min(w.dataBytes, off + per);
    out.push({
      index: out.length,
      startSec: off / w.blockAlign / w.sampleRate,
      endSec: end / w.blockAlign / w.sampleRate,
      start: w.dataOffset + off,
      end: w.dataOffset + end,
    });
  }
  return out;
}

/** ファイルを読んで区切りを決める。読めないときは null */
export async function planAudio(format: AudioFormat, size: number, read: ByteReader, chunkSeconds: number): Promise<AudioPlan | null> {
  if (format === "wav") {
    const w = parseWav(await read(0, Math.min(size, 1024 * 1024)), size);
    if (!w) return null;
    return { format, durationSec: wavSeconds(w), chunks: planWav(w, chunkSeconds), wav: w };
  }
  if (format === "m4a") {
    const a = await parseMp4Audio(size, read);
    if (!a) return null;
    const chunks = planSamples(a, chunkSeconds).map((c) => ({ index: c.index, startSec: c.startSec, endSec: c.endSec, start: c.first, end: c.last }));
    return { format, durationSec: a.durationSec, chunks, mp4: a };
  }
  const p = await planFrames(format, size, read, chunkSeconds);
  if (!p) return null;
  return { format, durationSec: p.durationSec, chunks: p.chunks };
}

/** 1つの区切りの中身を、ブラウザが広げられる小さな音のファイルにする */
export async function chunkBytes(plan: AudioPlan, c: ChunkPlan, read: ByteReader): Promise<Uint8Array> {
  if (plan.format === "wav" && plan.wav) {
    const data = await read(c.start, c.end);
    const out = new Uint8Array(44 + data.length);
    out.set(wavHeader(plan.wav, data.length));
    out.set(data, 44);
    return out;
  }
  if (plan.format === "m4a" && plan.mp4) return samplesToAdts(plan.mp4, { ...c, first: c.start, last: c.end }, read);
  return read(c.start, c.end);
}

/** 手元の配列を読む物（テスト用・画面の録音の区切り用） */
export function bytesReader(b: Uint8Array): ByteReader {
  return async (start, end) => b.subarray(start, Math.min(end, b.length));
}
