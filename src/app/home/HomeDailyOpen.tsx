"use client";

// ホームの上の行：「AI の仕事をまとめて動かす」の横に、人が押す「日報を入れる」。
// 押すと経理のタブに移り、今日の日報の1枚が開いた状態になる（1枚は経理のタブの売上の欄の1つだけ。/accounting?daily=today。accounting/dailyOpen.ts）。
// AI は使わない・どこにも送らない。見た目は人のボタン（塗らないふつうのボタン＋「人」の札）で、AI の仕事のボタン（塗りのボタン）と分ける。

import Link from "next/link";
import type { ReactNode } from "react";
import { ActorTag } from "@/components/parts";
import { DAILY_OPEN_HREF } from "@/lib/accounting/dailyOpen";

export function HomeDailyOpen() {
  return (
    <div className="home-daily-open">
      <Link href={DAILY_OPEN_HREF} className="btn home-daily-btn">
        日報を入れる
      </Link>
      <ActorTag actor="human" note="オーナーがその日の売上を入れる。経理のタブで開きます" />
    </div>
  );
}

/** 承認待ちの1行の隣（TabPage の beside）：AI の仕事のボタンと「日報を入れる」を1つの行に（狭い時は折り返す） */
export function HomeTopActions({ children }: { children: ReactNode }) {
  return (
    <div className="home-top-actions">
      {children}
      <HomeDailyOpen />
    </div>
  );
}
