import { ApprovalBox } from "@/components/ApprovalBox";
import { JournalCount, JournalList } from "@/components/JournalList";
import { RememberFold } from "@/components/RememberFold";
import { ResetBook } from "@/components/ResetBook";
import { TabPage } from "@/components/TabPage";
import { ActorTag, Fold, Panel } from "@/components/parts";
import { getBookData } from "@/lib/book/data";
import { getBriefLimits, getJobsSettings, getKarteHeadings, getReminderSettings, getTodoLimits } from "@/lib/settings";
import { needsOwnerPasscode } from "@/lib/line/server";
import { AiJobsProvider, AiJobsRunBar, AiJobsSection } from "./AiJobs";
import { HomeSummary } from "./HomeSummary";
import { LinePanel } from "./LinePanel";

export const dynamic = "force-dynamic";

// ホームの並び（docs/SPEC.md §1.6）。欄は「題名＋1行の説明＋だれの札」。細かい欄は開け閉めでき、ブラウザに覚える（RememberFold）。
// 真ん中：承認待ち＋まとめて動かす → 朝の要点（数字3枚＋まずやる3つ）→ 一言メモ → 今日のお客様 → 今日の注意 → 空いている時間 → AI に頼める仕事 → くわしく・最初に戻す
// 右の列：承認の箱 → これまでの動き（日誌）→ LINE とつなぐ。スマホは真ん中の並びのまま、その後に右の列。
export default function HomePage() {
  const data = getBookData();
  const todo = getTodoLimits();
  return (
    <AiJobsProvider data={data} settings={getJobsSettings()}>
      <TabPage
        tab="home"
        beside={<AiJobsRunBar />}
        right={
          <>
            <Panel title="承認の箱" id="approvals" tag={<ActorTag actor="human" />} desc="確認して決める物。決めるのはオーナーです">
              <ApprovalBox data={data} />
            </Panel>
            <RememberFold
              id="journal"
              className="panel"
              title="これまでの動き（日誌）"
              count={<JournalCount />}
              desc="AI・プログラム・人がしたことを、新しい順に並べています"
            >
              <JournalList timezone={data.shop.timezone} />
            </RememberFold>
            <RememberFold
              id="line"
              anchor="line"
              className="panel"
              title="LINE とつなぐ"
              tag={<ActorTag actor="outside" />}
              desc="オーナーの LINE から一言で頼めるようにします"
            >
              <LinePanel data={data} headings={getKarteHeadings()} needsPasscode={needsOwnerPasscode()} />
            </RememberFold>
          </>
        }
      >
        <HomeSummary data={data} headings={getKarteHeadings()} todo={todo} reminder={getReminderSettings()} brief={getBriefLimits()} />
        <AiJobsSection />
        <div className="home-bottom">
          <Fold summary="くわしく">
            <p>朝の要点は、予約・承認待ち・ToDo・保存したカルテの次回提案・席の空きから、プログラムが並べます。AI は数を変えません。</p>
            <p>「今日の注意」は、今日の予約・承認待ち・ToDo から気をつける点を AI（Claude）が書きます。日時・数字・お名前はプログラムが入れ、言葉の門を通した物だけ出します。AI につながらない時は出しません。</p>
            <p>「翌日へ」を押すと、その日にご予約のあるお客様（架空）に届いたつもりの前日のお知らせを見せます。文は決まった形で、実際には送信しません。</p>
            <p>
              「まずやる{todo.topCount}つ」は ToDo のタブと同じ並べ方の上から{todo.topCount}つです（済んだ物は出しません）。「思いついたことを一言メモ」は AI が短いタスクの文に直し、ToDo の「投げたメモ」に入ります。
            </p>
            <p>「今日のお客様」「今日の注意」「今日これから空いている時間」「AI に頼める仕事」「これまでの動き（日誌）」「LINE とつなぐ」は、見出しを押すと開け閉めできます。開け閉めはこのブラウザに覚えます。</p>
          </Fold>
          <div className="reset-row">
            <ResetBook data={data} />
            <span className="tag text">デモ</span>
          </div>
        </div>
      </TabPage>
    </AiJobsProvider>
  );
}
