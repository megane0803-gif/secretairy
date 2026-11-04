import { TabPage } from "@/components/TabPage";
import { FieldList, Fold, InputStub, Panel } from "@/components/parts";
import { getTodos } from "@/lib/data/seed";
import { TODO_FIELDS } from "@/lib/data/types";
import { TodoList } from "./TodoList";

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
      <h2>やることの一覧</h2>
      <TodoList seed={todos} />
      <Fold summary="くわしく（やることをどんな形で持つか）">
        <FieldList fields={TODO_FIELDS} />
      </Fold>
    </TabPage>
  );
}
