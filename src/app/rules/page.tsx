import { TabPage } from "@/components/TabPage";
import { Fold, InputStub, Panel } from "@/components/parts";
import { getMenus } from "@/lib/settings";
import { getRules } from "@/lib/rules/store";
import type { Rule } from "@/lib/rules/types";
import { TABS } from "@/lib/tabs";

function scopeTag(r: Rule, menuName: (id: string) => string): string {
  if (r.level === "global") return "全体";
  if (r.level === "tab") return `タブ：${TABS[r.tab].label}`;
  return `メニュー：${menuName(r.menuId)}`;
}

const GROUPS: { level: Rule["level"]; title: string }[] = [
  { level: "global", title: "全体に効く" },
  { level: "tab", title: "タブごと" },
  { level: "menu", title: "メニューごと" },
];

export default function RulesPage() {
  const rules = getRules();
  const menus = getMenus();
  const menuName = (id: string) => menus.find((m) => m.id === id)?.name ?? id;
  return (
    <TabPage
      tab="rules"
      right={
        <Panel title="ルールを足す">
          <p>足したルールは、すぐ次の判定から効きます。</p>
          <InputStub placeholder="例：日曜は新しいお客様を受けない" button="足す" />
        </Panel>
      }
    >
      {GROUPS.map((g) => {
        const list = rules.filter((r) => r.level === g.level);
        return (
          <section key={g.level}>
            <h2>{g.title}</h2>
            <ul className="rules">
              {list.map((r) => (
                <li key={r.id} className={r.locked ? "rule locked" : "rule"}>
                  {r.locked && <span aria-label="鍵つき">🔒</span>}
                  <span>{r.label}</span>
                  <span className="tag">{scopeTag(r, menuName)}</span>
                  {r.check.kind === "text" ? (
                    <span className="tag text">AI が読む</span>
                  ) : (
                    <span className="tag check">✓ プログラムが確かめる</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <Fold summary="ぶつかったときは？">
        <p>同じことを決めるルールが2つあるときは、厳しい方を使います。</p>
        <p>🔒 の2つは、どんなルールを足しても緩みません。</p>
      </Fold>
    </TabPage>
  );
}
