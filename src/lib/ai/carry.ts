// 予約チャットで、次に送るときに前から引きつぐ物（直前に出した候補・この会話の仮押さえ）。
// 新しい会話（お客様を切りかえた・例文で別の方に切りかえた）のときだけ空にする。
// 「決まった返事で試す（AI なし）」で同じ会話をやり直すときは引きつぐ（仮押さえを外せるように）。

import type { Candidate } from "./wire";

export type Carried = { candidates: Candidate[]; holds: string[] };

export function carryOver(freshConversation: boolean, current: Carried): Carried {
  return freshConversation ? { candidates: [], holds: [] } : { candidates: current.candidates, holds: current.holds };
}
