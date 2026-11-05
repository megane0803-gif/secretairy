// 見た目（docs/SPEC.md §3.5）。並び・文字・動きは変えず、色・字・角の丸みだけを入れ替える。
// <html data-look="smart|night|washi|pop"> で切りかえる（globals.css の土台の変数）。
// 選んだ物は見ている人のブラウザに覚える（LOOK_KEY。「最初に戻す」では消さない）。
// 画面に依らない形にしておき、画面を開いた瞬間に効かせる layout.tsx の小さな script も同じ一覧を使う。

export const LOOKS = ["smart", "night", "washi", "pop"] as const;

export type Look = (typeof LOOKS)[number];

/** 最初の見た目（今の見た目そのまま。OS の明るい／暗いに合わせる） */
export const DEFAULT_LOOK: Look = "smart";

export const LOOK_LABEL: Record<Look, string> = {
  smart: "スマート",
  night: "夜",
  washi: "和紙",
  pop: "ポップ",
};

export const LOOK_DESC: Record<Look, string> = {
  smart: "今の見た目。端末の明るい／暗いに合わせる",
  night: "いつも暗い。落ち着いた色",
  washi: "いつも明るい。紙のような色と明朝の見出し",
  pop: "いつも明るい。はっきりした色と丸い角",
};

/** 覚えた値から見た目を読む。知らない値・壊れた値・無い時はスマート */
export function parseLook(raw: unknown): Look {
  return typeof raw === "string" && (LOOKS as readonly string[]).includes(raw) ? (raw as Look) : DEFAULT_LOOK;
}

/**
 * どの見た目も必ず持つ土台の変数（globals.css の :root[data-look="…"]）。
 * 背景・面・線・字・薄い字・差し色・差し色の上の字・良い／気をつける・字・見出しの字と太さ・角の丸み・影。
 */
export const LOOK_BASE_VARS = [
  "--bg",
  "--surface",
  "--text",
  "--muted",
  "--line",
  "--accent",
  "--accent-soft",
  "--on-accent",
  "--ok",
  "--warn",
  "--font",
  "--font-head",
  "--head-weight",
  "--radius",
  "--radius-md",
  "--radius-sm",
  "--radius-xs",
  "--radius-2xs",
  "--radius-3xs",
  "--radius-pill",
  "--shadow",
] as const;

/**
 * 画面を開いた最初の描画の前に、覚えた見た目を <html> に付ける小さな script の中身（layout.tsx の head）。
 * 知らない値・壊れた値・読めない時は何も付けない（＝スマート）。
 */
export function lookRestoreScript(storageKey: string): string {
  return `try{var l=localStorage.getItem(${JSON.stringify(storageKey)});if(${JSON.stringify(LOOKS)}.indexOf(l)>=0)document.documentElement.dataset.look=l;}catch(e){}`;
}
