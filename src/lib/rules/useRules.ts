"use client";

// 画面で使うルール。最初の状態（鍵つき＋例のルール）に、このブラウザに残した分を重ねる。
// 書くのはこのブラウザの中だけ（サーバーには送らない）。書いたらすぐ、次の判定から効く。

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { readBrowser, RULES_KEY, subscribeBrowser, writeBrowser } from "../browser";
import { writeJournal } from "../journal";
import {
  isEmptyOverlay,
  mergeRules,
  parseOverlay,
  withAdded,
  withChanged,
  withRemoved,
  withRestored,
  type RuleOverlay,
} from "./overlay";
import type { Rule } from "./types";

const read = () => readBrowser(RULES_KEY);

export function useRules(seed: Rule[]) {
  const raw = useSyncExternalStore(subscribeBrowser, read, () => null);
  const seedIds = useMemo(() => seed.map((r) => r.id), [seed]);
  const overlay = useMemo(() => parseOverlay(raw, seedIds), [raw, seedIds]);
  const rules = useMemo(() => mergeRules(seed, overlay), [seed, overlay]);

  const save = useCallback(
    (f: (o: RuleOverlay) => RuleOverlay) => {
      // 書く直前に読みなおす（別の窓で変えた分を消さないように）
      const next = f(parseOverlay(read(), seedIds));
      writeBrowser(RULES_KEY, isEmptyOverlay(next) ? null : JSON.stringify(next));
    },
    [seedIds],
  );

  // ルールを足した・直した・消した、も日誌に書く（だれ：オーナー）
  const labelOf = useCallback((id: string) => rules.find((r) => r.id === id)?.label ?? id, [rules]);

  return {
    rules,
    overlay,
    changedCount: overlay.removed.length + Object.keys(overlay.changed).length + overlay.added.length,
    add: useCallback(
      (r: Rule) => {
        save((o) => withAdded(o, r));
        writeJournal({ who: "オーナー", text: `ルールを足した：${r.label}` });
      },
      [save],
    ),
    update: useCallback(
      (r: Rule) => {
        const before = labelOf(r.id);
        save((o) => withChanged(o, r, seedIds));
        writeJournal({ who: "オーナー", text: before === r.label ? `ルールを直した：${r.label}` : `ルールを直した：${before} → ${r.label}` });
      },
      [save, seedIds, labelOf],
    ),
    remove: useCallback(
      (id: string) => {
        const label = labelOf(id);
        save((o) => withRemoved(o, id, seedIds));
        writeJournal({ who: "オーナー", text: `ルールを消した：${label}` });
      },
      [save, seedIds, labelOf],
    ),
    restore: useCallback(
      (id: string) => {
        save((o) => withRestored(o, id));
        writeJournal({ who: "オーナー", text: `ルールを例に戻した：${seed.find((r) => r.id === id)?.label ?? id}` });
      },
      [save, seed],
    ),
    resetAll: useCallback(() => {
      writeBrowser(RULES_KEY, null);
      writeJournal({ who: "オーナー", text: "ルールを最初の状態（例のルール）に戻した" });
    }, []),
  };
}
