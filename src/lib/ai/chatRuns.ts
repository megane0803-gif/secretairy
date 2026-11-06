// 予約チャットの「いま流れている返事」を1つだけ持つ（画面の側。サーバーには何も残さない）。
// - お客様を切り替えたら、流れている返事を止める（前のお客様の返事・仮押さえ・ToDo を新しい会話に混ぜない）。
// - 返事が流れている間に送ろうとしたら、黙って捨てずに送れない理由を出す（sendBlocked）。
// - 「最初に戻す」を押したら、戻す前に始まった返事を止める（stopIfReset。台帳の印 epoch が変わったか）。
// 止めた返事の知らせ（文・仮押さえ・ToDo）は、isCurrent で弾いて使わない。

export type ChatRun = { id: number; customerId: string; signal: AbortSignal; epoch?: string };

export type ChatRuns = {
  /** 新しい返事を始める。前のが残っていれば止める。epoch = 始めた時の台帳の「最初に戻す」の印 */
  start(customerId: string, epoch?: string): ChatRun;
  /** 台帳の印が、流れている返事を始めた時と違えば（あいだに「最初に戻す」）止める。止めた物があれば、そのお客様の id */
  stopIfReset(epoch: string | undefined): string | null;
  /** 流れている返事を止める。止めた物があれば、そのお客様の id */
  stop(): string | null;
  /** その返事が、いま流れている物か（止めた・終わった物は false） */
  isCurrent(id: number): boolean;
  /** 返事が終わった（いま流れている物のときだけ外す） */
  finish(id: number): void;
  /** いま返事が流れているか */
  busy(): boolean;
};

export function createChatRuns(): ChatRuns {
  let seq = 0;
  let cur: { id: number; customerId: string; controller: AbortController; epoch?: string } | null = null;
  const stop = (): string | null => {
    if (!cur) return null;
    const was = cur;
    cur = null;
    was.controller.abort();
    return was.customerId;
  };
  return {
    start(customerId, epoch) {
      stop();
      seq += 1;
      const controller = new AbortController();
      cur = { id: seq, customerId, controller, epoch };
      return { id: seq, customerId, signal: controller.signal, epoch };
    },
    stop,
    stopIfReset(epoch) {
      if (!cur || (cur.epoch ?? "") === (epoch ?? "")) return null;
      return stop();
    },
    isCurrent: (id) => cur?.id === id,
    finish(id) {
      if (cur?.id === id) cur = null;
    },
    busy: () => cur !== null,
  };
}

export const BUSY_NOTICE = "前の返事を作っています。返事が終わってから送ってください（文は残してあります）。";
export const NO_CUSTOMER_NOTICE = "お客様を選んでから送ってください。";

/**
 * 送れないときの理由（1文）。送れるなら null。
 * 文が空のときは何もしない（送るボタンも押せない）ので "" を返す。
 */
export function sendBlocked(o: { text: string; busy: boolean; hasCustomer: boolean }): string | null {
  if (!o.text.trim()) return "";
  if (!o.hasCustomer) return NO_CUSTOMER_NOTICE;
  if (o.busy) return BUSY_NOTICE;
  return null;
}
