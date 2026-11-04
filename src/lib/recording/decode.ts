"use client";

// ブラウザで、1つの区切り（小さな音のファイル）だけを広げて、16kHz・1つの音の道の音にする。
// ファイル全体は一度に広げない（区切りを1つずつ）。声はブラウザの中だけで扱う。

import type { ByteReader } from "./frames";

/** File（や Blob）の一部を読む */
export function blobReader(b: Blob): ByteReader {
  return async (start, end) => new Uint8Array(await b.slice(start, end).arrayBuffer());
}

/** 小さな音のファイルを広げる（ブラウザが sampleRate に合わせて直す）。音の道が2つ以上なら混ぜて1つに */
export async function decodeMono(data: Uint8Array | ArrayBuffer, sampleRate: number): Promise<Float32Array> {
  const ab = data instanceof Uint8Array ? data.slice().buffer : data;
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  const buf = await ctx.decodeAudioData(ab as ArrayBuffer);
  if (buf.numberOfChannels === 1) return new Float32Array(buf.getChannelData(0));
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  return out;
}
