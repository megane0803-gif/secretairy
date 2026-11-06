// カルテの「保存」（人のボタン）の後ろ半分：台帳に書く → 書けた時だけ日誌・案を消す・「保存しました」。
// 画面（KarteBoard.tsx）とテストが同じここを使う。
// 🔒 呼ぶのは人の「保存」ボタンだけ（押したことは画面が isTrusted で確かめる）。
// 書けなかった時（ブラウザの置き場所がいっぱい・書き込みを断られた）は、案もメモも残し、成功の文と日誌は出さない。
// その後にもう一度押せば保存できる（台帳は前のままなので、2回目の保存の扱いにはならない）。

import { SAVE_FAILED_MESSAGE, type BrowserWrite } from "../browser";
import type { BookState } from "../book/state";
import type { JournalWho } from "../journal";
import type { KarteHeading } from "../settings";
import { withKarteSaved, type SaveOutcome, type SavedKarte } from "./record";

export type KarteSaveDeps = {
  /** 台帳を変えて書く（書けたかを返す。useBook の update） */
  update: (f: (s: BookState) => BookState) => BrowserWrite;
  journal: (...lines: { who: JournalWho; text: string }[]) => void;
  /** 書けた時だけ呼ぶ：案を消す */
  dropDraft: () => void;
};

export type KarteSaveInput = {
  karte: SavedKarte;
  surname: string;
  headings: KarteHeading[];
  /** 日誌に書く日付の札・メニューの名前・人が直した見出しの名前 */
  dayLabel: string;
  menuName: string;
  editedNames: string[];
};

/** ok: false の時、written = false は「書けなかった」（案は残っている）。true は「決まりで保存しなかった」（同じ日にもう保存した など） */
export type KarteSaveResult = { ok: true; message: string } | { ok: false; message: string; written: boolean };

export function commitKarteSave(deps: KarteSaveDeps, input: KarteSaveInput): KarteSaveResult {
  let out: SaveOutcome | null = null;
  const w = deps.update((s) => {
    out = withKarteSaved(s, input.karte, input.surname, input.headings);
    return out.state;
  });
  const result = out as SaveOutcome | null;
  if (!w.ok) return { ok: false, message: SAVE_FAILED_MESSAGE, written: false };
  if (!result || !result.ok) return { ok: false, message: result?.reason ?? "保存できませんでした。もう一度押してください。", written: true };
  const todoText =
    result.todo !== null
      ? `ToDo「次回話すこと」に1件足した：${result.todo.title}`
      : result.todoSkipped === "same"
        ? "ToDo「次回話すこと」は同じ物があるので足さなかった"
        : "次回提案が空なので ToDo には足さなかった";
  deps.journal({
    who: "オーナー",
    text: `人が保存：${input.surname}様のカルテ（${input.dayLabel} ${input.menuName}${input.editedNames.length ? `。人が直した見出し：${input.editedNames.join("・")}` : ""}）。${todoText}`,
  });
  deps.dropDraft();
  return { ok: true, message: `✓ 保存しました。${todoText}` };
}
