import { ApprovalBox } from "@/components/ApprovalBox";
import { JournalList } from "@/components/JournalList";
import { TabPage } from "@/components/TabPage";
import { Fold, NotYet, Panel } from "@/components/parts";
import { getBookData } from "@/lib/book/data";
import { getTodos } from "@/lib/data/seed";
import { HomeSummary } from "./HomeSummary";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const data = getBookData();
  const seedTodos = getTodos().filter((t) => !t.done && (t.due === undefined || t.due <= 0)).length;
  return (
    <TabPage
      tab="home"
      right={
        <>
          <Panel title="承認の箱" id="approvals">
            <ApprovalBox data={data} />
          </Panel>
          <Panel title="日誌">
            <JournalList timezone={data.shop.timezone} />
          </Panel>
        </>
      }
    >
      <HomeSummary data={data} seedTodos={seedTodos} />
      <NotYet>AI が今日の気をつける点を3つまで短く書きます</NotYet>
      <Fold summary="くわしく">
        <p>朝の要点は、予約・承認待ち・ToDo から作ります。AI は数を変えません。</p>
      </Fold>
    </TabPage>
  );
}
