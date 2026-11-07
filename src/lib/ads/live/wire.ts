// 広告のテスト用アカウントの窓口（/api/ads/live/）と画面のあいだの形。ブラウザでも読むので、鍵・番号・メールは入れない。
// 送るの結果は、直しR の「受け取る結果」と同じ形（connect.ts の RESULT_FORMAT）を result に入れて返す。画面はそれを
// 直しR の結果の読み込み（readSyncResult → withSynced）と同じ道で読み、「本物に反映済み」の印を付ける（印の付け方を2つ作らない）。

import type { SyncKind, SyncStatus, SYNC_VERSION, RESULT_FORMAT } from "../connect";

export const LIVE_PATHS = {
  status: "/api/ads/live/status",
  setup: "/api/ads/live/setup",
  send: "/api/ads/live/send",
  read: "/api/ads/live/read",
  try: "/api/ads/live/try",
} as const;

export const NOT_CONNECTED_MESSAGE = "テスト用の広告アカウントにつないでいません";
export const BUSY_MESSAGE = "いま送っています。終わってからもう一度押してください";
/** だれでも試す窓口（try）で、ほかの人（オーナーの用意・送るも）が動かしている時 */
export const TRY_BUSY_MESSAGE = "ほかの人が試しています。少し待ってから、もう一度承認してください";
/** テスト用アカウントにまだ作品のキャンペーンが無い・2つある・用意の言葉が欠けている時（試す窓口は何も書かない） */
export const NOT_READY_MESSAGE = "まだ用意されていません（オーナーが用意します）";

/** 案ごとの結果：反映した／もう〜だった／できなかった（理由）／分からない（読み直してください） */
export type LiveOutcome = "done" | "already" | "failed" | "unknown";
export type LiveLine = { id: string; kind: SyncKind; text: string; outcome: LiveOutcome; reason?: string };

export type LiveResult = {
  format: typeof RESULT_FORMAT;
  version: typeof SYNC_VERSION;
  campaign: string;
  createdAt: string;
  results: { id: string; kind: SyncKind; text: string; status: SyncStatus; reason?: string }[];
};

export type LiveFail = { ok: false; code: string; message: string };

/** つながっているか（Google は呼ばない。環境変数がそろっている・プレビューではない、だけで決める） */
export type LiveStatusResponse = { ok: true; connected: boolean; canWrite: boolean };

/** created = 何か作った（もう用意してあって何も作らなかった時は false。日誌は作った時だけ） */
export type LiveSetupResponse = { ok: true; created: boolean; lines: string[] } | LiveFail;

export type LiveSendResponse = { ok: true; result: LiveResult; lines: LiveLine[] } | LiveFail;

export type LiveKeyword = { text: string; match: string; status: string; group: string };
export type LiveNegative = { text: string; match: string };
/** resetAt = 最後にだれかの試し（try）で「元の形」に戻した時刻（無ければ持たない）。これより前の「本物に反映済み」の印とは比べない */
export type LiveReadResponse =
  | { ok: true; campaign: { found: boolean; status: string }; keywords: LiveKeyword[]; negatives: LiveNegative[]; note?: string; resetAt?: string }
  | LiveFail;

/** だれでも試す窓口の1件（ブラウザから受け取るのは kind と no の2つだけ。言葉はサーバーが最初の表から引く） */
export type TryKind = SyncKind;
/** 試した1件の結果の行（反映した／もうその形だった／できなかった（理由）／分からない） */
export type LiveTryLine = { kind: TryKind; no: number; text: string; outcome: LiveOutcome; reason?: string };
/** 返事は、結果の行と読み直しの一覧だけ（読み直せなかった時は list が null） */
export type LiveTryResponse = { ok: true; line: LiveTryLine; list: Extract<LiveReadResponse, { ok: true }> | null } | LiveFail;
