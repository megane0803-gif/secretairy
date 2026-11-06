// 投げたメモのお客様の名字。AI に送る前に〔お客様〕に置きかえ（LINE の一言と同じ maskNames）、
// 返ってきた文の〔お客様〕を、メモに出てきた順に「○○様」へ戻す（だれかは画面のプログラムが名字で決める）。

import { CUSTOMER_MARK, maskNames } from "../line/sort";

export { maskNames };

const MARK = new RegExp(`${CUSTOMER_MARK.replace(/[[\]]/g, "\\$&")}(様|さま|さん)?`, "g");

/** 〔お客様〕をメモに出てきた順の名字に戻す（多ければ最後の方を使う。だれもいなければ「お客様」） */
export function restoreNames(title: string, memo: string, found: { surname: string }[]): string {
  const order = [...found].sort((a, b) => memo.indexOf(a.surname) - memo.indexOf(b.surname));
  let i = 0;
  return title.replace(MARK, () => {
    const c = order[Math.min(i, order.length - 1)];
    i += 1;
    return c ? `${c.surname}様` : "お客様";
  });
}
