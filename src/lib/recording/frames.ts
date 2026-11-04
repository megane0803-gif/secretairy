// mp3・aac（ADTS）は、こま（frame）が1つずつ切り離せる形。頭から順にこまの頭だけを読み、
// 区切りの長さ（10分くらい）ごとに、どのバイトで切るかを決める。ファイル全体を一度に広げない。

export type FrameKind = "mp3" | "aac";

export type FrameHeader = { length: number; samples: number; sampleRate: number; channels: number };

const MP3_BITRATE_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATE_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** mp3（MPEG 1/2/2.5 の Layer III）のこまの頭。読めなければ null */
export function mp3Header(b: Uint8Array, at: number): FrameHeader | null {
  if (at + 4 > b.length) return null;
  const b1 = b[at + 1];
  const b2 = b[at + 2];
  if (b[at] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const ver = (b1 >> 3) & 3;
  const layer = (b1 >> 1) & 3;
  if (ver === 1 || layer !== 1) return null;
  const brIdx = (b2 >> 4) & 0xf;
  const srIdx = (b2 >> 2) & 3;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const v1 = ver === 3;
  const bitrate = (v1 ? MP3_BITRATE_V1 : MP3_BITRATE_V2)[brIdx] * 1000;
  const sampleRate = MP3_RATES[ver][srIdx];
  const pad = (b2 >> 1) & 1;
  const length = Math.floor(((v1 ? 144 : 72) * bitrate) / sampleRate) + pad;
  const channels = ((b[at + 3] >> 6) & 3) === 3 ? 1 : 2;
  return { length, samples: v1 ? 1152 : 576, sampleRate, channels };
}

export const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** aac（ADTS）のこまの頭。読めなければ null */
export function adtsHeader(b: Uint8Array, at: number): FrameHeader | null {
  if (at + 7 > b.length) return null;
  if (b[at] !== 0xff || (b[at + 1] & 0xf6) !== 0xf0) return null;
  const sfIdx = (b[at + 2] >> 2) & 0xf;
  if (sfIdx >= ADTS_RATES.length) return null;
  const channels = ((b[at + 2] & 1) << 2) | (b[at + 3] >> 6);
  const length = ((b[at + 3] & 3) << 11) | (b[at + 4] << 3) | (b[at + 5] >> 5);
  if (length < 7) return null;
  const blocks = (b[at + 6] & 3) + 1;
  return { length, samples: 1024 * blocks, sampleRate: ADTS_RATES[sfIdx], channels };
}

/** ファイルの頭の ID3v2 の札（曲名など）の長さ。無ければ 0 */
export function id3Length(b: Uint8Array): number {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  const footer = b[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

/** ファイルの一部を読む（start〜end のバイト）。ブラウザでは File.slice、テストでは手元の配列 */
export type ByteReader = (start: number, end: number) => Promise<Uint8Array>;

export type ByteChunk = { index: number; startSec: number; endSec: number; start: number; end: number };

export type FramePlan = { durationSec: number; sampleRate: number; channels: number; chunks: ByteChunk[] };

const BLOCK = 4 * 1024 * 1024;
const OVERLAP = 16 * 1024;

/**
 * こまを頭から数えて、chunkSeconds ごとの切れ目を決める。読むのは BLOCK ずつ（ファイル全体を一度に広げない）。
 * こまの頭が読めない所（札・ゴミ）は1バイトずつずらして探しなおす。そのときは次のこまの頭も確かめる。
 */
export async function planFrames(kind: FrameKind, size: number, read: ByteReader, chunkSeconds: number): Promise<FramePlan | null> {
  const parse = kind === "mp3" ? mp3Header : adtsHeader;
  let bufStart = 0;
  let buf = await read(0, Math.min(size, BLOCK + OVERLAP));
  let pos = id3Length(buf);
  let time = 0;
  let sampleRate = 0;
  let channels = 0;
  let frames = 0;
  let synced = false;
  const chunks: ByteChunk[] = [];
  let chunkStart = -1;
  let chunkStartSec = 0;

  while (pos < size) {
    if (pos + OVERLAP > bufStart + buf.length && bufStart + buf.length < size) {
      bufStart = pos;
      buf = await read(pos, Math.min(size, pos + BLOCK + OVERLAP));
    }
    const at = pos - bufStart;
    const h = parse(buf, at);
    let ok = !!h;
    if (h && !synced) {
      // 探しなおした所では、次のこまの頭も読めるときだけ本物とみなす（終わりの近くは除く）
      const next = at + h.length;
      ok = next + 4 > buf.length ? bufStart + next >= size - 256 : !!parse(buf, next);
    }
    if (!h || !ok) {
      synced = false;
      pos++;
      continue;
    }
    synced = true;
    if (chunkStart < 0) {
      chunkStart = pos;
      chunkStartSec = time;
    }
    if (!sampleRate) {
      sampleRate = h.sampleRate;
      channels = h.channels;
    }
    time += h.samples / h.sampleRate;
    frames++;
    pos += h.length;
    if (time - chunkStartSec >= chunkSeconds) {
      chunks.push({ index: chunks.length, startSec: chunkStartSec, endSec: time, start: chunkStart, end: Math.min(pos, size) });
      chunkStart = -1;
    }
  }
  if (chunkStart >= 0) chunks.push({ index: chunks.length, startSec: chunkStartSec, endSec: time, start: chunkStart, end: Math.min(pos, size) });
  if (!frames) return null;
  return { durationSec: time, sampleRate, channels, chunks };
}

/** テスト用：中身が空の mp3 のこまを作る（MPEG1 Layer III・128kbps・44.1kHz、こま1つ 1152 の音） */
export function fakeMp3Frame(): Uint8Array {
  const h = [0xff, 0xfb, 0x90, 0x44];
  const length = Math.floor((144 * 128000) / 44100);
  const b = new Uint8Array(length);
  b.set(h);
  return b;
}

/** ADTS の頭（7バイト）。m4a の中の aac を、ブラウザが広げられる形にするのにも使う */
export function adtsHeaderBytes(profile: number, sfIndex: number, channels: number, frameLength: number): Uint8Array {
  const p = Math.max(0, profile - 1) & 3;
  return new Uint8Array([
    0xff,
    0xf1,
    (p << 6) | ((sfIndex & 0xf) << 2) | ((channels >> 2) & 1),
    ((channels & 3) << 6) | ((frameLength >> 11) & 3),
    (frameLength >> 3) & 0xff,
    ((frameLength & 7) << 5) | 0x1f,
    0xfc,
  ]);
}
