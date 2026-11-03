import { TabPage } from "@/components/TabPage";
import { InputStub, NotYet, Panel } from "@/components/parts";

export default function TodoPage() {
  return (
    <TabPage
      tab="todo"
      right={
        <Panel title="やることを足す">
          <InputStub placeholder="例：カラー剤の発注" button="足す" />
        </Panel>
      }
    >
      <NotYet>やることの一覧がここに並びます</NotYet>
    </TabPage>
  );
}
