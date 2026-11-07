// 発信：③「下書きを保存」1回の全部（人のボタンだけが呼ぶ）。画面に依らない形（ブラウザに書く所・日誌は deps で受け取る）。
// 書く直前に読みなおし、同じ文・使わない言葉・種類ごとの上限を確かめてから書く。書けた時だけ日誌に1行と「保存しました」。
// 保存できた時だけ、③の下書きの欄と②の材料の欄（その下書きの種類の材料）を空にする（選んだ種類は残す。元へ戻すボタンは作らない。
// 保存した下書きは「保存した下書き」の欄にある）。保存できなかった時（同じ文・使わない言葉・上限・ブラウザに書けない）は何も消さない。
// 送信・公開はしない。承認BOXは通さない。

import { SAVE_FAILED_MESSAGE, type BrowserWrite } from "../browser";
import type { JournalWho } from "../journal";
import type { PostDraft, PostsDesk } from "./deskStore";
import { draftName } from "./draftName";
import { withSavedPost, type PostsState, type SavedPost } from "./state";

export type PostSaveDeps = {
  /** 書く直前に読みなおす */
  read: () => PostsState;
  /** 書けたかを返す（writeBrowser の答え） */
  write: (s: PostsState) => BrowserWrite;
  journal: (...lines: { who: JournalWho; text: string }[]) => void;
};

export type PostSaveInput = {
  draft: PostDraft;
  kindLabel: string;
  id: string;
  nowIso: string;
  gateWords: string[];
  maxPerKind: number;
};

/** 保存した下書きの欄がどこにあるか（PC は右の列・スマホはこのページの下） */
export type SavedWhere = "右" | "下";

/** 保存できた時の1文（どこに入ったかが分かる形） */
export const savedNote = (kindLabel: string, where: SavedWhere) => `保存しました（${kindLabel}）。${where}の「保存した下書き」に入っています。`;

export type PostSave =
  | { ok: true; post: SavedPost; state: PostsState }
  | { ok: false; reason: string; code: "empty" | "dup" | "words" | "full" | "write" };

/** 🔒 オーナーが「下書きを保存」を押した時だけ呼ぶ */
export function savePostDraft(deps: PostSaveDeps, input: PostSaveInput): PostSave {
  const { draft, kindLabel } = input;
  const r = withSavedPost(deps.read(), draft, { id: input.id, nowIso: input.nowIso, gateWords: input.gateWords, maxPerKind: input.maxPerKind });
  if (!r.ok) {
    if (r.code === "dup") deps.journal({ who: "プログラム", text: `${draftName(kindLabel)}：同じ文はもう保存してあるので、二重に保存しなかった` });
    if (r.code === "words") deps.journal({ who: "プログラム", text: `${draftName(kindLabel)}：手で直した文に使わない言葉があったので、保存しなかった` });
    return { ok: false, reason: r.reason, code: r.code };
  }
  const w = deps.write(r.state);
  if (!w.ok) return { ok: false, reason: SAVE_FAILED_MESSAGE, code: "write" };
  deps.journal({
    who: "オーナー",
    text: `${draftName(kindLabel)}を保存した（${[...r.post.text].length}字${draft.handEdited ? "・手で直した" : ""}${(draft.version ?? 0) > 0 ? `・補佐の直しを${draft.version}つ入れた` : ""}。送信・公開はしていない）`,
  });
  return { ok: true, post: r.post, state: r.state };
}

/**
 * 保存できた後の机：③の下書きと、その下書きの種類の②の材料を空にする。選んだ種類・AI か決まった返事かの切りかえは残す。
 * 保存できなかった時は呼ばない（何も消さない）。
 */
export function deskAfterSave(desk: PostsDesk, kind: string): Partial<PostsDesk> {
  return { draft: null, failed: null, problem: null, materials: { ...desk.materials, [kind]: {} } };
}
