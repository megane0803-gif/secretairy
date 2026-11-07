// 予約チャットの返事（/api/ai/reserve の1行ずつの JSON）を読む所。画面（ReserveChat.tsx）とテストが同じここを使う。
// - 終わりの印（{ t: "done" }）が来ないまま通信が終わった・最後の行が途中で切れている・読んでいる途中で通信が切れた → "cut"
//   （画面は「返事が途中で切れました。もう一度送ってください。」と出す。受け取った仮押さえがあれば、それも書く）
// - 止めた返事（お客様を切り替えた・最初に戻した）→ "stopped"（何も出さない）
// - 仮押さえは、返事を始めた時の台帳の印（epoch）と今の印が同じ時だけ入れる（あいだに「最初に戻す」があれば捨てる）。
//   メニューの設定の印（menuEdits.ts の menusMark）も同じ：あいだにメニューを直したら捨てる（sameMenus が false）。
//   同じお客様・同じメニュー・同じ日時の承認待ちがもうあれば入れない（送り直しで2つにしない。book/state.ts の sameHold）。

import type { BrowserWrite } from "../browser";
import { sameEpoch, sameHold, withHold, type BookState } from "../book/state";
import type { HoldOffer, ReserveEvent } from "./wire";

export type StreamEnd = "done" | "cut" | "stopped";

export const CUT_MESSAGE = "返事が途中で切れました。もう一度送ってください。";

/** 途中で切れた時の1文。held = この返事で受け取って入れた仮押さえの札（「11/7（土）15:00 カット」など） */
export function cutNotice(held: string[]): string {
  if (held.length === 0) return CUT_MESSAGE;
  return `${CUT_MESSAGE}（${held.join("・")}の仮押さえは、もう承認の箱に入っています。送り直しても、同じ仮押さえは2つになりません）`;
}

/**
 * 1行ずつ読んで onEvent に渡す。live() が false になったら（止めた返事）そこでやめる。
 * 形の崩れた行は読み飛ばす（ただし最後の行が崩れている＝途中で切れた、は "cut"）。
 */
export async function readReserveStream(body: ReadableStream<Uint8Array>, onEvent: (e: ReserveEvent) => void, live: () => boolean): Promise<StreamEnd> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let sawDone = false;
  const take = (lineText: string): boolean => {
    if (!lineText) return true;
    let e: ReserveEvent;
    try {
      e = JSON.parse(lineText) as ReserveEvent;
    } catch {
      return false;
    }
    if (e && typeof e === "object" && e.t === "done") sawDone = true;
    onEvent(e);
    return true;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (!live()) return "stopped";
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const lineText = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        take(lineText);
        if (!live()) return "stopped";
      }
    }
  } catch {
    return live() ? "cut" : "stopped";
  }
  buf += dec.decode();
  // 改行の無い最後の行：読めれば使い、読めなければ途中で切れている
  const rest = buf.trim();
  if (rest && !take(rest)) return "cut";
  return sawDone ? "done" : "cut";
}

/**
 * 受け取った仮押さえを台帳に入れる。入れたら true。
 * 入れないのは：返事を始めた後に「最初に戻す」があった（印が違う）・メニューを直した（sameMenus が false）・同じ仮押さえがもうある・書けなかった。
 */
export function holdInto(
  update: (f: (s: BookState) => BookState) => BrowserWrite | void,
  h: HoldOffer,
  epoch: string | undefined,
  sameMenus: () => boolean = () => true,
): boolean {
  let added = false;
  const w = update((s) => {
    if (!sameEpoch(s, epoch) || !sameMenus() || sameHold(s, h)) return s;
    const next = withHold(s, h);
    added = next !== s;
    return next;
  });
  return added && (!w || w.ok);
}
