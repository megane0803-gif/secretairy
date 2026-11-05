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
 * top を渡したタブは、PC で見出しのすぐ下に横いっぱい（真ん中と右の列をまたいで）top を出す。
 * beside を渡したタブ（ホーム）は、承認待ちの1行の隣に beside を出す（狭い時は折り返す）。
 */
export function TabPage({
  tab,
  right,
  rightFirstOnPhone,
  top,
  beside,
  children,
}: {
  tab: TabId;
  right: ReactNode;
  /** スマホでは、右の列（そのタブの入力欄）をページの上に出す（予約チャットなど） */
  rightFirstOnPhone?: boolean;
  /** PC で見出しのすぐ下に横いっぱいで出す物（予約タブの時間割）。スマホで出すかは中身の側で決める */
  top?: ReactNode;
  /** 承認待ちの1行の隣に出す物（ホームの「AI の仕事をまとめて動かす」）。渡さないタブは今までどおり */
  beside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <TabFrame tab={tab} baseSwitches={getTabSwitches()} pending={<PendingBar />} right={right} rightFirstOnPhone={rightFirstOnPhone} top={top} beside={beside}>
      {children}
    </TabFrame>
  );
}
