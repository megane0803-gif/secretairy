// お客様の呼び方（「青木様」）と、前の書き方の読みかえ（プログラム。AI は使わない）。
// 前は名前ごとに「（架空）」の札を付けていた（「青木（架空）様」「予約サイト（架空）」「会計（架空）」など）。
// 今は付けない（架空であることは、入力欄の近くの注意の1行と README で伝える。docs/SPEC.md §3.3）。
// ブラウザに残った ToDo・日誌・承認BOXの理由・AI の仕事の済みの印は前の書き方のままなので、
// 読むときにここを通して今の書き方にそろえる（保存は消さない。照らし合わせも今の書き方の1つで済む）。

/** 前の書き方の札（名字のあとの「（架空）様」・「予約サイト（架空）」などの名前のあと） */
const OLD_MARK = /(予約サイト|検索広告|広告|会計|カード会社|様|スマホの画面|スマホ)（架空）|（架空）(?=様)/g;

/** 前の書き方の「（架空）」の札を外す（「青木（架空）様：傘」→「青木様：傘」） */
export function withoutOldMark(text: string): string {
  return text.replace(OLD_MARK, (_m, head: string | undefined) => head ?? "");
}

/** お客様の呼び方（「青木様」）。ToDo・日誌・お知らせ・AI への指示の名前はみなこれ（「○○様に別の日時を案内」は todo/reschedule.ts がこれを使う） */
export function guestName(surname: string): string {
  return `${surname}様`;
}

/** 「○○様：用件の1行」の頭（予約チャットの ToDo・カルテの次回提案の ToDo） */
export function guestTitleHead(surname: string): string {
  return `${guestName(surname)}：`;
}

/** 題が「○○様：用件」の形か（前の書き方「○○（架空）様：用件」も同じに読む。用件が空なら false） */
export function isGuestTitle(title: string, surname: string): boolean {
  const t = withoutOldMark(title);
  const head = guestTitleHead(surname);
  return t.startsWith(head) && t.length > head.length;
}
