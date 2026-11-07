"use client";

// 承認BOXの行と、その数。承認BOX・上の帯の「承認待ち」・朝の要点の「承認待ち」は、みなこれを使う。
// 同じブラウザの中身（予約・広告）と同じ「いま」（1分ごと）から、同じ関数（approvals.ts）で出す。

import { useMemo } from "react";
import { useAds } from "./ads/useAds";
import { approvalQueue } from "./approvals";
import { useBookState, useMinute } from "./book/useBook";

export function useApprovals() {
  const minute = useMinute();
  const { state } = useBookState();
  const ads = useAds();
  return useMemo(() => approvalQueue(state, ads.state, new Date(minute * 60_000).toISOString()), [state, ads.state, minute]);
}
