// m4a（MP4 の入れ物の中に aac）を読む。中の目次（moov）だけを読み、音のこまの場所と長さを知る。
// 区切りごとに、そのこまだけを読んで ADTS の頭を付け、ブラウザが広げられる aac にする。ファイル全体は広げない。

import { ADTS_RATES, adtsHeaderBytes, type ByteReader } from "./frames";

export type Mp4Audio = {
  timescale: number;
  durationSec: number;
  sampleRate: number;
  channels: number;
  /** aac の種類（2 = AAC-LC） */
  profile: number;
  sfIndex: number;
  /** こまごとのファイルの中の場所と大きさ */
  offsets: Float64Array;
  sizes: Uint32Array;
  /** こまごとの始まりの時刻（timescale の単位） */
  times: Float64Array;
};

export type SampleChunk = { index: number; startSec: number; endSec: number; first: number; last: number };

type Box = { type: string; start: number; end: number };

const ascii = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

function children(b: Uint8Array, start: number, end: number): Box[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = v.getUint32(pos);
    const type = ascii(b, pos + 4);
    let head = 8;
    if (size === 1) {
      size = Number(v.getBigUint64(pos + 8));
      head = 16;
    } else if (size === 0) size = end - pos;
    if (size < head || pos + size > end) break;
    out.push({ type, start: pos + head, end: pos + size });
    pos += size;
  }
  return out;
}

const find = (b: Uint8Array, box: Box, type: string) => children(b, box.start, box.end).find((c) => c.type === type);

function path(b: Uint8Array, box: Box | undefined, ...types: string[]): Box | undefined {
  let cur = box;
  for (const t of types) cur = cur && find(b, cur, t);
  return cur;
}

/** ファイルの頭から箱をたどって moov を探す（moov が後ろにあっても、箱の頭だけ読む） */
async function readMoov(size: number, read: ByteReader): Promise<Uint8Array | null> {
  let pos = 0;
  while (pos + 8 <= size) {
    const h = await read(pos, Math.min(size, pos + 16));
    const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let box = v.getUint32(0);
    const type = ascii(h, 4);
    let head = 8;
    if (box === 1 && h.length >= 16) {
      box = Number(v.getBigUint64(8));
      head = 16;
    } else if (box === 0) box = size - pos;
    if (box < head) return null;
    if (type === "moov") {
      // 目次が大きすぎるファイルは読まない（音のファイルの目次は数MBまで）
      if (box > 64 * 1024 * 1024) return null;
      return read(pos, pos + box);
    }
    pos += box;
  }
  return null;
}

/** 音のしくみの設定（AudioSpecificConfig）から、aac の種類・音の細かさの番号・音の道の数 */
export function parseAsc(asc: Uint8Array): { profile: number; sfIndex: number; sampleRate: number; channels: number } | null {
  let bit = 0;
  const take = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = asc[(bit >> 3)] ?? 0;
      v = (v << 1) | ((byte >> (7 - (bit & 7))) & 1);
      bit++;
    }
    return v;
  };
  const aot = () => {
    const a = take(5);
    return a === 31 ? 32 + take(6) : a;
  };
  const rate = () => {
    const i = take(4);
    if (i === 15) {
      const r = take(24);
      const idx = ADTS_RATES.indexOf(r);
      return { idx, r };
    }
    return { idx: i, r: ADTS_RATES[i] ?? 0 };
  };
  let profile = aot();
  let sf = rate();
  const channels = take(4);
  // HE-AAC（SBR・PS）は、中の AAC-LC の形で読む
  if (profile === 5 || profile === 29) {
    rate();
    profile = aot();
  }
  if (profile < 1 || profile > 4 || sf.idx < 0 || sf.idx >= ADTS_RATES.length || !channels) return null;
  sf = { idx: sf.idx, r: ADTS_RATES[sf.idx] };
  return { profile, sfIndex: sf.idx, sampleRate: sf.r, channels };
}

