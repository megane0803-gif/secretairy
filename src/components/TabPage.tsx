import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { isTabVisible } from "@/lib/settings";
import { TABS, type TabId } from "@/lib/tabs";
import { PendingBar } from "./PendingBar";

/**
 * 1つのタブの画面。真ん中にページ、右の列に right を出す。
 * スマホでは上から「承認待ち → ページ → 右の列」の1列になる。
 */
export function TabPage({
  tab,
  right,
  children,
}: {
  tab: TabId;
  right: ReactNode;
  children: ReactNode;
}) {
  if (!isTabVisible(tab)) notFound();
  const def = TABS[tab];
  return (
    <div className="page">
      <main className="page-main">
        <PendingBar />
        <h1>
          <span aria-hidden>{def.icon}</span> {def.label}
        </h1>
        {children}
      </main>
      <aside className="page-right">{right}</aside>
    </div>
  );
}
