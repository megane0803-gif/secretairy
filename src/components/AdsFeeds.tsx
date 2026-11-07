"use client";

// 広告の「効いたかの判定」（プログラム。AI は使わない。docs/SPEC.md §1.7.1）。
// 判定日（ToDo「効いたか見る」の期限。「翌日へ」で進めた日も入れる）が来た言葉を判定し、
// 広告タブのカード・日誌・ToDo（判定日の行を済みに）に出す。予約が減った時は「戻す案」を承認BOXに入れる（決めるのは人）。
// どのタブでも動く（何も描かない）。同じ言葉は2回判定しない。止めた・外した言葉そのものは変えない。

import { useEffect } from "react";
import { useAdResults } from "@/lib/ads/useResults";

export function AdsFeeds() {
  const { due, judgeDue } = useAdResults();
  const key = due.map((d) => d.applied.proposalId).join(",");

  useEffect(() => {
    if (key) judgeDue();
  }, [key, judgeDue]);

  return null;
}
