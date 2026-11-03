import { TabPage } from "@/components/TabPage";
import { InputStub, NotYet, Panel } from "@/components/parts";
import { getKarteHeadings } from "@/lib/settings";

export default function KartePage() {
  const headings = getKarteHeadings();
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
      <h2>カルテの見出し</h2>
      <ol className="karte-headings">
        {headings.map((h) => (
          <li key={h.id}>
            {h.label}
            {h.note && <small>{h.note}</small>}
          </li>
        ))}
      </ol>
      <NotYet>お客様ごとのカルテがここに並びます</NotYet>
    </TabPage>
  );
}
