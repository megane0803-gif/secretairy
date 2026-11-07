// 広告のテスト用アカウントを呼んだ時のうまくいかなかった訳（決まった短い理由だけ）。
// Google から返ってきたエラーの文・中身・元の例外は持たない（番号やメールが混ざるため）。ログにも出さない。

export type LiveErrorCode =
  | "not-test"
  | "token"
  | "auth"
  | "permission"
  | "quota"
  | "rejected"
  | "server"
  | "network"
  | "timeout"
  | "bad-answer";

export const LIVE_ERROR_MESSAGE: Record<LiveErrorCode, string> = {
  "not-test": "テスト用アカウントではないので送りませんでした",
  token: "鍵から通行証を作れませんでした（鍵を確かめてください）",
  auth: "通行証が受けられませんでした（鍵を確かめてください）",
  permission: "このアカウントを使う許可がありません（管理アカウントにサービスアカウントを足したか確かめてください）",
  quota: "広告の側の回数の上限です。しばらく待ってから押してください",
  rejected: "広告の側で受けられませんでした",
  server: "広告の側がいま答えられません。しばらく待ってから押してください",
  network: "広告の側につながりませんでした",
  timeout: "広告の側の答えが時間内に来ませんでした",
  "bad-answer": "広告の側の答えの形が違いました",
};

export class LiveError extends Error {
  /** before = 送る前（確かめの所）でうまくいかなかった。何も送っていないので「分からない」にしない */
  constructor(
    public readonly code: LiveErrorCode,
    public readonly before = false,
  ) {
    super(LIVE_ERROR_MESSAGE[code]);
    this.name = "LiveError";
  }
}

/** 送った後の答えが分からない訳（通信が切れた・時間切れ・広告の側が答えられない）。この時は「できなかった」と言わない */
export function unknownAfterSend(code: LiveErrorCode): boolean {
  return code === "network" || code === "timeout" || code === "server" || code === "bad-answer";
}
