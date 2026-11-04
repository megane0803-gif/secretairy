import { TabPage } from "@/components/TabPage";
import { Fold, NotYet, Panel } from "@/components/parts";
import { getBookData } from "@/lib/book/data";
import { getKarteExamples } from "@/lib/data/seed";
import { getKarteHeadings, getMemoMaxChars } from "@/lib/settings";
import { KarteBoard } from "./KarteBoard";
import { KarteMemo } from "./KarteMemo";

export const dynamic = "force-dynamic";

export default function KartePage() {
  const data = getBookData();
  const headings = getKarteHeadings();
  return (
    <TabPage
      tab="karte"
      right={
        <Panel title="施術のメモ">
          <KarteMemo data={data} examples={getKarteExamples()} maxChars={getMemoMaxChars()} />
        </Panel>
      }
    >
      <KarteBoard data={data} headings={headings} />
      <NotYet>お客様の一覧（全員）と、カルテを「手で直す」はまだです</NotYet>
      <Fold summary="カルテの見出し（設定：config/karte.json）">
        <ol className="karte-headings">
          {headings.map((h) => (
            <li key={h.id}>
              {h.label}
              {h.note && <small>{h.note}</small>}
            </li>
          ))}
        </ol>
      </Fold>
      <Fold summary="くわしく（言葉の門）">
        <p>
          AI の下書きを1行ずつプログラムが見て、頭皮・肌・病・受診・薬・おすすめ・改善などの言葉や数字がメモに無ければ、その1行だけ載せません（日誌にも書きます）。
          メモにある言葉（例：「頭皮が赤かった」）は記録として残します。頭皮や肌の良し悪しの判断・助言はしません。
        </p>
      </Fold>
    </TabPage>
  );
}
