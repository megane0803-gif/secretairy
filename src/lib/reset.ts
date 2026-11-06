// ホームと台帳の「最初に戻す」：このブラウザに残した変化を1回で全部最初に戻す。
// 予約（仮押さえ・承認の箱・足した ToDo・保存したカルテ・「翌日へ」・台帳で取り消した・変えた最初の予約 seedResEdits・予約サイトの番号 siteSeq）は本当の今日を起点に作り直し、
// 広告（案・止めた／外した言葉）と経理（選んだ印・登録・足した自動のルール・日報）は消す。
// カルテの施術メモ・案（LINE から入れたメモも。画面を開いている間だけの物）も消す。
// 発信（保存した下書き。画面を開いている間だけの材料・下書きも）も消す。
// LINE の預かり：届けた承認待ちの印を消し、画面は続けてサーバーの預かり物（/api/line/link の clear）も消す。つなぎそのものは残す。
// 録音からメモを作る：残した文字・要点・画面で録った区切り・読んだ印・録音フォルダも消す（動いている物は止める）。
// 経理の freee（テスト事業所）：画面の選びと画面の記録だけ戻す。freee の中の記録は残る（戻した後は、freee から読み直して照らし合わせてから登録する）。
// 「結果が分からない」の明細と、明細を入れるのを待つ期限は残す。freee の排他（Web Locks）の中で動かし、送っている間は戻さない（ResetBook）。
// ホームの「AI の仕事」の済みの印も消す（4行とも「これから」に戻る）。
// ルールのタブの「同じ時間に受ける人数」は店の設定の数（config/shop.json の seats）に戻す。
// 予約のページの「休みの日」（holidays.ts）と、予約サイトで止めた時間（book/siteStops.ts）も消す（最初の状態は無し）。
// 日誌・オーナーが変えたルール（ルールのタブ）・表示スイッチ（「AI の仕事」の表示スイッチも）は残す。

import { ACCOUNTING_KEY, ADS_KEY, BOOK_KEY, DAILY_KEY, FREEE_KEY, JOBS_KEY, LINE_KEY, POSTS_KEY, readBrowser, writeBrowser } from "./browser";
import { emptyBook, newEpoch } from "./book/state";
import { CAPACITY_KEY } from "./capacity";
import { HOLIDAYS_KEY } from "./holidays";
import { SITE_STOPS_KEY } from "./book/siteStops";
import { resetDesk } from "./karte/deskStore";
import { keptOnReset, parseFreee } from "./freee/state";
import { parseLine, withReset } from "./line/state";
import { resetRecordings } from "./recording/store";
import { resetPostsDesk } from "./posts/deskStore";

/**
 * 最初に戻すときに書く物（null は消す）。lineRaw = いまの LINE のつなぎ（無ければ書かない）。
 * freeeRaw = いまの freee（テスト事業所）の画面の記録：「結果が分からない」の明細と、明細を入れるのを待つ期限だけは残す
 * （送ったかどうか分からない物を、戻した後に送り直さないため）。
 */
export function resetAllWrites(today: string, lineRaw: string | null = null, freeeRaw: string | null = null, nowMs: number = Date.now()): { key: string; value: string | null }[] {
  const line = parseLine(lineRaw);
  const freeeKept = keptOnReset(parseFreee(freeeRaw), nowMs);
  return [
    // 戻すたびに印を変える（戻す前に始まった予約チャットの返事を、戻した後の台帳に入れない。book/state.ts の sameEpoch）
    { key: BOOK_KEY, value: JSON.stringify(emptyBook(today, newEpoch(nowMs))) },
    { key: ADS_KEY, value: null },
    { key: ACCOUNTING_KEY, value: null },
    // 経理の日報（オーナーが入れたその日の売上）。消すと売上の欄は最初から入っている10月に戻る
    { key: DAILY_KEY, value: null },
    // freee（テスト事業所）の画面の記録（明細ごとの状態・固定した選び）。freee の中の取引は消さない（消して戻すボタンは作らない）
    { key: FREEE_KEY, value: freeeKept ? JSON.stringify(freeeKept) : null },
    { key: POSTS_KEY, value: null },
    { key: JOBS_KEY, value: null },
    { key: CAPACITY_KEY, value: null },
    { key: HOLIDAYS_KEY, value: null },
    { key: SITE_STOPS_KEY, value: null },
    ...(line ? [{ key: LINE_KEY, value: JSON.stringify(withReset(line)) }] : []),
  ];
}

/**
 * 「最初に戻す」の結果。written = ブラウザに全部書けた（台帳を先に書くので、台帳が書けなければほかは書かない）。
 * failed = 書けなかった置き場所（無ければ空）。画面は written の時だけ「最初に戻した」の日誌と知らせを出す。
 */
export type ResetOutcome = { lineToken: string | null; written: boolean; failed: string[] };

/** 書けなかった時の1文 */
export const RESET_FAILED_MESSAGE = "ブラウザに保存できませんでした。最初に戻せなかった物があります。もう一度押してください。";

/**
 * 🔒 人が「最初に戻す」を押したときだけ呼ぶ。
 * 返す lineToken は、サーバーの LINE の預かり物を消すのに使う（つながっていなければ null）。
 * 台帳（予約・仮押さえ・「翌日へ」・印 epoch）を先に書き、書けなければ何も戻さない（画面の中だけの物も消さない）。
 */
export function resetAll(today: string): ResetOutcome {
  const line = parseLine(readBrowser(LINE_KEY));
  const writes = resetAllWrites(today, line ? JSON.stringify(line) : null, readBrowser(FREEE_KEY));
  const failed: string[] = [];
  for (const w of writes) {
    if (!writeBrowser(w.key, w.value).ok) failed.push(w.key);
    if (w.key === BOOK_KEY && failed.length) return { lineToken: null, written: false, failed };
  }
  resetDesk();
  resetPostsDesk();
  void resetRecordings();
  return { lineToken: line?.token ?? null, written: failed.length === 0, failed };
}
