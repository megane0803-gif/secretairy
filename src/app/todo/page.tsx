import { TabPage } from "@/components/TabPage";
import { FieldList, Fold, InputStub, NotYet, Panel } from "@/components/parts";
import { getTodos } from "@/lib/data/seed";
import { TODO_FIELDS } from "@/lib/data/types";

export default function TodoPage() {
  const todos = getTodos();
  return (
    <TabPage
      tab="todo"
      right={
        <Panel title="やることを足す">
          <InputStub placeholder="例：カラー剤の発注" button="足す" />
        </Panel>
      }
    >
      <NotYet>やることの一覧がここに並びます。今は {todos.length} 件（中身は後日）</NotYet>
      <Fold summary="くわしく（やることをどんな形で持つか）">
        <FieldList fields={TODO_FIELDS} />
      </Fold>
    </TabPage>
  );
}