/** esds の中の、音のしくみの設定（DecoderSpecificInfo）を取り出す */
function ascFromEsds(b: Uint8Array, box: Box): Uint8Array | null {
  let pos = box.start + 4;
  const readLen = () => {
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const c = b[pos++];
      n = (n << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return n;
  };
  while (pos < box.end) {
    const tag = b[pos++];
    const len = readLen();
    if (tag === 0x03) {
      pos += 2;
      const flags = b[pos++];
      if (flags & 0x80) pos += 2;
      if (flags & 0x40) pos += 1 + b[pos];
      if (flags & 0x20) pos += 2;
    } else if (tag === 0x04) {
      const oti = b[pos];
      // 0x40 = MPEG-4 の音（aac）、0x66〜0x68 = MPEG-2 の aac
      if (oti !== 0x40 && !(oti >= 0x66 && oti <= 0x68)) return null;
      pos += 13;
    } else if (tag === 0x05) return b.subarray(pos, pos + len);
    else pos += len;
  }
  return null;
}

/** m4a の音の目次を読む。aac でない・読めないときは null */
export async function parseMp4Audio(size: number, read: ByteReader): Promise<Mp4Audio | null> {
  const moov = await readMoov(size, read);
  if (!moov) return null;
  const v = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const top = children(moov, 0, moov.length).find((c) => c.type === "moov");
  if (!top) return null;
  for (const trak of children(moov, top.start, top.end).filter((c) => c.type === "trak")) {
    const mdia = find(moov, trak, "mdia");
    const hdlr = mdia && find(moov, mdia, "hdlr");
    if (!mdia || !hdlr || ascii(moov, hdlr.start + 8) !== "soun") continue;
    const mdhd = find(moov, mdia, "mdhd");
    const stbl = path(moov, mdia, "minf", "stbl");
    if (!mdhd || !stbl) continue;
    const ver = moov[mdhd.start];
    const timescale = ver === 1 ? v.getUint32(mdhd.start + 20) : v.getUint32(mdhd.start + 12);
    const stsd = find(moov, stbl, "stsd");
    if (!stsd) continue;
    const entry = children(moov, stsd.start + 8, stsd.end)[0];
    if (!entry || entry.type !== "mp4a") return null;
    const ev = v.getUint16(entry.start + 8);
    const extra = ev === 1 ? 16 : ev === 2 ? 36 : 0;
    const esds = children(moov, entry.start + 28 + extra, entry.end).find((c) => c.type === "esds");
    const asc = esds && ascFromEsds(moov, esds);
    const cfg = asc && parseAsc(asc);
    if (!cfg) return null;

    // こまの大きさ
    const stsz = find(moov, stbl, "stsz");
    if (!stsz) return null;
    const uniform = v.getUint32(stsz.start + 4);
    const count = v.getUint32(stsz.start + 8);
    const sizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) sizes[i] = uniform || v.getUint32(stsz.start + 12 + i * 4);

    // 入れ物の中のまとまり（chunk）の場所
    const stco = find(moov, stbl, "stco");
    const co64 = find(moov, stbl, "co64");
    const chunkOffsets: number[] = [];
    if (stco) for (let i = 0, n = v.getUint32(stco.start + 4); i < n; i++) chunkOffsets.push(v.getUint32(stco.start + 8 + i * 4));
    else if (co64) for (let i = 0, n = v.getUint32(co64.start + 4); i < n; i++) chunkOffsets.push(Number(v.getBigUint64(co64.start + 8 + i * 8)));
    else return null;

    // まとまりごとのこまの数
    const stsc = find(moov, stbl, "stsc");
    if (!stsc) return null;
    const runs: { first: number; per: number }[] = [];
    for (let i = 0, n = v.getUint32(stsc.start + 4); i < n; i++)
      runs.push({ first: v.getUint32(stsc.start + 8 + i * 12), per: v.getUint32(stsc.start + 12 + i * 12) });
    const offsets = new Float64Array(count);
    let k = 0;
    for (let c = 0; c < chunkOffsets.length && k < count; c++) {
      const run = [...runs].reverse().find((r) => r.first <= c + 1);
      let off = chunkOffsets[c];
      for (let s = 0; s < (run?.per ?? 0) && k < count; s++) {
        offsets[k] = off;
        off += sizes[k];
        k++;
      }
    }
    if (k < count) return null;

    // こまごとの時刻
    const stts = find(moov, stbl, "stts");
    if (!stts) return null;
    const times = new Float64Array(count + 1);
    let t = 0;
    let s = 0;
    for (let i = 0, n = v.getUint32(stts.start + 4); i < n; i++) {
      const c = v.getUint32(stts.start + 8 + i * 8);
      const d = v.getUint32(stts.start + 12 + i * 8);
      for (let j = 0; j < c && s < count; j++) {
        times[s++] = t;
        t += d;
      }
    }
    while (s < count) times[s++] = t;
    times[count] = t;
    return { timescale, durationSec: t / timescale, sampleRate: cfg.sampleRate, channels: cfg.channels, profile: cfg.profile, sfIndex: cfg.sfIndex, offsets, sizes, times };
  }
  return null;
}

