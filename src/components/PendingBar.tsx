import Link from "next/link";
import { getPendingCount } from "@/lib/approvals";

/** どのタブにも出す1行。押すとホーム（承認の箱）へ行く */
export function PendingBar() {
  const n = getPendingCount();
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
