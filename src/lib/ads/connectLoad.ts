// 本物の側の結果を読み込んで「本物に反映済み」の印を付ける、ただ1つの道（docs/SPEC.md §1.7.6・§1.7.8）。
// 貼った結果（AdsConnect）も、テスト用アカウントに送った結果（AdsLive。サーバーが同じ形で返す）も、ここを通す（印の付け方を2つ作らない）。
// 書く直前に読みなおした状態で照らす（readSyncResult → withSynced）。書けた時だけ日誌。

import type { BrowserWrite } from "../browser";
import { SAVE_FAILED_MESSAGE } from "../browser";
import { writeJournal } from "../journal";
import { readSyncResult, withSynced, type ConnectSettings } from "./connect";
import type { AdsState } from "./state";

export type LoadResult = { ok: true; marked: number; notes: string[] } | { ok: false; note: string };

export function loadSyncResult(
  raw: string,
  p: { read: () => AdsState; update: (f: (s: AdsState) => AdsState) => BrowserWrite; words: readonly string[]; settings: ConnectSettings; journal: string; now?: () => string },
): LoadResult {
  const r = readSyncResult(raw, p.read(), p.words, p.settings);
  if (!r.ok) return { ok: false, note: r.note };
  let n = 0;
  const w = p.update((s) => {
    const again = readSyncResult(raw, s, p.words, p.settings);
    if (!again.ok) return s;
    n = again.marks.length;
    return withSynced(s, again.marks, (p.now ?? (() => new Date().toISOString()))());
  });
  if (!w.ok) return { ok: false, note: SAVE_FAILED_MESSAGE };
  writeJournal({ who: "オーナー", text: `${p.journal}：反映済みの印 ${n}件${r.notes.length ? `・知らせ ${r.notes.length}件` : ""}` });
  return { ok: true, marked: n, notes: r.notes };
}