/** chunkSeconds ごとに、どのこまからどのこままでかを決める */
export function planSamples(a: Mp4Audio, chunkSeconds: number): SampleChunk[] {
  const out: SampleChunk[] = [];
  const n = a.sizes.length;
  let first = 0;
  while (first < n) {
    const limit = a.times[first] + chunkSeconds * a.timescale;
    let last = first;
    while (last + 1 < n && a.times[last + 1] < limit) last++;
    out.push({ index: out.length, startSec: a.times[first] / a.timescale, endSec: a.times[last + 1] / a.timescale, first, last });
    first = last + 1;
  }
  return out;
}

/** 1つの区切りのこまを読み、ADTS の頭を付けた aac にする（ブラウザが広げられる形） */
export async function samplesToAdts(a: Mp4Audio, c: SampleChunk, read: ByteReader): Promise<Uint8Array> {
  const start = a.offsets[c.first];
  const end = a.offsets[c.last] + a.sizes[c.last];
  const raw = await read(start, end);
  let total = 0;
  for (let i = c.first; i <= c.last; i++) total += a.sizes[i] + 7;
  const out = new Uint8Array(total);
  let pos = 0;
  for (let i = c.first; i <= c.last; i++) {
    const size = a.sizes[i];
    out.set(adtsHeaderBytes(a.profile, a.sfIndex, a.channels, size + 7), pos);
    const at = a.offsets[i] - start;
    out.set(raw.subarray(at, at + size), pos + 7);
    pos += size + 7;
  }
  return out;
}

/** テスト用：aac のこまを並べた、いちばん小さい m4a を作る（moov を後ろに置く） */
export function fakeM4a(frameSizes: number[], sampleRate = 44100, channels = 1): Uint8Array {
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const u16 = (n: number) => [(n >> 8) & 255, n & 255];
  const box = (type: string, ...parts: number[][]) => {
    const body = parts.flat();
    return [...u32(body.length + 8), ...[...type].map((c) => c.charCodeAt(0)), ...body];
  };
  const sfIndex = ADTS_RATES.indexOf(sampleRate);
  // AudioSpecificConfig：AAC-LC（2）・音の細かさの番号・音の道
  const ascBits = (2 << 11) | (sfIndex << 7) | (channels << 3);
  const asc = u16(ascBits);
  const dsi = [0x05, asc.length, ...asc];
  const dcd = [0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0, ...u32(0), ...u32(0), ...dsi];
  const esd = [0x03, 3 + dcd.length, 0, 1, 0, ...dcd];
  const esds = box("esds", u32(0), esd);
  const mp4a = box("mp4a", [0, 0, 0, 0, 0, 0], u16(1), u32(0), u32(0), u16(channels), u16(16), u16(0), u16(0), u32(sampleRate * 65536), esds);
  const stsd = box("stsd", u32(0), u32(1), mp4a);
  const stts = box("stts", u32(0), u32(1), u32(frameSizes.length), u32(1024));
  const stsc = box("stsc", u32(0), u32(1), u32(1), u32(frameSizes.length), u32(1));
  const stsz = box("stsz", u32(0), u32(0), u32(frameSizes.length), frameSizes.flatMap(u32));
  const ftyp = box("ftyp", [..."M4A "].map((c) => c.charCodeAt(0)), u32(0));
  const mdatBody = frameSizes.flatMap((n, i) => Array.from({ length: n }, (_, j) => (i + j) & 255));
  const mdat = box("mdat", mdatBody);
  const stco = box("stco", u32(0), u32(1), u32(ftyp.length + 8));
  const stbl = box("stbl", stsd, stts, stsc, stsz, stco);
  const minf = box("minf", stbl);
  const hdlr = box("hdlr", u32(0), u32(0), [..."soun"].map((c) => c.charCodeAt(0)), u32(0), u32(0), u32(0), [0]);
  const mdhd = box("mdhd", u32(0), u32(0), u32(0), u32(sampleRate), u32(frameSizes.length * 1024), u16(0), u16(0));
  const mdia = box("mdia", mdhd, hdlr, minf);
  const trak = box("trak", mdia);
  const moov = box("moov", trak);
  return new Uint8Array([...ftyp, ...mdat, ...moov]);
}
