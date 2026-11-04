// 黙っている所と、音だけの所（ドライヤーのようにずっと同じ大きさの音）を飛ばす。プログラムだけで決める。
// 声は、音の大きさが細かく上がり下がりする（話の切れ目で小さくなる）。
// 1こまずつ、まわり（windowSeconds）のいちばん小さい音の modulationRatio 倍より大きく、minLevel より大きい所を声とみなす。

import type { SilenceSettings } from "../settings";

export type Span = { start: number; end: number };

/** 1こまずつの音の大きさ（二乗平均の根） */
export function frameLevels(samples: Float32Array, sampleRate: number, frameMs: number): Float32Array {
  const size = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const n = Math.ceil(samples.length / size);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    const a = f * size;
    const b = Math.min(samples.length, a + size);
    for (let i = a; i < b; i++) sum += samples[i] * samples[i];
    out[f] = Math.sqrt(sum / Math.max(1, b - a));
  }
  return out;
}

/** 声のある所（秒）。黙っている所・音だけの所は入らない */
export function speechSpans(samples: Float32Array, sampleRate: number, s: SilenceSettings): Span[] {
  const frameSec = s.frameMs / 1000;
  const levels = frameLevels(samples, sampleRate, s.frameMs);
  const n = levels.length;
  const half = Math.max(1, Math.round(s.windowSeconds / 2 / frameSec));
  // まわりのいちばん小さい音（前後 half こま）
  const floor = new Float32Array(n);
  const dq: number[] = [];
  let head = 0;
  for (let i = 0, j = 0; i < n; i++) {
    for (; j < n && j <= i + half; j++) {
      while (dq.length > head && levels[dq[dq.length - 1]] >= levels[j]) dq.pop();
      dq.push(j);
    }
    while (dq[head] < i - half) head++;
    floor[i] = levels[dq[head]];
  }
  const voiced = (i: number) => levels[i] >= s.minLevel && levels[i] >= floor[i] * s.modulationRatio;

  // 声のこまをつなぐ（短いすき間はつなぐ）。こまの番号で持つ
  const runs: { a: number; b: number }[] = [];
  let start = -1;
  let last = -1;
  const gap = Math.round(s.mergeGapSeconds / frameSec);
  for (let i = 0; i < n; i++) {
    if (!voiced(i)) continue;
    if (start < 0) start = i;
    else if (i - last > gap) {
      runs.push({ a: start, b: last + 1 });
      start = i;
    }
    last = i;
  }
  if (start >= 0) runs.push({ a: start, b: last + 1 });

  // 中で大きさが上がり下がりしない物（ずっと同じ音の始まり・終わり）は声ではない
  const modulated = (r: { a: number; b: number }) => {
    const lv = Array.from(levels.subarray(r.a, r.b)).sort((x, y) => x - y);
    const lo = lv[Math.floor((lv.length - 1) * 0.1)];
    const hi = lv[Math.floor((lv.length - 1) * 0.9)];
    return hi >= Math.max(lo, 1e-9) * s.modulationRatio;
  };
  const raw: Span[] = runs.filter(modulated).map((r) => ({ start: r.a * frameSec, end: r.b * frameSec }));

  // 短すぎる物は捨て、前後に少し足す（重なったらつなぐ）
  const total = samples.length / sampleRate;
  const out: Span[] = [];
  for (const r of raw) {
    if (r.end - r.start < s.minSpeechSeconds) continue;
    const span = { start: Math.max(0, r.start - s.padSeconds), end: Math.min(total, r.end + s.padSeconds) };
    const prev = out[out.length - 1];
    if (prev && span.start <= prev.end) prev.end = Math.max(prev.end, span.end);
    else out.push(span);
  }
  return out;
}

/** 声のある所だけをつないだ音（あいだに短い無音をはさむ）。文字にするのはこれだけ */
export function joinSpans(samples: Float32Array, sampleRate: number, spans: Span[], gapSeconds = 0.3): Float32Array {
  const gap = Math.round(gapSeconds * sampleRate);
  const parts = spans.map((sp) => samples.subarray(Math.floor(sp.start * sampleRate), Math.min(samples.length, Math.ceil(sp.end * sampleRate))));
  const length = parts.reduce((n, p) => n + p.length, 0) + gap * Math.max(0, parts.length - 1);
  const out = new Float32Array(length);
  let pos = 0;
  parts.forEach((p, i) => {
    out.set(p, pos);
    pos += p.length + (i < parts.length - 1 ? gap : 0);
  });
  return out;
}

export function spansSeconds(spans: Span[]): number {
  return spans.reduce((n, s) => n + (s.end - s.start), 0);
}

/**
 * 画面の録音：音が入っていないのが続いたら知らせる（プログラム）。
 * push に大きさと時刻を渡すと、quietWarnSeconds より長く quietLevel 未満が続いていれば true。
 */
export function quietWatch(quietLevel: number, quietWarnSeconds: number) {
  let quietSince: number | null = null;
  return {
    push(level: number, nowMs: number): boolean {
      if (level >= quietLevel) {
        quietSince = null;
        return false;
      }
      if (quietSince === null) quietSince = nowMs;
      return nowMs - quietSince >= quietWarnSeconds * 1000;
    },
  };
}
