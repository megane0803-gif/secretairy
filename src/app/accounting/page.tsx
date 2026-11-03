import { TabPage } from "@/components/TabPage";
import { FieldList, Fold, InputStub, NotYet, Panel } from "@/components/parts";
import { getMoneyEntries } from "@/lib/data/seed";
import { MONEY_FIELDS } from "@/lib/data/types";

export default function AccountingPage() {
  const entries = getMoneyEntries();
  return (
    <TabPage
      tab="accounting"
      right={
        <Panel title="お金の出入りを書く">
          <InputStub placeholder="例：シャンプー仕入れ 12,000円" button="書きこむ" />
        </Panel>
      }
    >
      <NotYet>
        今月の売上・使ったお金を、大きい数字と小さい棒で見せます。今は {entries.length} 件（中身は後日）
      </NotYet>
      <Fold summary="くわしく（お金の出入りをどんな形で持つか）">
        <FieldList fields={MONEY_FIELDS} />
      </Fold>
    </TabPage>
  );
}
