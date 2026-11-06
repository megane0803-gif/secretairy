// 見ている人のブラウザの中だけに残す置き場所（docs/SPEC.md §5.1）。
// サーバーには送らない。読めない・書けないブラウザ（内緒モードなど）でも画面は動くようにする。

const PREFIX = "secretairy:";
const listeners = new Set<() => void>();

export function readBrowser(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function writeBrowser(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(PREFIX + key);
    else window.localStorage.setItem(PREFIX + key, value);
  } catch {
    // 書けないときは、この画面を開いている間だけ効く
  }
  listeners.forEach((f) => f());
}

/** useSyncExternalStore 用 */
export function subscribeBrowser(f: () => void): () => void {
  listeners.add(f);
  const onStorage = (e: StorageEvent) => {
    if (!e.key || e.key.startsWith(PREFIX)) f();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(f);
    window.removeEventListener("storage", onStorage);
  };
}

/** 左のタブを畳んだか・右の列の幅。画面を開いた瞬間に効かせるため layout.tsx の小さな script からも読む */
export const NAV_KEY = "navCollapsed";
export const RIGHT_KEY = "rightWidth";
export const TABS_KEY = "tabSwitches";
/** オーナーが足した・直した・消したルール（例のルールに重ねる分） */
export const RULES_KEY = "rules";
/** 予約チャットから入った予約・承認の箱・足した ToDo・起点の日（book/state.ts） */
export const BOOK_KEY = "book";
/** 広告の承認の箱・止めた／外した言葉（ads/state.ts） */
export const ADS_KEY = "ads";
/** 経理：通販の明細で選んだ印・会計への登録・足した自動のルール（accounting/state.ts） */
export const ACCOUNTING_KEY = "accounting";
/** 経理：freee（テスト事業所）の記録（freee/state.ts）。画面の中の会計の記録（accounting）とは分けて持つ。鍵は持たない（鍵は HttpOnly の cookie） */
export const FREEE_KEY = "freee";
/** LINE のつなぎ（line/state.ts）。その画面だけが持つ印と、届けた・受け取った物の id（LINE の人の番号は持たない） */
export const LINE_KEY = "line";
/** カルテの「録音からメモを作る」を出す・隠す（最初の状態は config/recording.json の visible） */
export const RECORDING_SWITCH_KEY = "recordingVisible";
/** 発信：保存した下書き（posts/state.ts） */
export const POSTS_KEY = "posts";
/** ホームの「AI の仕事」：済んだ行と結果（jobs/state.ts）。「最初に戻す」で消える */
export const JOBS_KEY = "jobs";
/** ホームの「AI の仕事」の表示スイッチ（画面で変えた分。「最初に戻す」では消さない） */
export const JOBS_SWITCH_KEY = "jobsSwitch";
/** ホームの欄の開け閉め（home/folds.ts。欄ごとに覚える。「最初に戻す」では消さない） */
export const HOME_FOLDS_KEY = "homeFolds";
/** 見た目（look.ts。スマート・夜・和紙・ポップ。「最初に戻す」では消さない。画面を開いた瞬間に効かせるため layout.tsx の小さな script からも読む） */
export const LOOK_KEY = "look";
/** 日誌（journal.ts） */
export const JOURNAL_KEY = "journal";
export const BROWSER_PREFIX = PREFIX;
