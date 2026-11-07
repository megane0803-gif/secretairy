// ホームの欄の開け閉め（docs/SPEC.md §1.6）。画面に依らない関数だけ（テストは __tests__/folds.test.ts）。
// 開け閉めは見る人のブラウザに欄ごとに覚える（secretairy:homeFolds）。覚えた物があれば、PC／スマホの最初の状態より先に使う。
// 壊れている物・知らない欄・true/false でない物は読まない（その欄は最初の状態に戻る）。

/** 畳める欄（6つ）。承認BOX・朝の要点・まずやる3つ・一言メモは畳まない */
export const HOME_FOLD_IDS = ["customers", "notes", "free", "jobs", "journal", "line"] as const;
export type HomeFoldId = (typeof HOME_FOLD_IDS)[number];

export type HomeDevice = "pc" | "phone";

/** PC（3列）になる幅。globals.css の @media (min-width: 1024px) と同じ */
export const HOME_PC_MIN_WIDTH = 1024;

/** 最初の状態。PC：今日のお客様・今日の注意・空いている時間・これまでの動きは開く。スマホ：今日のお客様だけ開く */
const DEFAULT_OPEN: Record<HomeDevice, Record<HomeFoldId, boolean>> = {
  pc: { customers: true, notes: true, free: true, jobs: false, journal: true, line: false },
  phone: { customers: true, notes: false, free: false, jobs: false, journal: false, line: false },
};

export function defaultFoldOpen(id: HomeFoldId, device: HomeDevice): boolean {
  return DEFAULT_OPEN[device][id];
}

export function deviceOfWidth(width: number): HomeDevice {
  return width >= HOME_PC_MIN_WIDTH ? "pc" : "phone";
}

export type SavedFolds = Partial<Record<HomeFoldId, boolean>>;

const isFoldId = (k: string): k is HomeFoldId => (HOME_FOLD_IDS as readonly string[]).includes(k);

/** ブラウザに覚えた物を読む。壊れていれば空（＝全部最初の状態） */
export function parseFolds(raw: string | null): SavedFolds {
  if (!raw) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: SavedFolds = {};
  for (const [k, open] of Object.entries(v as Record<string, unknown>)) {
    if (isFoldId(k) && typeof open === "boolean") out[k] = open;
  }
  return out;
}

/** 開いているか。覚えた物が先、無ければ PC／スマホの最初の状態 */
export function foldOpen(id: HomeFoldId, device: HomeDevice, saved: SavedFolds): boolean {
  return saved[id] ?? defaultFoldOpen(id, device);
}

/** 1つの欄の開け閉めを覚えた形にして返す（ほかの欄の覚えた物はそのまま。壊れていた物は捨てる） */
export function withFold(raw: string | null, id: HomeFoldId, open: boolean): string {
  return JSON.stringify({ ...parseFolds(raw), [id]: open });
}
