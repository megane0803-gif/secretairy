import { TabPage } from "@/components/TabPage";
import { BigNumber, Checked, Fold, NotYet, Panel } from "@/components/parts";
import { getPendingApprovals } from "@/lib/approvals";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const approvals = getPendingApprovals();
  return (
    <TabPage
      tab="home"
      right={
        <>
          <Panel title="承認の箱" id="approvals">
            {approvals.length === 0 ? (
              <Checked>承認待ちはありません</Checked>
            ) : (
              <NotYet>承認カード（前→後・理由1文・確定/やめるのボタン）</NotYet>
            )}
          </Panel>
          <Panel title="日誌">
            <NotYet>AI がしたこと・人が押したボタンが、新しい順に並びます</NotYet>
          </Panel>
        </>
      }
    >
      <h2>朝の要点</h2>
      <div className="bignums">
        <BigNumber label="今日の予約" value={0} unit="件" />
        <BigNumber label="承認待ち" value={approvals.length} unit="件" />
        <BigNumber label="今日の ToDo" value={0} unit="件" />
      </div>
      <NotYet>AI が今日の気をつける点を3つまで短く書きます</NotYet>
      <Fold summary="くわしく">
        <p>朝の要点は、予約・承認待ち・ToDo から作ります。AI は数を変えません。</p>
      </Fold>
    </TabPage>
  );
}
