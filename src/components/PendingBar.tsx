"use client";

import Link from "next/link";
import { pendingAd } from "@/lib/ads/state";
import { useAds } from "@/lib/ads/useAds";
import { pendingApprovals } from "@/lib/book/state";
import { useBookState } from "@/lib/book/useBook";

/** どのタブにも出す1行。押すとホーム（承認の箱）へ行く。数はこのブラウザの承認待ち */
export function PendingBar() {
  const { state } = useBookState();
  const ads = useAds();
  const n = pendingApprovals(state, new Date().toISOString()).length + (pendingAd(ads.state) ? 1 : 0);
  return (
    <Link href="/home#approvals" className={n > 0 ? "pending has" : "pending"}>
      <span>承認待ち</span>
      <strong className="num">{n}</strong>
      <span>件</span>
      <span className="pending-go" aria-hidden>
        →
      </span>
    </Link>
  );
}
