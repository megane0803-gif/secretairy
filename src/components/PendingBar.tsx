"use client";

import Link from "next/link";
import { useApprovals } from "@/lib/useApprovals";

/** どのタブにも出す1行。押すとホーム（承認の箱）へ行く。数は承認の箱の行の数（approvals.ts） */
export function PendingBar() {
  const n = useApprovals().count;
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
