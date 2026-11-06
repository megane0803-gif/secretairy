"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { NAV_KEY, readBrowser, subscribeBrowser, writeBrowser } from "@/lib/browser";
import { scrollLeftToShow } from "@/lib/scroll";
import { isTabShown, type TabSwitches } from "@/lib/settings";
import { TAB_IDS, TABS } from "@/lib/tabs";
import { useTabSwitches } from "@/lib/useTabSwitches";

const readCollapsed = () => readBrowser(NAV_KEY) === "1";

export function TabNav({ baseSwitches, shopName }: { baseSwitches: TabSwitches; shopName: string }) {
  const pathname = usePathname();
  const { switches } = useTabSwitches(baseSwitches);
  const collapsed = useSyncExternalStore(subscribeBrowser, readCollapsed, () => false);
  const shown = TAB_IDS.filter((id) => isTabShown(id, switches)).map((id) => TABS[id]);
  const hidden = TAB_IDS.filter((id) => !isTabShown(id, switches)).map((id) => TABS[id]);

  // スマホのタブの帯（横に動かす帯）では、開いているタブが帯の外に隠れないように、見える位置まで帯を動かす。
  // PC（縦に並ぶ）は帯がはみ出さないので動かさない。ページは縦に動かさない（帯の scrollLeft だけ）。
  const listRef = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const ul = listRef.current;
    const a = ul?.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!ul || !a || ul.scrollWidth <= ul.clientWidth) return;
    const box = ul.getBoundingClientRect();
    const item = a.getBoundingClientRect();
    ul.scrollLeft = scrollLeftToShow(
      { width: ul.clientWidth, scrollLeft: ul.scrollLeft, scrollWidth: ul.scrollWidth },
      { left: item.left - box.left, width: item.width },
    );
  }, [pathname, shown.length]);

  const toggle = () => {
    const next = !collapsed;
    writeBrowser(NAV_KEY, next ? "1" : null);
    document.documentElement.dataset.nav = next ? "collapsed" : "open";
  };

  return (
    <nav className="tabnav" aria-label="タブ">
      <div className="tabnav-head">
        <div className="tabnav-brand">
          <strong>SecretAIry</strong>
          <span>{shopName}</span>
        </div>
        <button
          type="button"
          className="tabnav-fold"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "タブを開く" : "タブを畳む"}
          title={collapsed ? "タブを開く" : "タブを畳む"}
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>
      <ul ref={listRef}>
        {shown.map((t) => {
          const active = pathname === t.path || pathname.startsWith(t.path + "/");
          return (
            <li key={t.id}>
              <Link href={t.path} aria-current={active ? "page" : undefined} title={t.label}>
                <span aria-hidden className="tabnav-icon">
                  {t.icon}
                </span>
                <span className="tabnav-label">{t.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      {hidden.length > 0 && (
        <details className="tabnav-hidden">
          <summary>
            隠しているタブ <span className="num">{hidden.length}</span>
          </summary>
          <ul>
            {hidden.map((t) => (
              <li key={t.id}>
                <Link href={t.path}>
                  <span aria-hidden>{t.icon}</span> {t.label}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </nav>
  );
}
