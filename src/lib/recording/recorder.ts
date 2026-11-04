"use client";

// 画面の録音（録音の機能が無いマイク向け）。PC につないだマイクから、ブラウザがそのまま録る。
// 録りながら segmentSeconds（10分）ごとに区切り、区切りはすぐブラウザの中（IndexedDB）にしまう（メモリにためない）。
// 録っている間は、経った時間と音の大きさを出し、音が入っていないのが続けば知らせる（quietWatch）。

import { quietWatch } from "./silence";

export type RecorderEvents = {
  /** 区切りが1つできた（しまうのは呼ぶ側） */
  onSegment(blob: Blob, index: number, seconds: number): Promise<void>;
  onLevel(level: number, quiet: boolean): void;
};

function pickMime(): string | undefined {
  const MR = (globalThis as unknown as { MediaRecorder?: { isTypeSupported(t: string): boolean } }).MediaRecorder;
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) if (MR?.isTypeSupported(t)) return t;
  return undefined;
}

export class SegmentRecorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cut: ReturnType<typeof setTimeout> | null = null;
  private rec: MediaRecorder | null = null;
  private index = 0;
  private segStart = 0;
  private pending: Promise<void>[] = [];
  private on = false;

  constructor(
    private segmentSeconds: number,
    private quietLevel: number,
    private quietWarnSeconds: number,
    private events: RecorderEvents,
  ) {}

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
    this.ctx = new AudioContext();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 2048;
    this.ctx.createMediaStreamSource(this.stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const watch = quietWatch(this.quietLevel, this.quietWarnSeconds);
    this.timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const level = Math.sqrt(sum / buf.length);
      this.events.onLevel(level, watch.push(level, Date.now()));
    }, 200);
    this.on = true;
    this.index = 0;
    this.next();
  }

  private next(): void {
    if (!this.stream || !this.on) return;
    const mime = pickMime();
    const rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    const parts: Blob[] = [];
    const index = this.index++;
    this.segStart = Date.now();
    const started = this.segStart;
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    let done!: () => void;
    this.pending.push(new Promise<void>((r) => (done = r)));
    rec.onstop = () => {
      const blob = new Blob(parts, { type: rec.mimeType || mime || "audio/webm" });
      const seconds = (Date.now() - started) / 1000;
      void this.events.onSegment(blob, index, seconds).finally(done);
    };
    // 区切りごとに録りなおす（どの区切りも、それだけで広げられる形になる）
    rec.start(1000);
    this.rec = rec;
    this.cut = setTimeout(() => {
      rec.stop();
      this.next();
    }, this.segmentSeconds * 1000);
  }

  /** 経った時間（秒） */
  elapsed(startedAt: number): number {
    return (Date.now() - startedAt) / 1000;
  }

  /** 止める。最後の区切りをしまい終えるまで待つ */
  async stop(): Promise<void> {
    this.on = false;
    if (this.cut) clearTimeout(this.cut);
    if (this.timer) clearInterval(this.timer);
    if (this.rec && this.rec.state !== "inactive") this.rec.stop();
    await Promise.all(this.pending);
    this.pending = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => undefined);
    this.stream = null;
    this.ctx = null;
    this.rec = null;
  }
}
