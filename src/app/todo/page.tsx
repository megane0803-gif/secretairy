import { MemoThrow } from "@/components/MemoThrow";
import { TabPage } from "@/components/TabPage";
import { TodoTop } from "@/components/TodoTop";
import { FieldList, Fold, Panel } from "@/components/parts";
import { getBookData } from "@/lib/book/data";
import { TODO_FIELDS } from "@/lib/data/types";
import { getTodoLimits } from "@/lib/settings";
import { TodoList } from "./TodoList";

export const dynamic = "force-dynamic";

export default function TodoPage() {
  const data = getBookData();
  const limits = getTodoLimits();
  return (
    <TabPage
      tab="todo"
      right={
        // PC の右の列：メモを投げる・今やる3件（スマホはページの上にメモの欄だけ）
        <div className="pc-only">
          <Panel title="メモを投げる">
            <MemoThrow data={data} maxChars={limits.maxMemoChars} />
          </Panel>
          <Panel title={`今やる${limits.topCount}件`}>
            <TodoTop data={data} count={limits.topCount} undoSeconds={limits.undoSeconds} />
          </Panel>
        </div>
      }
    >
      <div className="sp-only">
        <MemoThrow data={data} maxChars={limits.maxMemoChars} />
      </div>
      <h2>やることの一覧</h2>
      <TodoList data={data} undoSeconds={limits.undoSeconds} />
      <Fold summary="使い方">
        <ul className="todo-howto">
          <li>
            入口：メモを投げる（ホームと、このタブ）・カルテの「次回話すこと」・広告の判定日・予約の「直す」「見送り」と予約サイト（架空）で枠が埋まった時・LINE の一言・予約チャットの「お店に確かめてご連絡します」。同じ物（同じ鍵）はもう一度足しません。
          </li>
          <li>メモは {limits.maxMemoChars} 字まで。Enter でも投げられます。AI（Claude）が短いタスクの文に直します（AI が決めるのは文だけ）。元のメモはそのまましまってあり、行の 📝 を押すと開きます。</li>
          <li>
            並べ方はプログラムが決めます：期限あり（先頭はお客様への連絡（今日中）、そのあと 過ぎている → 今日 → 今週（日曜まで）→ 来週から）→ 次回話すこと → 投げたメモ → 期限なし。過ぎた物は灰色の札です。
          </li>
          <li>チェックすると「済み」へ移ります。{limits.undoSeconds} 秒の間は「戻す」で戻せます。ホームの「今やる{limits.topCount}件」も同じ並べ方の上から{limits.topCount}つです。</li>
          <li>ホームの「最初に戻す」で、ToDo も最初の状態（架空の例）に戻ります。</li>
        </ul>
        <FieldList fields={TODO_FIELDS} />
      </Fold>
    </TabPage>
  );
}
