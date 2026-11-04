import { TabPage } from "@/components/TabPage";
import { FieldList, Fold, Panel } from "@/components/parts";
import { CARD_GATE_LABELS } from "@/lib/accounting/sort";
import { CARD_FIELDS } from "@/lib/data/types";
import { getAccountingSettings } from "@/lib/settings";
import { CardStatement } from "./CardStatement";
import { RegisterPanel } from "./RegisterPanel";
import { SalesReport } from "./SalesReport";

/**
 * 経理のタブ。上に架空の1か月の売上（見るだけ）、その下に通販の明細（架空）の仕分け。
 * AI の予想は使わない：購入先ごとの自動のルールでプログラムが分け、ルールの無い物だけ人が店用か私用を選ぶ。
 * 承認の箱は使わない。登録は右の列の人のボタンだけ。
 */
export default function AccountingPage() {
  const settings = getAccountingSettings();
  return (
    <TabPage
      tab="accounting"
      right={
        <Panel title={`${settings.service}に登録`}>
          <RegisterPanel />
        </Panel>
      }
    >
      <SalesReport />
      <CardStatement />
      <Fold summary="くわしく（プログラムの確認と、明細の形）">
        <p>登録の前に、プログラムが2つ確かめます。どちらも ✓ になるまで登録のボタンは押せません。</p>
        <ul>
          <li>✓ {CARD_GATE_LABELS.allChosen}</li>
          <li>✓ {CARD_GATE_LABELS.autoAligned}（同じ購入先で店用と私用に分かれているのに「次から自動」に印があれば止めます）</li>
        </ul>
        <p>AI は使いません。承認の箱にも入れません（ホームの「承認待ち」にも数えません）。</p>
        <FieldList fields={CARD_FIELDS} />
      </Fold>
    </TabPage>
  );
}
