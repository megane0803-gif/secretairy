import { TabPage } from "@/components/TabPage";
import { FieldList, Fold } from "@/components/parts";
import { CARD_GATE_LABELS } from "@/lib/accounting/sort";
import { CARD_FIELDS } from "@/lib/data/types";
import { CardStatement } from "./CardStatement";
import { DailyOpenTop } from "./DailyOpenTop";
import { JobStatement } from "./JobStatement";
import { RegisterColumn } from "./RegisterColumn";
import { SalesReport } from "./SalesReport";

/**
 * 経理のタブ。上に売上（最初から入っている10月に、オーナーが入れた日報を重ねる。どこにも送らない）、その下にカードと銀行の明細の仕分け
 * （つないでいない画面はアプリの中の架空の明細、freee（テスト事業所）とつないでいる時は freee から読んだ、まだ処理していない明細。入金は見せるだけ）。
 * AI の予想は使わない：購入先ごとの自動のルールでプログラムが分け、ルールの無い物だけ人が店用か私用を選ぶ。
 * 承認の箱は使わない。登録は右の列の人のボタンだけ（オーナーのブラウザで freee（テスト事業所）とつながっている時は、そちらに登録。§1.8.1）。
 * スマホでは右の列（登録の欄・freee の欄）をページの上に出す（予約チャットと同じ rightFirstOnPhone）。PC の右の列の場所は今まで通り。
 * スマホでは見出し「経理」のすぐ下（登録の欄より上）に「日報を入れる」（beside。PC の幅では出さず、売上の欄の中のボタンのまま）。
 */
export default function AccountingPage() {
  return (
    <TabPage tab="accounting" right={<RegisterColumn />} beside={<DailyOpenTop />} rightFirstOnPhone>
      <SalesReport />
      <JobStatement />
      <CardStatement />
      <Fold summary="くわしく（プログラムの確認と、明細の形）">
        <p>登録の前に、プログラムが2つ確かめます。どちらも ✓ になるまで登録のボタンは押せません。</p>
        <ul>
          <li>✓ {CARD_GATE_LABELS.allChosen}</li>
          <li>✓ {CARD_GATE_LABELS.autoAligned}（同じ購入先で店用と私用に分かれているのに「次から自動」に印があれば止めます）</li>
        </ul>
        <p>AI は使いません。承認の箱にも入れません（ホームの「承認待ち」にも数えません）。</p>
        <FieldList fields={CARD_FIELDS} />
      </Fold>
    </TabPage>
  );
}
