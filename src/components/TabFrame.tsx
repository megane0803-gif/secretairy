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
  rightFirstOnPhone = false,
  top,
  children,
}: {
  tab: TabId;
  baseSwitches: TabSwitches;
  pending: ReactNode;
  right: ReactNode;
  /** スマホ（1列）で、右の列（そのタブの入力欄）を見出しのすぐ下・ページの上に出す */
  rightFirstOnPhone?: boolean;
  /**
   * PC で、承認待ち・見出しのすぐ下に横いっぱい（真ん中と右の列をまたいで）出す物（予約タブの時間割の台帳）。
   * 渡したときだけ、承認待ち・見出しと top を真ん中の上の帯（page-top）に出す。渡さないタブは今までどおり。
   */
  top?: ReactNode;
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

  const head = (
    <div className="page-head">
      <h1>
        <span aria-hidden>{def.icon}</span> {def.label}
      </h1>
    </div>
  );

  return (
    <div className={`${rightFirstOnPhone ? "page right-first-sp" : "page"}${top ? " has-top" : ""}`}>
      {top && (
        <header className="page-top">
          {pending}
          {head}
          {top}
        </header>
      )}
      <main className="page-main">
        {!top && pending}
        {!top && head}
        {children}
        {/* 表示スイッチは見出しの横に出さず、ページの終わりに畳んでおく（必須のタブは隠せないので出さない） */}
        {!def.required && (
          <details className="fold tab-switch-fold">
            <summary>このタブの表示</summary>
            <div>{toggle}</div>
          </details>
        )}
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
      <span className="switch-text">左のタブに「{label}」を出す</span>
    </label>
  );
}
