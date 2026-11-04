// wav の頭（どんな音か・どこから中身か）を読む・作る。区切りごとに小さい wav を作ってブラウザで広げる。

export type WavInfo = {
  /** 1 = 整数の PCM / 3 = 小数の PCM */
  formatTag: 1 | 3;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
  byteRate: number;
  /** 中身（data）の始まり（ファイルの頭から何バイト目か） */
  dataOffset: number;
  /** 中身の大きさ（バイト） */
  dataBytes: number;
};

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/** ファイルの頭（数十KB〜）から wav の形を読む。読めなければ null。fileSize は中身の大きさが書かれていない時に使う */
export function parseWav(head: Uint8Array, fileSize: number): WavInfo | null {
  if (head.length < 12 || ascii(head, 0, 4) !== "RIFF" || ascii(head, 8, 4) !== "WAVE") return null;
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let pos = 12;
  let fmt: Omit<WavInfo, "dataOffset" | "dataBytes"> | null = null;
  while (pos + 8 <= head.length) {
    const id = ascii(head, pos, 4);
    const size = v.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === "fmt " && body + 16 <= head.length) {
      let tag = v.getUint16(body, true);
      const bits = v.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE：中の形（GUID の頭2バイト）を見る
      if (tag === 0xfffe && size >= 40 && body + 26 <= head.length) tag = v.getUint16(body + 24, true);
      if (tag !== 1 && tag !== 3) return null;
      fmt = {
        formatTag: tag,
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        byteRate: v.getUint32(body + 8, true),
        blockAlign: v.getUint16(body + 12, true),
        bitsPerSample: bits,
      };
      if (!fmt.channels || !fmt.sampleRate || !fmt.blockAlign) return null;
    } else if (id === "data") {
      if (!fmt) return null;
      const rest = Math.max(0, fileSize - body);
      // 録りながら書いたファイルは大きさが 0 や最大のままのことがある
      const dataBytes = size === 0 || size === 0xffffffff || size > rest ? rest : size;
      return { ...fmt, dataOffset: body, dataBytes: dataBytes - (dataBytes % fmt.blockAlign) };
    }
    pos = body + size + (size % 2);
  }
  return null;
}

export function wavSeconds(w: WavInfo): number {
  return w.dataBytes / w.blockAlign / w.sampleRate;
}

/** 中身（PCM）の前に付ける 44 バイトの頭 */
export function wavHeader(w: Pick<WavInfo, "formatTag" | "channels" | "sampleRate" | "bitsPerSample" | "blockAlign">, dataBytes: number): Uint8Array {
  const b = new Uint8Array(44);
  const v = new DataView(b.buffer);
  const put = (at: number, s: string) => [...s].forEach((c, i) => (b[at + i] = c.charCodeAt(0)));
  put(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  put(8, "WAVE");
  put(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, w.formatTag, true);
  v.setUint16(22, w.channels, true);
  v.setUint32(24, w.sampleRate, true);
  v.setUint32(28, w.sampleRate * w.blockAlign, true);
  v.setUint16(32, w.blockAlign, true);
  v.setUint16(34, w.bitsPerSample, true);
  put(36, "data");
  v.setUint32(40, dataBytes, true);
  return b;
}

/** テストと画面の録音用：小数の音（-1〜1）を 16 ビットの wav にする */
export function encodeWav16(samples: Float32Array, sampleRate: number): Uint8Array {
  const head = wavHeader({ formatTag: 1, channels: 1, sampleRate, bitsPerSample: 16, blockAlign: 2 }, samples.length * 2);
  const out = new Uint8Array(44 + samples.length * 2);
  out.set(head);
  const v = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return out;
}

/** 16 ビットの wav の中身を小数の音に戻す（テスト用。1つ目の音の道だけ） */
export function decodeWav16(bytes: Uint8Array): Float32Array {
  const w = parseWav(bytes, bytes.length);
  if (!w || w.bitsPerSample !== 16) throw new Error("16 ビットの wav ではありません");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = w.dataBytes / w.blockAlign;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = v.getInt16(w.dataOffset + i * w.blockAlign, true) / 32768;
  return out;
}
