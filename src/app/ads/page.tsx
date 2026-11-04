import { TabPage } from "@/components/TabPage";
import { FieldList, Fold, InputStub, NotYet, Panel } from "@/components/parts";
import { getAds } from "@/lib/data/seed";
import { AD_FIELDS } from "@/lib/data/types";

export default function AdsPage() {
  const ads = getAds();
  return (
    <TabPage
      tab="ads"
      right={
        <Panel title="広告の案を頼む">
          <InputStub placeholder="例：平日の昼のお客様をふやしたい" button="案を作る" />
        </Panel>
      }
    >
      <NotYet>
        広告の案（大きいカード1枚：前→後と理由1文）がここに出ます。今は {ads.length} 件（中身は後日）
      </NotYet>
      <Fold summary="くわしく（広告の案をどんな形で持つか）">
        <FieldList fields={AD_FIELDS} />
      </Fold>
    </TabPage>
  );
}
