import { ApprovalBox } from "@/components/ApprovalBox";
import { JournalList } from "@/components/JournalList";
import { TabPage } from "@/components/TabPage";
import { Fold, NotYet, Panel } from "@/components/parts";
import { getBookData } from "@/lib/book/data";
import { getJobsSettings, getKarteHeadings, getTodoLimits } from "@/lib/settings";
import { needsOwnerPasscode } from "@/lib/line/server";
import { AiJobs } from "./AiJobs";
import { HomeSummary } from "./HomeSummary";
import { LinePanel } from "./LinePanel";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const data = getBookData();
  const todo = getTodoLimits();
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
      <HomeSummary data={data} headings={getKarteHeadings()} todo={todo} />
      <AiJobs data={data} settings={getJobsSettings()} />
      <NotYet>AI の一言（今日の気をつける点を3つまで）はまだです。今はプログラムが並べるだけです</NotYet>
      <Fold summary="くわしく">
        <p>朝の要点は、予約・承認待ち・ToDo・保存したカルテの次回提案・席の空きから、プログラムが並べます。AI は数を変えません。</p>
        <p>「今やる{todo.topCount}件」は ToDo のタブと同じ並べ方の上から{todo.topCount}つです（済んだ物は出しません）。「メモを投げる」は AI が短いタスクの文に直し、ToDo の「投げたメモ」に入ります。</p>
      </Fold>
    </TabPage>
  );
}
