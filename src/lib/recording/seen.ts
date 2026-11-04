// 録音フォルダ：入った新しい録音を見つける（プログラム）。読んだファイルは印を覚えて2回は読まない。
// コピーの途中のファイルを読まないように、前に見た時と大きさが変わっていない物（または少し前に書き終えた物）だけ読む。

import { formatOf } from "./formats";

export type FolderEntry = { name: string; size: number; lastModified: number };

/** ファイルの印（名前・大きさ・書いた時刻）。同じ印のファイルは2回は読まない */
export function fileKey(e: FolderEntry): string {
  return `${e.name}|${e.size}|${e.lastModified}`;
}

/**
 * 今回読む物を選ぶ。prevSizes は前に見た時の大きさ（名前ごと）。
 * 読むのは、受ける形・まだ読んでいない・大きさが前と同じか、書いてから stableMs より経った物。
 */
export function readyFiles(
  entries: FolderEntry[],
  seen: Set<string>,
  prevSizes: Record<string, number>,
  accept: string[],
  nowMs: number,
  stableMs: number,
): { ready: FolderEntry[]; sizes: Record<string, number> } {
  const sizes: Record<string, number> = {};
  const ready: FolderEntry[] = [];
  for (const e of entries) {
    if (!formatOf(e.name, accept)) continue;
    sizes[e.name] = e.size;
    if (seen.has(fileKey(e)) || e.size <= 0) continue;
    if (prevSizes[e.name] === e.size || nowMs - e.lastModified >= stableMs) ready.push(e);
  }
  ready.sort((a, b) => a.lastModified - b.lastModified || a.name.localeCompare(b.name));
  return { ready, sizes };
}

/** はじめてフォルダを選んだ時：sinceMs（今日の始まり）より前に書いた録音は「前からあった物」として読まずに印だけ付ける */
export function oldFileKeys(entries: FolderEntry[], accept: string[], sinceMs: number): string[] {
  return entries.filter((e) => formatOf(e.name, accept) && e.lastModified < sinceMs).map(fileKey);
}
