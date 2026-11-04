// 録音の文字・要点・画面で録った区切り・読んだ印・録音フォルダを、見ている人のブラウザの中（IndexedDB）に残す。
// サーバーには送らない（docs/SPEC.md §5.1）。区切りの音は大きいので localStorage ではなく IndexedDB に置く。

import type { Job, RecordingStore } from "./job";

export const RECORDING_DB = "secretairy-recording";
const STORES = ["jobs", "segments", "meta"] as const;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(RECORDING_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbp: Promise<IDBDatabase> | null = null;
const db = () => (dbp ??= open().catch((e) => {
  dbp = null;
  throw e;
}));

async function run<T>(store: (typeof STORES)[number], mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const d = await db();
  return new Promise<T>((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = f(tx.objectStore(store));
    let value: T;
    if (req) req.onsuccess = () => (value = req.result);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function idbRecordingStore(): RecordingStore {
  return {
    async getJob(id) {
      return ((await run<Job | undefined>("jobs", "readonly", (s) => s.get(id))) ?? null) as Job | null;
    },
    async putJob(job) {
      await run("jobs", "readwrite", (s) => void s.put(job, job.id));
    },
    async listJobs() {
      return (await run<Job[]>("jobs", "readonly", (s) => s.getAll())) ?? [];
    },
    async deleteJob(id) {
      await run("jobs", "readwrite", (s) => void s.delete(id));
    },
    async putSegment(id, data) {
      await run("segments", "readwrite", (s) => void s.put(data, id));
    },
    async getSegment(id) {
      return ((await run<Blob | undefined>("segments", "readonly", (s) => s.get(id))) ?? null) as Blob | null;
    },
    async getSeen() {
      return ((await run<string[] | undefined>("meta", "readonly", (s) => s.get("seen"))) ?? []) as string[];
    },
    async addSeen(keys) {
      const now = await this.getSeen();
      await run("meta", "readwrite", (s) => void s.put([...new Set([...now, ...keys])], "seen"));
    },
    async getMeta<T>(key: string) {
      return ((await run<T | undefined>("meta", "readonly", (s) => s.get(key))) ?? null) as T | null;
    },
    async setMeta(key, value) {
      await run("meta", "readwrite", (s) => void (value === null ? s.delete(key) : s.put(value, key)));
    },
    async clear() {
      for (const s of STORES) await run(s, "readwrite", (x) => void x.clear());
    },
  };
}
