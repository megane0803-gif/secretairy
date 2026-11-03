import { TabPage } from "@/components/TabPage";
import { InputStub, MiniBar, Panel } from "@/components/parts";
import { getShop } from "@/lib/settings";
import { nextSevenDays } from "@/lib/week";

export const dynamic = "force-dynamic";

export default function ReservationsPage() {
  const shop = getShop();
  const days = nextSevenDays(shop.timezone);
  return (
    <TabPage
      tab="reservations"
      right={
        <Panel title="予約チャット">
          <p>AI がお客様と話して「仮押さえ」まで進めます。確定はホームの承認の箱で人が押します。</p>
          <InputStub placeholder="例：土曜の午後にカットをお願いしたいです" button="送る" />
        </Panel>
      }
    >
      <h2>1週間の予約台帳</h2>
      <div className="week">
        {days.map((d) => {
          const h = shop.hours[d.key];
          const closed = !h || shop.closedDates.includes(d.date);
          return (
            <div key={d.date} className={closed ? "day closed" : "day"}>
              <span className="day-date">{d.label}</span>
              {closed ? (
                <span className="day-hours">お休み</span>
              ) : (
                <>
                  <span className="day-count num">0</span>
                  <MiniBar value={0} max={shop.seats} label="埋まり" />
                  <span className="day-hours">
                    {h.open}–{h.close}
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>
    </TabPage>
  );
}
