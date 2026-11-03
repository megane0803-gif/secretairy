import { TabPage } from "@/components/TabPage";
import { CustomerName, Fold, InputStub, NotYet, Panel } from "@/components/parts";
import { getCustomers } from "@/lib/data/seed";
import { getKarteHeadings } from "@/lib/settings";

export default function KartePage() {
  const headings = getKarteHeadings();
  const customers = getCustomers();
  return (
    <TabPage
      tab="karte"
      right={
        <Panel title="施術のメモ">
          <p>メモを書くと、AI がカルテの案を作ります。人が承認するまで保存しません。</p>
          <InputStub placeholder="例：前回より1トーン明るく。根元5cm。" button="カルテの案を作る" />
        </Panel>
      }
    >
      <h2>お客様（{customers.length}人・みな架空）</h2>
      <ul className="customers">
        {customers.map((c) => (
          <li key={c.id}>
            <CustomerName surname={c.surname} fictional={c.fictional} />
            {c.firstVisit && <span className="slot-first">初めての方</span>}
          </li>
        ))}
      </ul>
      <NotYet>お客様ごとのカルテがここに並びます</NotYet>
      <Fold summary="カルテの見出し">
        <ol className="karte-headings">
          {headings.map((h) => (
            <li key={h.id}>
              {h.label}
              {h.note && <small>{h.note}</small>}
            </li>
          ))}
        </ol>
      </Fold>
    </TabPage>
  );
}
