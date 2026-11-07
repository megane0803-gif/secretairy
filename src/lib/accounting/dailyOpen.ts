// 「日報を入れる」のボタンから、経理の売上の欄の1枚（DailySheet。1つだけ）を開く所。
// ボタンは3つの場所にある：売上の欄の中（PC）・経理の見出しのすぐ下（スマホ。TabPage の beside）・ホームの「AI の仕事をまとめて動かす」の横。
// 1枚を持つのは売上の欄（SalesReport.tsx）だけで、ほかのボタンはここを通して頼むだけ（1枚を2つ作らない）。
// 画面に依らない形（テストは src/lib/accounting/__tests__/dailyOpen.test.ts）。どこにも送らない・AI は使わない。

/** ホームのボタンが行く先の印（経理のタブを開いたら、今日の1枚を開く） */
export const DAILY_OPEN_PARAM = "daily";
export const DAILY_OPEN_VALUE = "today";

/** ホームの「日報を入れる」の行く先 */
export const DAILY_OPEN_HREF = `/accounting?${DAILY_OPEN_PARAM}=${DAILY_OPEN_VALUE}`;

/** ページの search（"?daily=today" など）が「今日の1枚を開く」か */
export function wantsDailyOpen(search: string): boolean {
  return new URLSearchParams(search).get(DAILY_OPEN_PARAM) === DAILY_OPEN_VALUE;
}

/** 印を消した後の URL（開き直した時に、もう一度開かないように。ほかの印と #… は残す） */
export function withoutDailyOpen(pathname: string, search: string, hash: string): string {
  const q = new URLSearchParams(search);
  q.delete(DAILY_OPEN_PARAM);
  const rest = q.toString();
  return `${pathname}${rest ? `?${rest}` : ""}${hash}`;
}

const listeners = new Set<() => void>();

/** 同じページの売上の欄に「今日の1枚を開いて」と頼む（経理の見出しの下のボタン） */
export function requestDailySheet(): void {
  listeners.forEach((f) => f());
}

/** 売上の欄が頼みを受ける。返り値で外す */
export function onDailySheetRequest(f: () => void): () => void {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}
