import { PracticeChat } from "@/components/PracticeChat";
import { TabPage } from "@/components/TabPage";
import { Checked, CustomerName, Fold, MiniBar, Panel } from "@/components/parts";
import { shopToday } from "@/lib/calendar";
import { lastStartOf, loadBook } from "@/lib/reservations";
import { getMenus, getShop } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default function ReservationsPage() {
  const shop = getShop();
  const menus = getMenus();
  const { today, opened, shifted } = shopToday(shop);
  const book = loadBook(shop, menus, today);
  const anyClose = Object.values(shop.hours).find((h) => h)?.close ?? "";

  return (
    <TabPage
      tab="reservations"
      right={
        <Panel title="予約チャット">
          <p>AI がお客様と話して「仮押さえ」まで進めます。確定はホームの承認の箱で人が押します。</p>
          <PracticeChat shopName={shop.name} />
        </Panel>
      }
    >
      <h2>1週間の予約台帳</h2>
      {shifted && (
        <p className="shifted">
          {opened.label}はお休みなので、次の営業日 {today.label} を「今日」にしています。
        </p>
      )}
      <div className="week-wrap">
        <ol className="week">
          {book.week.map((d) => (
            <li key={d.date} className={["day", d.open ? "" : "closed", d.isToday ? "today" : ""].join(" ").trim()}>
              <div className="day-head">
                <span className="day-date">{d.label}</span>
                {d.isToday && <span className="tag">今日</span>}
              </div>
              {!d.hours ? (
                <span className="day-hours">お休み</span>
              ) : (
                <>
                  <span className="day-count">
                    <strong className="num">{d.reservations.length}</strong> 件
                  </span>
                  <MiniBar value={d.usedMinutes} max={d.capacityMinutes} label="埋まり" />
                  <span className="day-hours">
                    {d.hours.open}–{d.hours.close}
                  </span>
                  <ul className="slots">
                    {d.reservations.map((r) => (
                      <li key={r.id} className={r.status === "hold" ? "slot hold" : "slot"}>
                        <span className="slot-time num">
                          {r.start}
                          <small>–{r.end}</small>
                        </span>
                        <span className="slot-menu">
                          {r.menu.name}
                          {r.status === "hold" && <span className="tag">仮押さえ</span>}
                        </span>
                        <CustomerName surname={r.customer.surname} fictional={r.customer.fictional} />
                        {r.customer.firstVisit && <span className="slot-first">初めての方</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </li>
          ))}
        </ol>
      </div>

      <div className="checks">
        {book.checks.seats.ok ? (
          <Checked>どの時間も、席の数（{shop.seats}席）をこえていません</Checked>
        ) : (
          <ul className="problems">
            {book.checks.seats.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {book.checks.hours.ok ? (
          <Checked>どの予約も、営業時間の中で最終受付までに始まります</Checked>
        ) : (
          <ul className="problems">
            {book.checks.hours.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </div>

      <Fold summary="くわしく（最終受付と、入っている予約の数）">
        <p>
          今日から2週間分の予約が入っています（全部で <strong className="num">{book.all.length}</strong> 件）。
          お客様はみな架空の方です。
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>メニュー</th>
              <th>かかる時間</th>
              <th>最終受付</th>
            </tr>
          </thead>
          <tbody>
            {menus.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
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
