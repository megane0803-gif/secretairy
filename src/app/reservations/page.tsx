import { AiSteps } from "@/components/AiSteps";
import { ApprovalBox } from "@/components/ApprovalBox";
import { TabPage } from "@/components/TabPage";
import { Fold, Panel } from "@/components/parts";
import { getBookData } from "@/lib/book/data";
import { BookingSite } from "./BookingSite";
import { HolidayPanel } from "./HolidayPanel";
import { Ledger } from "./Ledger";
import { LedgerViewProvider } from "./LedgerView";
import { MenuTable } from "./MenuTable";
import { MonthCalendar } from "./MonthCalendar";
import { ReserveChat } from "./ReserveChat";
import { WeekTimetable } from "./WeekTimetable";

export const dynamic = "force-dynamic";

export default function ReservationsPage() {
  const data = getBookData();

  return (
    <TabPage
      tab="reservations"
      rightFirstOnPhone
      right={
        <Panel title="予約チャット">
          <p className="hint">お客様のスマホのつもりの画面です。AI が空きとルールを確かめて候補を出し、お客様が選ぶと「仮押さえ」まで進めます。</p>
          <ReserveChat data={data} />
        </Panel>
      }
    >
      {/* 見ている週・月・開いている「台帳から入れる」の1枚は、この共通の親（LedgerViewProvider）が1つだけ持つ（時間割・日ごとのカード・月のカレンダーが同じ週を指す） */}
      <LedgerViewProvider data={data}>
        {/* PC：真ん中の列の一番上に時間割の台帳（右の列の予約チャットと横に並ぶ）。スマホは隠し、下の日ごとのカードを出す（予約チャットが上の並びは今のまま） */}
        <WeekTimetable data={data} />

        <section className="inline-box" aria-labelledby="res-approvals">
          <h2 id="res-approvals">承認待ちの予約（ホームの承認の箱と同じ行）</h2>
          <ApprovalBox data={data} compact only="reservations" />
        </section>

        <section className="inline-box" aria-labelledby="res-steps">
          <h2 id="res-steps">AI の手順</h2>
          <p className="hint">どの道具で何を調べ、どのルールで外したかを、プログラムが1行ずつ書きます。</p>
          <AiSteps />
        </section>

        <section className="inline-box" aria-labelledby="res-holidays">
          <h2 id="res-holidays">休みの日（オーナーが決める）</h2>
          <HolidayPanel data={data} />
        </section>

        {/* 月のカレンダー（見るだけ）。PC は承認の箱・AI の手順の場所を動かさないよう、時間割の箱の外のここに。スマホは日ごとのカードのすぐ上 */}
        <section className="inline-box" aria-labelledby="res-month">
          <h2 id="res-month">月のカレンダー</h2>
          <MonthCalendar data={data} />
        </section>

        <div className="book-pair">
          <Ledger data={data} className="ledger-cards" />
          <BookingSite data={data} />
        </div>
      </LedgerViewProvider>

      <Fold summary="くわしく（最終受付と、組み合わせのメニュー）">
        <p>最初の状態は今日から2週間分（と、前回の来店の記録）です。</p>
        <MenuTable data={data} />
        <p className="hint">時間・値段・最終受付は、ルールのタブの「メニュー」で直せます。</p>
      </Fold>
    </TabPage>
  );
}
