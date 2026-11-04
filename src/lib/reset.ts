// ホームと台帳の「最初に戻す」：このブラウザに残した変化を1回で全部最初に戻す。
// 予約（仮押さえ・承認の箱・足した ToDo・保存したカルテ・「翌日へ」）は本当の今日を起点に作り直し、
// 広告（案・止めた／外した言葉）と経理（選んだ印・登録・足した自動のルール）は消す。
// 日誌・オーナーが変えたルール（ルールのタブ）・表示スイッチは残す。

import { ACCOUNTING_KEY, ADS_KEY, BOOK_KEY, writeBrowser } from "./browser";
import { emptyBook } from "./book/state";

/** 最初に戻すときに書く物（null は消す） */
export function resetAllWrites(today: string): { key: string; value: string | null }[] {
  return [
    { key: BOOK_KEY, value: JSON.stringify(emptyBook(today)) },
    { key: ADS_KEY, value: null },
    { key: ACCOUNTING_KEY, value: null },
  ];
}

/** 🔒 人が「最初に戻す」を押したときだけ呼ぶ */
export function resetAll(today: string): void {
  for (const w of resetAllWrites(today)) writeBrowser(w.key, w.value);
}
