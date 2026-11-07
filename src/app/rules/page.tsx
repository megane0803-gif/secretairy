import { TabPage } from "@/components/TabPage";
import { addDays, calDay, openedDate } from "@/lib/calendar";
import { getBookData } from "@/lib/book/data";
import { getSeedRules } from "@/lib/rules/store";
import { getRuleWordsMaxChars, getShop } from "@/lib/settings";
import { RuleList, RuleLocked } from "./RuleBoard";
import { RuleSide } from "./RuleSide";

export const dynamic = "force-dynamic";

/**
 * ルールのタブ。最初の状態（鍵つき＋例のルール）をここで読み、
 * 足した・直した・消した分は画面の側（useRules）でこのブラウザの中だけに重ねる。
 * PC は「真ん中：数字・🔒 鍵つき・今あるルールの一覧｜右の列：ルールを足す欄」（今まで通り）。
 * スマホは上から 🔒 鍵つき → ルールを足す欄（右の列）→ 今あるルールの一覧（rightAfterOnPhone={1}。部品は1つずつのまま CSS の並べかえ）。
 */
export default function RulesPage() {
  const shop = getShop();
  const seed = getSeedRules();
  // メニューは画面の側で台帳の data.menus（足した・直したメニューも重ねた1つの入口）から読む
  const data = getBookData();
  // 「ためしに確かめる」で選べる日（開いた日から2週間。お休みの日も出して、断られるのを見られるように）
  const opened = openedDate(shop);
  const days = Array.from({ length: 14 }, (_, i) => calDay(shop, addDays(opened, i)));

  return (
    <TabPage
      tab="rules"
      rightAfterOnPhone={1}
      right={
        <RuleSide
          seed={seed}
          shop={{ timezone: shop.timezone, slotMinutes: shop.slotMinutes }}
          days={days}
          data={data}
          // 言葉で書いて足す欄は、AI の鍵がある時だけ出す（鍵の中身は画面に渡さない）
          wordsOn={Boolean(process.env.ANTHROPIC_API_KEY)}
          wordsMaxChars={getRuleWordsMaxChars()}
        />
      }
    >
      <RuleLocked seed={seed} data={data} />
      <RuleList seed={seed} data={data} />
    </TabPage>
  );
}
