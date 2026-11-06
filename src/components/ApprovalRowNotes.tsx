// 承認の箱の予約の行に足す1行ずつ（外れるまでの残り・同じ日のほかの予約）。中身は src/lib/approvals.ts の approvalRowNotes の1か所で決め、
// ここは種類ごとの見た目だけ。行に足す物を増やす時も、ここと approvals.ts だけを触る。

import type { ApprovalRowNote } from "@/lib/approvals";

const CLASS: Record<ApprovalRowNote["kind"], string> = {
  left: "approval-left",
  sameDay: "approval-same",
};

export function ApprovalRowNotes({ notes }: { notes: ApprovalRowNote[] }) {
  return (
    <>
      {notes.map((n) => (
        <p key={n.kind} className={n.strong ? `${CLASS[n.kind]} soon` : CLASS[n.kind]}>
          {n.text}
        </p>
      ))}
    </>
  );
}
