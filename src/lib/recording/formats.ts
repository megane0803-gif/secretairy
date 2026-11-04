// 録音のファイルを受けるか（拡張子・大きさ・長さ）。上限の数は config/recording.json に持つ。
// 声のファイルはブラウザの中で読むだけで、どこにも送らない。

import type { RecordingSettings } from "../settings";

export type AudioFormat = "m4a" | "mp3" | "wav" | "aac";

export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

/** 受けるファイルの形。受けないときは null */
export function formatOf(name: string, accept: string[]): AudioFormat | null {
  const ext = extOf(name);
  const known: AudioFormat[] = ["m4a", "mp3", "wav", "aac"];
  return accept.includes(ext) && (known as string[]).includes(ext) ? (ext as AudioFormat) : null;
}

export function mbText(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024)).toLocaleString("ja-JP")}MB`;
}

export function durationText(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}時間${m}分` : `${h}時間`;
  if (m > 0) return `${m}分`;
  return `${s}秒`;
}

/** 「4時間半」のように上限を言う */
export function limitText(r: Pick<RecordingSettings, "maxBytes" | "maxSeconds">): string {
  const h = r.maxSeconds / 3600;
  const hours = Number.isInteger(h) ? `${h}時間` : Number.isInteger(h * 2) ? `${Math.floor(h)}時間半` : durationText(r.maxSeconds);
  return `${hours}・${mbText(r.maxBytes)}まで`;
}

export type FileCheck = { ok: true; format: AudioFormat } | { ok: false; reason: string };

/** 選んだファイルを受けるか（長さは読んでから lengthCheck で見る） */
export function checkFile(file: { name: string; size: number }, r: Pick<RecordingSettings, "accept" | "maxBytes">): FileCheck {
  const format = formatOf(file.name, r.accept);
  if (!format) return { ok: false, reason: `受けるのは ${r.accept.join("・")} です（${file.name}）` };
  if (file.size <= 0) return { ok: false, reason: `中身が空です（${file.name}）` };
  if (file.size > r.maxBytes) return { ok: false, reason: `${mbText(r.maxBytes)}までです（${file.name} は ${mbText(file.size)}）` };
  return { ok: true, format };
}

/** 読んでわかった長さが上限を超えていないか。超えていれば理由 */
export function lengthCheck(durationSec: number, r: Pick<RecordingSettings, "maxSeconds" | "maxBytes">): string | null {
  if (!(durationSec > 0)) return "録音の長さが読めませんでした";
  if (durationSec > r.maxSeconds + 1) return `${limitText(r)}です（この録音は ${durationText(durationSec)}）`;
  return null;
}
