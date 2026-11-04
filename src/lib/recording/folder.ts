"use client";

// 録音フォルダ（PC の Chrome・Edge の File System Access）。最初に1回フォルダを選んで許可すると、
// 画面を開いている間、pollSeconds ごとに中を見て、新しい録音を同じ流れに回す（どれを読むかは seen.ts）。
// フォルダの印（handle）はブラウザの中（IndexedDB）に覚える。中のファイルはどこにも送らない。

import type { FolderEntry } from "./seen";

type Perm = "granted" | "denied" | "prompt";
type DirHandle = {
  name: string;
  values(): AsyncIterable<{ kind: "file" | "directory"; name: string; getFile?(): Promise<File> }>;
  getFileHandle(name: string): Promise<{ getFile(): Promise<File> }>;
  queryPermission?(o: { mode: "read" }): Promise<Perm>;
  requestPermission?(o: { mode: "read" }): Promise<Perm>;
};

export type FolderHandle = DirHandle;

export async function pickFolder(): Promise<FolderHandle> {
  const w = window as unknown as { showDirectoryPicker(o?: { mode?: "read"; id?: string }): Promise<DirHandle> };
  return w.showDirectoryPicker({ mode: "read", id: "secretairy-recording" });
}

/** 許可が続いているか。prompt のときは、人がボタンを押して許可しなおす（ブラウザの決まり） */
export async function folderPermission(h: FolderHandle, ask: boolean): Promise<Perm> {
  try {
    const now = (await h.queryPermission?.({ mode: "read" })) ?? "granted";
    if (now === "granted" || !ask) return now;
    return (await h.requestPermission?.({ mode: "read" })) ?? "denied";
  } catch {
    return "denied";
  }
}

/** フォルダの中のファイル（すぐ下だけ） */
export async function listFolder(h: FolderHandle): Promise<{ entry: FolderEntry; file: File }[]> {
  const out: { entry: FolderEntry; file: File }[] = [];
  for await (const item of h.values()) {
    if (item.kind !== "file" || !item.getFile) continue;
    try {
      const file = await item.getFile();
      out.push({ entry: { name: file.name, size: file.size, lastModified: file.lastModified }, file });
    } catch {
      // 読めないファイル（使っている途中など）は次に見る
    }
  }
  return out;
}

export async function folderFile(h: FolderHandle, name: string): Promise<File | null> {
  try {
    return await (await h.getFileHandle(name)).getFile();
  } catch {
    return null;
  }
}
