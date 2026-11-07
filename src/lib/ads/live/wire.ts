// 広告のテスト用アカウントの窓口（/api/ads/live/）と画面のあいだの形。ブラウザでも読むので、鍵・番号・メールは入れない。
// 送るの結果は、直しR の「受け取る結果」と同じ形（connect.ts の RESULT_FORMAT）を result に入れて返す。画面はそれを
// 直しR の結果の読み込み（readSyncResult → withSynced）と同じ道で読み、「本物に反映済み」の印を付ける（印の付け方を2つ作らない）。

import type { SyncKind, SyncStatus, SYNC_VERSION, RESULT_FORMAT } from "../connect";

export const LIVE_PATHS = {
  status: "/api/ads/live/status",
  setup: "/api/ads/live/setup",
  send: "/api/ads/live/send",
  read: "/api/ads/live/read",
} as const;

export const NOT_CONNECTED_MESSAGE = "テスト用の広告アカウントにつないでいません";
export const BUSY_MESSAGE = "いま送っています。終わってからもう一度押してください";

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
export type LiveReadResponse =
  | { ok: true; campaign: { found: boolean; status: string }; keywords: LiveKeyword[]; negatives: LiveNegative[]; note?: string }
  | LiveFail;
