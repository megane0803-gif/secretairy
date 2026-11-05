// 発信：手で直した下書きを、作り直しで消さないための決まり（プログラム。docs/SPEC.md §1.10）。
// 直したかどうかは、画面に出している文（text）と作ったときの文（made）を比べて決める。
// ここは決まりだけ（画面の状態は deskStore.ts。読むのも書くのも画面の部品）。

import type { PostDraft, PostsDesk } from "./deskStore";

/** 「下書きを作る」を押した時に、先に聞く1文 */
export const REDO_CONFIRM = "作り直すと今の下書きが置き換わります";

/** 作り直しが作れなかった時に、手で直した下書きを残したことを伝える1文 */
export const KEPT_AFTER_FAIL = "手で直した下書きはそのまま残しています。";

/** 手で直した下書きか（text と made がちがう） */
export function handEdited(draft: Pick<PostDraft, "text" | "made"> | null): boolean {
  return !!draft && draft.text !== draft.made;
}

/** 「下書きを作る」を押した時、すぐ作らずに「戻る／作り直す」を聞くか */
export function needsRedoConfirm(draft: Pick<PostDraft, "text" | "made"> | null): boolean {
  return handEdited(draft);
}

/**
 * 作り直しが言葉の門で弾かれた時の、画面の状態の変え方。
 * 手で直した下書きがあれば消さずに残し（作れなかった理由もいっしょに出す）、直していなければ今までどおり消す。
 */
export function afterFailedRedo(draft: PostDraft | null, failed: NonNullable<PostsDesk["failed"]>): Pick<PostsDesk, "draft" | "failed"> {
  return { draft: handEdited(draft) ? draft : null, failed };
}
