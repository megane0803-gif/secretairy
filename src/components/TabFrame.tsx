"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { TabSwitches } from "@/lib/settings";
import { TABS, type TabId } from "@/lib/tabs";
import { useTabSwitches } from "@/lib/useTabSwitches";
import { Splitter } from "./Splitter";

export function TabFrame({
  tab,
  baseSwitches,
  pending,
  right,
  children,
}: {
  tab: TabId;
  baseSwitches: TabSwitches;
  pending: ReactNode;
  right: ReactNode;
  children: ReactNode;
}) {
  const def = TABS[tab];
  const { switches, setSwitch } = useTabSwitches(baseSwitches);
  const visible = def.required || switches[tab];

  const toggle = (
    <TabSwitch
      label={def.label}
      on={visible}
      locked={def.required}
      onChange={(v) => setSwitch(tab, v)}
    />
  );

  if (!visible) {
    return (
      <div className="page">
        <main className="page-main">
          <h1>このタブは出していません</h1>
          <p>
            「{def.label}」のタブは隠しています。出すときは下のスイッチを入れてください。
          </p>
          {toggle}
          <p>
            <Link href="/home">ホームへ戻る</Link>
          </p>
        </main>
      </div>
    );
  }

  return (
    <div className="page">
      <main className="page-main">
        {pending}
        <div className="page-head">
          <h1>
            <span aria-hidden>{def.icon}</span> {def.label}
          </h1>
          {toggle}
        </div>
        {children}
      </main>
      <Splitter />
      <aside className="page-right">{right}</aside>
    </div>
  );
}

/** 表示スイッチ。必須のタブは隠せないので押せない */
function TabSwitch({
  label,
  on,
  locked,
  onChange,
}: {
  label: string;
  on: boolean;
  locked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className={locked ? "switch locked" : "switch"} title={locked ? "必須のタブなので隠せません" : undefined}>
      <input
        type="checkbox"
        role="switch"
        checked={on}
        disabled={locked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={`「${label}」のタブを出す`}
      />
      <span className="switch-track" aria-hidden>
        <span className="switch-knob" />
      </span>
      <span className="switch-text">{locked ? "いつも出す（必須）" : on ? "出している" : "隠している"}</span>
    </label>
  );
}
