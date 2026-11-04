import { TabPage } from "@/components/TabPage";
import { Panel } from "@/components/parts";
import { getBookData } from "@/lib/book/data";
import { getPostMemos } from "@/lib/data/seed";
import { getPostsMaterialMaxChars, getPostsSettings } from "@/lib/settings";
import { PostsBoard } from "./PostsBoard";
import { PostsForm } from "./PostsForm";

export const dynamic = "force-dynamic";

/**
 * 発信のタブ。お店からお客様に出す文の下書きを作る所（送信・公開はしない）。
 * ①種類を選ぶ ②材料を入れて「下書きを作る」（右の列）③見て、手で直して「下書きを保存」（真ん中）。
 */
export default function PostsPage() {
  const settings = getPostsSettings();
  const data = getBookData();
  return (
    <TabPage
      tab="posts"
      right={
        <Panel title="下書きを作る">
          <PostsForm data={data} settings={settings} memos={getPostMemos()} maxChars={getPostsMaterialMaxChars()} />
        </Panel>
      }
    >
      <PostsBoard settings={settings} timezone={data.shop.timezone} />
    </TabPage>
  );
}
