import { TabPage } from "@/components/TabPage";
import { Fold, Panel } from "@/components/parts";
import { getBookData } from "@/lib/book/data";
import { getCustomers, getKarteExamples } from "@/lib/data/seed";
import { getKarteEditSettings, getKarteHeadings, getMemoMaxChars, getRecordingAiSettings, getRecordingMemoMaxChars, getRecordingSettings } from "@/lib/settings";
import { KarteBoard } from "./KarteBoard";
import { KarteMemo } from "./KarteMemo";
import { RecordingPanel } from "./RecordingPanel";

export const dynamic = "force-dynamic";

export default function KartePage() {
  const data = getBookData();
  const headings = getKarteHeadings();
  const recAi = getRecordingAiSettings();
  return (
    <TabPage
      tab="karte"
      right={
        <>
          <Panel title="施術のメモ">
            <KarteMemo data={data} examples={getKarteExamples()} maxChars={getMemoMaxChars()} recordingMaxChars={getRecordingMemoMaxChars()} />
          </Panel>
          <RecordingPanel
            data={data}
            settings={getRecordingSettings()}
            maxTextChars={recAi.maxTextChars}
            minIntervalSeconds={recAi.minIntervalSeconds}
            memoMaxChars={getRecordingMemoMaxChars()}
            surnames={getCustomers().map((c) => c.surname)}
          />
        </>
      }
    >
      <KarteBoard data={data} headings={headings} editLimits={getKarteEditSettings()} />
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
      <Fold summary="くわしく（録音からメモを作る）">
        <p>
          右の列の「録音からメモを作る」（PC だけ）で、録音のファイル・画面の録音・録音フォルダから、施術のメモを作れます。
          声はこの PC のブラウザの外に出しません（Whisper をブラウザの中で動かして文字にします）。文字にした中身は、要点とカルテを作るために Claude に送ります（お客様の名字は〔お客様〕に置きかえて送ります）。
          録音は、お客様の了解を得てから行ってください。
        </p>
        <p>
          録音は{Math.round(getRecordingSettings().chunkSeconds / 60)}分くらいずつに区切って読み、黙っている所や音だけの所は飛ばします。区切りごとの要点にも言葉の門を通し、全部の要点をまとめて施術のメモに入れます（この時だけメモは{getRecordingMemoMaxChars().toLocaleString("ja-JP")}字まで）。カルテにする・保存は、今までどおり人が押します。
        </p>
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
