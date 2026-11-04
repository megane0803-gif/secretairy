import { AiSteps } from "@/components/AiSteps";
import { ApprovalBox } from "@/components/ApprovalBox";
import { TabPage } from "@/components/TabPage";
import { Fold, Panel } from "@/components/parts";
import { getBookData } from "@/lib/book/data";
import { lastStartOf } from "@/lib/reservations";
import { BookingSite } from "./BookingSite";
import { Ledger } from "./Ledger";
import { ReserveChat } from "./ReserveChat";

export const dynamic = "force-dynamic";

export default function ReservationsPage() {
  const data = getBookData();
  const anyClose = Object.values(data.shop.hours).find((h) => h)?.close ?? "";

  return (
    <TabPage
      tab="reservations"
      right={
        <Panel title="予約チャット">
          <p className="hint">お客様のスマホのつもりの画面です。AI が空きとルールを確かめて候補を出し、お客様が選ぶと「仮押さえ」まで進めます。</p>
          <ReserveChat data={data} />
        </Panel>
      }
    >
      <section className="inline-box" aria-labelledby="res-approvals">
        <h2 id="res-approvals">承認待ち（ホームの承認の箱と同じ行）</h2>
        <ApprovalBox data={data} compact />
      </section>

      <section className="inline-box" aria-labelledby="res-steps">
        <h2 id="res-steps">AI の手順</h2>
        <p className="hint">どの道具で何を調べ、どのルールで外したかを、プログラムが1行ずつ書きます。</p>
        <AiSteps />
      </section>

      <div className="book-pair">
        <Ledger data={data} />
        <BookingSite data={data} />
      </div>

      <Fold summary="くわしく（最終受付と、組み合わせのメニュー）">
        <p>お客様はみな架空の方です。最初の状態は今日から2週間分（と、前回の来店の記録）です。</p>
        <table className="table">
          <thead>
            <tr>
              <th>メニュー</th>
              <th>かかる時間</th>
              <th>最終受付</th>
            </tr>
          </thead>
          <tbody>
            {data.menus.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.name}
                  {m.includes && (
                    <small className="hint"> （{m.includes.map((id) => data.menus.find((x) => x.id === id)?.name ?? id).join("・")}のルールも効く）</small>
                  )}
                </td>
                <td className="num">{m.minutes}分</td>
                <td className="num">{lastStartOf(m, anyClose)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Fold>
    </TabPage>
  );
}
