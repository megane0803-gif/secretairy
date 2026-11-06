"use client";

import Link from "next/link";
import { Children, type ReactNode } from "react";
import type { TabSwitches } from "@/lib/settings";
import { TABS, type TabId } from "@/lib/tabs";
import { useTabSwitches } from "@/lib/useTabSwitches";
import { LookPicker } from "./LookPicker";
import { Splitter } from "./Splitter";

export function TabFrame({
  tab,
  baseSwitches,
  pending: pendingBar,
  right,
  rightFirstOnPhone = false,
  rightAfterOnPhone,
  top,
  beside,
  children,
}: {
  tab: TabId;
  baseSwitches: TabSwitches;
  pending: ReactNode;
  /**
   * 承認待ちの1行の隣に置く物（ホームの「AI の仕事をまとめて動かす」）。承認待ちの1行はまるごとリンクなので、その外の隣に置く。
   * 渡したときだけ、承認待ちと beside を1つの行（pending-row。狭い時は折り返す）に入れる。渡さないタブは今までどおり。
   */
  beside?: ReactNode;
  right: ReactNode;
  /** スマホ（1列）で、右の列（そのタブの入力欄）を見出しのすぐ下・ページの上に出す */
  rightFirstOnPhone?: boolean;
  /**
   * スマホ（1列）で、右の列を真ん中の列の途中に出す：真ん中の列の children の何個目の欄の後に出すか（広告タブは 1＝4週分のすぐ下）。
   * 渡したときだけ、children を前（page-lead）と後（page-rest）の2つに包み、スマホでは CSS の並べ替えで「前 → 右の列 → 後」にする。
   * 右の列の部品は1つのまま（2つ作らない）。PC は今までどおり。渡さないタブは今までどおり。rightFirstOnPhone と一緒には使わない。
   */
  rightAfterOnPhone?: number;
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

  // beside を渡したタブだけ、承認待ちの1行と beside を1つの行に入れる
  const pending = beside ? (
    <div className="pending-row">
      {pendingBar}
      {beside}
    </div>
  ) : (
    pendingBar
  );

  // rightAfterOnPhone を渡したタブだけ、真ん中の欄を前と後に分けて包む（スマホで右の列をその間に出すため）
  const split = !rightFirstOnPhone && rightAfterOnPhone !== undefined;
  const items = split ? Children.toArray(children) : [];
  const body = split ? (
    <>
      <div className="page-lead">{items.slice(0, rightAfterOnPhone)}</div>
      <div className="page-rest">{items.slice(rightAfterOnPhone)}</div>
    </>
  ) : (
    children
  );

  const head = (
    <div className="page-head">
      <h1>
        <span aria-hidden>{def.icon}</span> {def.label}
      </h1>
    </div>
  );

  return (
    <div className={`${rightFirstOnPhone ? "page right-first-sp" : "page"}${split ? " right-after-sp" : ""}${top ? " has-top" : ""}`}>
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
        {body}
        {/* 表示スイッチは見出しの横に出さず、ページの終わりに畳んでおく（必須のタブは隠せないので出さない）。
            見た目の選び（§3.5）も同じ閉じた折りたたみの中。必須のタブは同じ場所に閉じた「見た目」を1つだけ置く（初めの画面に行を足さない） */}
        {!def.required && (
          <details className="fold tab-switch-fold">
            <summary>このタブの表示</summary>
            <div>{toggle}</div>
            <LookPicker withHead />
          </details>
        )}
        {def.required && (
          <details className="fold tab-switch-fold look-fold">
            <summary>見た目</summary>
            <LookPicker />
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
