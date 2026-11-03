import { TabPage } from "@/components/TabPage";
import { InputStub, NotYet, Panel } from "@/components/parts";

export default function AccountingPage() {
  return (
    <TabPage
      tab="accounting"
      right={
        <Panel title="お金の出入りを書く">
          <InputStub placeholder="例：11/3 シャンプー仕入れ 12,000円" button="書きこむ" />
        </Panel>
      }
    >
      <NotYet>今月の売上・使ったお金を、大きい数字と小さい棒で見せます</NotYet>
    </TabPage>
  );
}
