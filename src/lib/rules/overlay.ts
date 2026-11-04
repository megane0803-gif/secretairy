// 最初の状態（例のルール）に、オーナーが足した・直した・消した分を重ねる。
// 重ねる分は見ている人のブラウザの中だけに残す（docs/SPEC.md §5.1）。ここは形と重ね方だけ（どこにも書かない）。
// 鍵つきの2つは、重ねる分に何が書かれていても、いつも先頭にそのまま入る。

import { LOCKED_RULES } from "./locked";
import type { Rule } from "./types";
import { validateOwnerRule } from "./validate";

export type RuleOverlay = {
  /** 消した例のルールの id */
  removed: string[];
  /** 直した例のルール（id ごと） */
  changed: Record<string, Rule>;
  /** オーナーが足したルール */
  added: Rule[];
};

export const EMPTY_OVERLAY: RuleOverlay = { removed: [], changed: {}, added: [] };

/** locked = 鍵つき / seed = 例のまま / changed = 例を直した / added = 足した */
export type RuleOrigin = "locked" | "seed" | "changed" | "added";
export type ListedRule = Rule & { origin: RuleOrigin };

const LOCKED_IDS = new Set(LOCKED_RULES.map((r) => r.id));

/** ブラウザに残っていた文字を読む。形のおかしい物・鍵つきに触る物は落とす */
export function parseOverlay(raw: string | null, seedIds: string[]): RuleOverlay {
  if (!raw) return EMPTY_OVERLAY;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return EMPTY_OVERLAY;
  }
  if (!data || typeof data !== "object") return EMPTY_OVERLAY;
  const d = data as Partial<Record<keyof RuleOverlay, unknown>>;
  const seed = new Set(seedIds);

  const removed = Array.isArray(d.removed)
    ? d.removed.filter((id): id is string => typeof id === "string" && seed.has(id))
    : [];

  const changed: Record<string, Rule> = {};
  if (d.changed && typeof d.changed === "object") {
    for (const [id, r] of Object.entries(d.changed as Record<string, unknown>)) {
      if (!seed.has(id) || LOCKED_IDS.has(id)) continue;
      const v = validateOwnerRule({ ...(r as object), id });
      if (v.ok) changed[id] = v.value;
    }
  }

  const added: Rule[] = [];
  const seen = new Set<string>();
  if (Array.isArray(d.added)) {
    for (const r of d.added) {
      const v = validateOwnerRule(r);
      if (!v.ok || seed.has(v.value.id) || LOCKED_IDS.has(v.value.id) || seen.has(v.value.id)) continue;
      seen.add(v.value.id);
      added.push(v.value);
    }
  }
  return { removed, changed, added };
}

export function isEmptyOverlay(o: RuleOverlay): boolean {
  return o.removed.length === 0 && Object.keys(o.changed).length === 0 && o.added.length === 0;
}

/** 鍵つき → 例のルール（直した物は差しかえ、消した物は抜く）→ 足したルール の順に並べる */
export function mergeRules(seed: Rule[], o: RuleOverlay): ListedRule[] {
  const out: ListedRule[] = LOCKED_RULES.map((r) => ({ ...r, locked: true, origin: "locked" }));
  for (const s of seed) {
    if (LOCKED_IDS.has(s.id) || o.removed.includes(s.id)) continue;
    const c = o.changed[s.id];
    out.push(c ? { ...c, id: s.id, origin: "changed" } : { ...s, locked: undefined, origin: "seed" });
  }
  for (const a of o.added) out.push({ ...a, origin: "added" });
  return out;
}

// ---- 重ねる分を変える（新しい形を返すだけ。書くのは呼んだ側） ----

export function withAdded(o: RuleOverlay, r: Rule): RuleOverlay {
  return { ...o, added: [...o.added, r] };
}

export function withChanged(o: RuleOverlay, r: Rule, seedIds: string[]): RuleOverlay {
  if (seedIds.includes(r.id)) return { ...o, changed: { ...o.changed, [r.id]: r } };
  return { ...o, added: o.added.map((a) => (a.id === r.id ? r : a)) };
}

export function withRemoved(o: RuleOverlay, id: string, seedIds: string[]): RuleOverlay {
  if (LOCKED_IDS.has(id)) return o;
  if (seedIds.includes(id)) {
    const changed = { ...o.changed };
    delete changed[id];
    return { ...o, removed: o.removed.includes(id) ? o.removed : [...o.removed, id], changed };
  }
  return { ...o, added: o.added.filter((a) => a.id !== id) };
}

/** 直した例のルールを、例のままに戻す */
export function withRestored(o: RuleOverlay, id: string): RuleOverlay {
  const changed = { ...o.changed };
  delete changed[id];
  return { ...o, changed, removed: o.removed.filter((x) => x !== id) };
}
