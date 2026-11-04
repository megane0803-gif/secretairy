import type { ReactNode } from "react";
import { getTabSwitches } from "@/lib/settings";
import type { TabId } from "@/lib/tabs";
import { PendingBar } from "./PendingBar";
import { TabFrame } from "./TabFrame";

/**
 * 1つのタブの画面。真ん中にページ、右の列に right を出す。
 * PC は「真ん中 | 境目（動かせる）| 右の列」、スマホは上から「承認待ち → ページ → 右の列」の1列。
 * 表示スイッチが切れているタブは「出していません」を出す。スイッチはページの終わりに畳む（必須のタブには出さない）。
 * rightFirstOnPhone のタブは、スマホで右の列を見出しのすぐ下に出す。
 */
export function TabPage({
  tab,
  right,
  rightFirstOnPhone,
  children,
}: {
  tab: TabId;
  right: ReactNode;
  /** スマホでは、右の列（そのタブの入力欄）をページの上に出す（予約チャットなど） */
  rightFirstOnPhone?: boolean;
  children: ReactNode;
}) {
  return (
    <TabFrame tab={tab} baseSwitches={getTabSwitches()} pending={<PendingBar />} right={right} rightFirstOnPhone={rightFirstOnPhone}>
      {children}
    </TabFrame>
  );
}
