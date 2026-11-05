import { TabPage } from "@/components/TabPage";
import { Panel } from "@/components/parts";
import { getBookData } from "@/lib/book/data";
import { getPostMemos } from "@/lib/data/seed";
import { getPostsMaterialMaxChars, getPostsSettings } from "@/lib/settings";
import { PostsDraft, PostsSaved } from "./PostsBoard";
import { PostsForm } from "./PostsForm";

export const dynamic = "force-dynamic";

/**
 * 発信のタブ。お店からお客様に出す文の下書きを作る所（送信・公開はしない）。
 * 真ん中の列の上から「下書きを作る」（①種類を選ぶ ②材料を入れる）→ ③見て、手で直して「下書きを保存」。右の列は「保存した下書き」。
 * スマホは上から「下書きを作る」→ ③ → 保存した下書き（真ん中 → 右の列のふつうの並び。部品は1つずつ）。
 */
export default function PostsPage() {
  const settings = getPostsSettings();
  const data = getBookData();
  const memos = getPostMemos();
  return (
    <TabPage tab="posts" right={<PostsSaved settings={settings} timezone={data.shop.timezone} />}>
      <Panel title="下書きを作る">
        <PostsForm data={data} settings={settings} memos={memos} maxChars={getPostsMaterialMaxChars()} />
      </Panel>
      <PostsDraft settings={settings} data={data} memos={memos} />
    </TabPage>
  );
}
