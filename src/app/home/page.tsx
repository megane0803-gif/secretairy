import { TabPage } from "@/components/TabPage";
import { BigNumber, Checked, Fold, NotYet, Panel } from "@/components/parts";
import { getPendingApprovals } from "@/lib/approvals";
import { shopToday } from "@/lib/calendar";
import { getTodos } from "@/lib/data/seed";
import { loadBook } from "@/lib/reservations";
import { getMenus, getShop } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const approvals = getPendingApprovals();
  const shop = getShop();
  const { today, opened, shifted } = shopToday(shop);
  const book = loadBook(shop, getMenus(), today);
  const todos = getTodos().filter((t) => !t.done && (t.due === undefined || t.due <= 0));
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
      <h2>朝の要点（{today.label}）</h2>
      {shifted && <p className="shifted">{opened.label}はお休みなので、次の営業日を「今日」にしています。</p>}
      <div className="bignums">
        <BigNumber label="今日の予約" value={book.todayCount} unit="件" />
        <BigNumber label="承認待ち" value={approvals.length} unit="件" />
        <BigNumber label="今日の ToDo" value={todos.length} unit="件" />
      </div>
      <NotYet>AI が今日の気をつける点を3つまで短く書きます</NotYet>
      <Fold summary="くわしく">
        <p>朝の要点は、予約・承認待ち・ToDo から作ります。AI は数を変えません。</p>
      </Fold>
    </TabPage>
  );
}
