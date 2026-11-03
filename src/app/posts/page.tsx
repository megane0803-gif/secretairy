import { TabPage } from "@/components/TabPage";
import { InputStub, NotYet, Panel } from "@/components/parts";

export default function PostsPage() {
  return (
    <TabPage
      tab="posts"
      right={
        <Panel title="発信のお題">
          <InputStub placeholder="例：冬におすすめのヘアケア" button="案を作る" />
        </Panel>
      }
    >
      <NotYet>SNS などに出す文の案がここに出ます。出すのは人が承認してから</NotYet>
    </TabPage>
  );
}
