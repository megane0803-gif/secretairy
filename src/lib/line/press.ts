// LINE の「承認」「見送り」のボタン（press の知らせ）を、ブラウザに書くところまで。書くのは LineBridge.tsx がここを通す。
// 変え方は apply.ts の applyPress（承認の箱の画面のボタンと同じ）。ここは「書けたか」を見て、返事と日誌を決める。
//
// - 書けた時だけ、日誌に書き、LINE に確定の返事を返す（直しA の BrowserWrite。書けなければ SAVE_FAILED_MESSAGE と同じ考え方）。
// - 書けなかった時（例外も）は、確定にしない：台帳・広告は前のまま（承認待ちが残る）・日誌は書かない・LINE には「確定できませんでした」。
//   画面の承認の箱でもう一度押せば確定できる（LINE のボタンは1回だけなので、押しなおすのは画面）。
// - 「最初に戻す」の印（epoch）が、知らせを受け取り始めた時と違えば、何も書かない（古い仮押さえをよみがえらせない）。
// - 同じボタンが2回届いても、2回目はもう決まった行なので何も変えない（applyPress が decided を返す）。
//   書けた後に LINE への返事が失敗しても、ここをもう一度通さないので、確定は1回のまま。

import type { AdsState } from "../ads/state";
import type { BrowserWrite } from "../browser";
import { sameEpoch, type BookState } from "../book/state";
import type { JournalWho } from "../journal";
import { applyPress, type ApplyContext } from "./apply";
import type { ScreenEvent } from "./wire";

export type PressStore = {
  readBook(): BookState;
  writeBook(next: BookState): BrowserWrite;
  readAds(): AdsState;
  writeAds(next: AdsState): BrowserWrite;
};

export type PressCommit = {
  /** ブラウザに書いた（確定・見送りが入った） */
  written: boolean;
  /** 書こうとして書けなかった（例外も）。画面の「LINE の様子」に出す */
  failed: boolean;
  journal: { who: JournalWho; text: string }[];
  /** LINE に返す1行 */
  reply: string;
};

/** 書けなかった時の LINE への返事（承認待ちは残っているので、画面で押しなおせる） */
export const LINE_PRESS_FAILED = {
  approve: "確定できませんでした。画面を開いて、承認の箱でもう一度押してください。",
  skip: "見送れませんでした。画面を開いて、承認の箱でもう一度押してください。",
} as const;

/** 書けなかった時に、画面の「LINE の様子」に出す1文 */
export const LINE_PRESS_FAILED_STATUS = "LINE のボタンの分をブラウザに保存できませんでした。承認待ちはそのまま残しています。承認の箱で押しなおしてください。";

/** 受け取り始めた後に「最初に戻す」が押された時の LINE への返事 */
export const LINE_PRESS_RESET = "最初に戻したので、このボタンでは何も変えませんでした。今の様子は画面で確かめてください。";

/** 書けたか（例外は書けなかった扱い） */
function wrote(f: () => BrowserWrite): boolean {
  try {
    return f().ok;
  } catch {
    return false;
  }
}

/**
 * 🔒 合言葉でつないだ LINE のボタン（サーバーが署名・つなぎ・1回だけの印を確かめた press の知らせ）だけで呼ぶ。
 * startedEpoch = 知らせを受け取り始めた時の台帳の「最初に戻す」の印（book/store.ts の currentEpoch）。
 */
export function commitPress(
  ev: Extract<ScreenEvent, { kind: "press" }>,
  store: PressStore,
  ctx: ApplyContext,
  startedEpoch: string | undefined,
): PressCommit {
  const failed: PressCommit = { written: false, failed: true, journal: [], reply: LINE_PRESS_FAILED[ev.how === "approve" ? "approve" : "skip"] };
  let book: BookState;
  let ads: AdsState;
  try {
    book = store.readBook();
    ads = store.readAds();
  } catch {
    return failed;
  }
  if (!sameEpoch(book, startedEpoch)) return { written: false, failed: false, journal: [], reply: LINE_PRESS_RESET };

  let out: ReturnType<typeof applyPress>;
  try {
    out = applyPress(ev, book, ads, ctx);
  } catch {
    return failed;
  }
  const bookChanged = out.book !== book;
  const adsChanged = out.ads !== ads;
  // もう決まった行・休みの日などで確定しない時は、何も書かない（返事と日誌は applyPress のまま）
  if (!bookChanged && !adsChanged) return { written: false, failed: false, journal: out.journal, reply: out.reply };

  // 台帳（ToDo も）を先に書き、広告が書けなければ台帳を前に戻す（広告だけ確定・台帳だけ変わった、を残さない）
  if (bookChanged && !wrote(() => store.writeBook(out.book))) return failed;
  if (adsChanged && !wrote(() => store.writeAds(out.ads))) {
    if (bookChanged) wrote(() => store.writeBook(book));
    return failed;
  }
  return { written: true, failed: false, journal: out.journal, reply: out.reply };
}
