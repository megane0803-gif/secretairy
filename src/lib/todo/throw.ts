// 「メモを投げる」の後ろ半分：AI（か決まった返事）が直した文を ToDo に足して書く → 書けた時だけ日誌・「足しました」。
// 画面（MemoThrow.tsx）とテストが同じここを使う。
// 書けなかった時（ブラウザの置き場所がいっぱい・書き込みを断られた）は、入力と選んだ種類を残し、成功の文と日誌は出さない。

import { SAVE_FAILED_MESSAGE, type BrowserWrite } from "../browser";
import type { BookState } from "../book/state";
import type { JournalWho } from "../journal";
import type { ShopSettings } from "../settings";
import { withMemoTodo, type TodoItem } from "./items";
import type { MemoKind } from "./kinds";

export type MemoTodoDeps = {
  update: (f: (s: BookState) => BookState) => BrowserWrite;
  journal: (...lines: { who: JournalWho; text: string }[]) => void;
};

export type MemoTodoInput = {
  title: string;
  memo: string;
  due: string | null;
  category: MemoKind | null;
  /** だれが文を決めたか（サーバーの via）と、送った時の物（AI・決まった返事） */
  via: "ai" | "program";
  how: "ai" | "script";
  /** サーバーが添えた一言（あれば） */
  note?: string;
  seedItems: TodoItem[];
  shop: Pick<ShopSettings, "timezone">;
  nowIso: string;
};

/** ok: true の時だけ入力を空にする。why: same = 同じ物があるので足さなかった / write = 書けなかった（入力は残す） */
export type MemoTodoResult = { ok: true; message: string } | { ok: false; why: "same" | "write"; message: string };

export function commitMemoTodo(deps: MemoTodoDeps, input: MemoTodoInput): MemoTodoResult {
  let added: string | null = null;
  const w = deps.update((s) => {
    const r = withMemoTodo(s, input.seedItems, { title: input.title, memo: input.memo, due: input.due, category: input.category }, input.nowIso, input.shop);
    added = r.todo?.title ?? null;
    return r.state;
  });
  if (!w.ok) return { ok: false, why: "write", message: SAVE_FAILED_MESSAGE };
  if (!added) return { ok: false, why: "same", message: "同じ物があるので足しませんでした。" };
  deps.journal(
    { who: input.via === "ai" ? "AI" : "プログラム", text: `メモを ToDo に足した${input.how === "script" ? "（決まった返事）" : ""}：${input.title}（元のメモはそのまましまった）` },
    ...(input.note ? [{ who: "プログラム" as const, text: `メモを投げる：${input.note}` }] : []),
  );
  return { ok: true, message: `✓ 足しました：${input.title}${input.note ? `（${input.note}）` : ""}` };
}
