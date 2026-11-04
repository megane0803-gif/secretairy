import { ApprovalBox } from "@/components/ApprovalBox";
import { JournalList } from "@/components/JournalList";
import { TabPage } from "@/components/TabPage";
import { Fold, NotYet, Panel } from "@/components/parts";
import { getBookData } from "@/lib/book/data";
import { getKarteHeadings } from "@/lib/settings";
import { getTodos } from "@/lib/data/seed";
import { needsOwnerPasscode } from "@/lib/line/server";
import { HomeSummary } from "./HomeSummary";
import { LinePanel } from "./LinePanel";

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
          <Panel title="LINE とつなぐ" id="line">
            <LinePanel data={data} headings={getKarteHeadings()} needsPasscode={needsOwnerPasscode()} />
          </Panel>
          <Panel title="日誌">
            <JournalList timezone={data.shop.timezone} />
          </Panel>
        </>
      }
    >
      <HomeSummary data={data} seedTodos={seedTodos} headings={getKarteHeadings()} />
      <NotYet>AI の一言（今日の気をつける点を3つまで）はまだです。今はプログラムが並べるだけです</NotYet>
      <Fold summary="くわしく">
        <p>朝の要点は、予約・承認待ち・ToDo・保存したカルテの次回提案・席の空きから、プログラムが並べます。AI は数を変えません。</p>
      </Fold>
    </TabPage>
  );
}
