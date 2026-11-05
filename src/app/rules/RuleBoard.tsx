"use client";

// 真ん中：数字3つと 🔒 の2つ（RuleLocked。いちばん上。消す・直すボタンは出さない）と、3段のルール一覧（RuleList）。
// どのルールにも「どこに効くか」の札を出す。2つに分けてあるのは、スマホで間に右の列（ルールを足す欄）を出すため
// （TabPage の rightAfterOnPhone={1}。部品は1つずつのまま）。

import { useState } from "react";
import { BigNumber, Fold } from "@/components/parts";
import { DEMO_TAG_NOTE } from "@/lib/notices";
import { KIND_INFO, scopeTag } from "@/lib/rules/describe";
import type { ListedRule } from "@/lib/rules/overlay";
import type { Rule } from "@/lib/rules/types";
import { useRules } from "@/lib/rules/useRules";
import { RuleForm, type MenuOption } from "./RuleForm";

const GROUPS: { level: Rule["level"]; title: string }[] = [
  { level: "global", title: "全体に効く" },
  { level: "tab", title: "タブごと" },
  { level: "menu", title: "メニューごと" },
];

/** 数字3つと 🔒 いつも守ること（鍵つき） */
export function RuleLocked({ seed, menus }: { seed: Rule[]; menus: MenuOption[] }) {
  const { rules } = useRules(seed);
  const menuName = (id: string) => menus.find((m) => m.id === id)?.name ?? id;
  const locked = rules.filter((r) => r.locked);
  const own = rules.filter((r) => !r.locked);

  return (
    <>
      <div className="bignums">
        <BigNumber label="プログラムが確かめる" value={own.filter((r) => r.check.kind !== "text").length} unit="本" />
        <BigNumber label="AI が読む（文）" value={own.filter((r) => r.check.kind === "text").length} unit="本" />
        <BigNumber label="🔒 鍵つき" value={locked.length} unit="本" />
      </div>

      <section>
        <h2>🔒 いつも守ること</h2>
        <ul className="rules">
          {locked.map((r) => (
            <li key={r.id} className="rule locked">
              <div className="rule-main">
                <span aria-label="鍵つき">🔒</span>
                <span className="rule-label">{r.label}</span>
              </div>
              <div className="rule-tags">
                <span className="tag">{scopeTag(r, menuName)}</span>
                <span className="tag text">消せない・緩められない</span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

/** 今あるルールの一覧（全体・タブごと・メニューごとの3段）と、ぶつかった時・このブラウザの変更 */
export function RuleList({ seed, menus }: { seed: Rule[]; menus: MenuOption[] }) {
  const { rules, update, remove, restore, resetAll, changedCount } = useRules(seed);
  const menuName = (id: string) => menus.find((m) => m.id === id)?.name ?? id;
  const own = rules.filter((r) => !r.locked);

  return (
    <>
      {GROUPS.map((g) => {
        const list = own.filter((r) => r.level === g.level);
        return (
          <section key={g.level}>
            <h2>{g.title}</h2>
            {list.length === 0 ? (
              <p className="empty">まだありません</p>
            ) : (
              <ul className="rules">
                {list.map((r) => (
                  <RuleRow
                    key={r.id}
                    rule={r}
                    menus={menus}
                    menuName={menuName}
                    onSave={update}
                    onRemove={() => remove(r.id)}
                    onRestore={() => restore(r.id)}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}

      <Fold summary="ぶつかったときは？">
        <p>同じ種類のルールが2つ以上効くときは、厳しい方の1つを使います。全体かメニューか（段の上下）では決めません。</p>
        <p>例：全体「3時間前まで」と メニュー「縮毛矯正は24時間前まで」→ 縮毛矯正の予約では「24時間前まで」。</p>
        <p>文のルールはぜんぶ AI に渡します。🔒 の2つは、どんなルールを足しても緩みません。</p>
      </Fold>
      <Fold summary={`このブラウザに残している変更（${changedCount}件）`}>
        <p>足した・直した・消したルールは、このブラウザの中だけに残ります。ほかの人・ほかの端末には届きません。</p>
        <p className="rule-reset">
          {/* 「最初の状態に戻す」は試すための物なので「デモ」の札を付ける */}
          <span className="tag text" title={DEMO_TAG_NOTE}>
            デモ<span className="sr-only">（{DEMO_TAG_NOTE}）</span>
          </span>
          <button type="button" className="btn" disabled={changedCount === 0} onClick={resetAll}>
            最初の状態（例のルール）に戻す
          </button>
        </p>
      </Fold>
    </>
  );
}

function RuleRow({
  rule,
  menus,
  menuName,
  onSave,
  onRemove,
  onRestore,
}: {
  rule: ListedRule;
  menus: MenuOption[];
  menuName: (id: string) => string;
  onSave: (r: Rule) => void;
  onRemove: () => void;
  onRestore: () => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "remove">("view");
  const isText = rule.check.kind === "text";

  if (mode === "edit") {
    return (
      <li className="rule editing">
        <RuleForm
          menus={menus}
          initial={rule}
          submitLabel="直す"
          onSubmit={(r) => {
            onSave(r);
            setMode("view");
          }}
          onCancel={() => setMode("view")}
        />
      </li>
    );
  }

  return (
    <li className="rule">
      <div className="rule-main">
        <span className="rule-label">{rule.label}</span>
      </div>
      <div className="rule-tags">
        <span className="tag">{scopeTag(rule, menuName)}</span>
        {isText ? (
          <span className="tag text">AI が読む</span>
        ) : (
          <span className="tag check">✓ プログラムが確かめる：{KIND_INFO[rule.check.kind].name}</span>
        )}
        {rule.tellCustomer === true && <span className="tag tell">お客様に伝える</span>}
        {rule.origin === "added" && <span className="tag own">足した</span>}
        {rule.origin === "changed" && <span className="tag own">直した</span>}
      </div>
      {mode === "remove" ? (
        <div className="rule-buttons" role="group" aria-label="消すかどうか">
          <span>このルールを消しますか？</span>
          <button type="button" className="btn danger" onClick={onRemove}>
            消す
          </button>
          <button type="button" className="btn" onClick={() => setMode("view")}>
            やめる
          </button>
        </div>
      ) : (
        <div className="rule-buttons">
          <button type="button" className="btn small" onClick={() => setMode("edit")}>
            直す
          </button>
          <button type="button" className="btn small" onClick={() => setMode("remove")}>
            消す
          </button>
          {rule.origin === "changed" && (
            <button type="button" className="btn small" onClick={onRestore}>
              例に戻す
            </button>
          )}
        </div>
      )}
    </li>
  );
}
