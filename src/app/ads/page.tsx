import { TabPage } from "@/components/TabPage";
import { InputStub, NotYet, Panel } from "@/components/parts";

export default function AdsPage() {
  return (
    <TabPage
      tab="ads"
      right={
        <Panel title="広告の案を頼む">
          <InputStub placeholder="例：平日の昼のお客様をふやしたい" button="案を作る" />
        </Panel>
      }
    >
      <NotYet>広告の案（大きいカード1枚：前→後と理由1文）がここに出ます</NotYet>
    </TabPage>
  );
}
