import type { ReactNode } from "react";
import { getTabSwitches } from "@/lib/settings";
import type { TabId } from "@/lib/tabs";
import { PendingBar } from "./PendingBar";
import { TabFrame } from "./TabFrame";

/**
 * 1つのタブの画面。真ん中にページ、右の列に right を出す。
 * PC は「真ん中 | 境目（動かせる）| 右の列」、スマホは上から「承認待ち → ページ → 右の列」の1列。
 * 表示スイッチが切れているタブは「出していません」を出す。
 */
export function TabPage({ tab, right, children }: { tab: TabId; right: ReactNode; children: ReactNode }) {
  return (
    <TabFrame tab={tab} baseSwitches={getTabSwitches()} pending={<PendingBar />} right={right}>
      {children}
    </TabFrame>
  );
}
