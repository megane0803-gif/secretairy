// 承認待ち（AI の仮押さえ・カルテ案など、人のボタン待ちの物）。
// 今は空。中身は予約チャットを作るときに足す。
// 承認待ちはサーバーに保存せず、見ている人のブラウザの中だけに残す（docs/SPEC.md §5.1）。

export type Approval = {
  id: string;
  kind: "reservation" | "karte" | "post" | "ad";
  title: string;
  before?: string;
  after: string;
  reason: string;
  createdAt: string;
};

export function getPendingApprovals(): Approval[] {
  return [];
}

export function getPendingCount(): number {
  return getPendingApprovals().length;
}
