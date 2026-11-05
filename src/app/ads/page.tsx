import { AdApprovalRows } from "@/components/AdApprovalRows";
import { TabPage } from "@/components/TabPage";
import { FieldList, Fold, Panel } from "@/components/parts";
import { GATE_LABELS } from "@/lib/ads/gate";
import { AD_FIELDS } from "@/lib/data/types";
import { getSeedRules } from "@/lib/rules/store";
import { getAdSettings, getShop } from "@/lib/settings";
import { AdsReport } from "./AdsReport";
import { AdsResults } from "./AdsResults";
import { AdsReview } from "./AdsReview";

export const dynamic = "force-dynamic";

/**
 * 広告のタブ。架空の広告の4週分を見て、AI が「止める言葉」か「外す言葉」を1つ提案し、
 * プログラムの門を通してから承認の箱へ。決めるのはオーナー（承認／直す／見送り）。
 */
export default function AdsPage() {
  const seedRules = getSeedRules();
  const ads = getAdSettings();
  const shop = getShop();
  return (
    <TabPage
      tab="ads"
      right={
        <Panel title="AI に見直してもらう">
          <AdsReview seedRules={seedRules} timezone={shop.timezone} />
        </Panel>
      }
    >
      <section className="inline-box" aria-labelledby="ads-approvals">
        <h2 id="ads-approvals">承認待ち（ホームの承認の箱と同じ行）</h2>
        <AdApprovalRows seedRules={seedRules} standalone />
      </section>

      <AdsResults />

      <AdsReport />

      <Fold summary="くわしく（プログラムの確認と、広告の数の形）">
        <p>AI の案は、承認の箱に入れる前にプログラムが3つ確かめます。弾いたら理由を渡して1回だけ作り直させ、それでもだめなら案は出さずに日誌に書きます。</p>
        <ul>
          <li>✓ {GATE_LABELS.exists}（止める＝広告を出す言葉・外す＝調べた言葉。もう止めた物は選ばない）</li>
          <li>✓ {GATE_LABELS.noAdd}（道具は「止める」「外す」の2つだけ。言葉を足す道具はありません）</li>
          <li>✓ {GATE_LABELS.town}（{ads.towns.join("・")}）</li>
        </ul>
        <p>
          案は{ads.oncePerDays}日に1つまで。承認すると、{ads.checkAfterDays}日後を期限に ToDo「効いたか見る」を足します。数（回数・お金・予約）は AI に書かせず、表からプログラムが入れます。
        </p>
        <p>
          効いたかの判定は、判定日（承認の{ads.checkAfterDays}日後）に前と後の数をプログラムが比べます。その言葉の押された回数が{ads.judge.minWordClicks}回より少ない時・前と後の予約を足して{ads.judge.minBookings}件より少ない時は「まだ分からない」。後の数は最初の状態に置いた架空の数です。
          戻す案は承認の箱に入り、戻すのはオーナーの「承認」だけです。
        </p>
        <FieldList fields={AD_FIELDS} />
      </Fold>
    </TabPage>
  );
}
