import { TabPage } from "@/components/TabPage";
import { addDays, calDay, openedDate } from "@/lib/calendar";
import { getBookData } from "@/lib/book/data";
import { getSeedRules } from "@/lib/rules/store";
import { getMenus, getRuleWordsMaxChars, getShop } from "@/lib/settings";
import { RuleBoard } from "./RuleBoard";
import { RuleSide } from "./RuleSide";

export const dynamic = "force-dynamic";

/**
 * ルールのタブ。最初の状態（鍵つき＋例のルール）をここで読み、
 * 足した・直した・消した分は画面の側（useRules）でこのブラウザの中だけに重ねる。
 */
export default function RulesPage() {
  const shop = getShop();
  const menus = getMenus();
  const seed = getSeedRules();
  // 「ためしに確かめる」で選べる日（開いた日から2週間。お休みの日も出して、断られるのを見られるように）
  const opened = openedDate(shop);
  const days = Array.from({ length: 14 }, (_, i) => calDay(shop, addDays(opened, i)));

  return (
    <TabPage
      tab="rules"
      right={
        <RuleSide
          seed={seed}
          menus={menus}
          shop={{ timezone: shop.timezone, slotMinutes: shop.slotMinutes }}
          days={days}
          data={getBookData()}
          // 言葉で書いて足す欄は、AI の鍵がある時だけ出す（鍵の中身は画面に渡さない）
          wordsOn={Boolean(process.env.ANTHROPIC_API_KEY)}
          wordsMaxChars={getRuleWordsMaxChars()}
        />
      }
    >
      <RuleBoard seed={seed} menus={menus.map((m) => ({ id: m.id, name: m.name }))} />
    </TabPage>
  );
}
