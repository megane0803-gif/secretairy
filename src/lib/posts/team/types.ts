// 発信の下書きの「AI のチーム」の会議の形（docs/SPEC.md §1.10.1）。
// 下書きを、オーナーに出す前にチームが読む。直すかどうかは、オーナーが1つずつ選ぶ（AI は下書きを書きかえない）。
//   リサーチャー（プログラム）・分身（Claude）・野党（Claude）・補佐（Claude）の4つの声。
// 広告のチームと共有するのは、役の名前と短い説明（分身だけ「書きそう」）・見た目・Claude を呼ぶ薄い所まで。
// 指示・流れ・門・状態・窓口は発信用（このフォルダ）。

import { ROLE_DESC, ROLE_NAME, type TeamRole } from "../../ads/team/types";
import type { PostsMode } from "../wire";

export type PostTeamRole = TeamRole;

/** 役の名前（広告のチームと同じ） */
export const POST_ROLE_NAME: Record<PostTeamRole, string> = ROLE_NAME;

/** 役の短い説明（広告のチームの言い回し。分身だけ「書きそう」） */
export const POST_ROLE_DESC: Record<PostTeamRole, string> = { ...ROLE_DESC, twin: "「あなたならこう書きそう」を言う係" };

/** 1つの直し：下書きの1文まるごと（from）→ 直した1文（to） */
export type PostEdit = { from: string; to: string };

/** 分身の答え（門を通った直しだけ。0個なら「直したい所はありません」） */
export type TwinPostVoice = { edits: PostEdit[] };

/** 野党が見た読む人（お客様）の目の引っかかり */
export type PostConcern = "unclear" | "misleading" | "pushy";

export const CONCERN_LABEL: Record<PostConcern, string> = {
  unclear: "分かりにくい",
  misleading: "誤解されそう",
  pushy: "押しつけに聞こえる",
};

/**
 * 画面に出す「〜所」の言い方（カードの見出しと日誌の行。AI あり・なしで共通）。種類ごとにこの1か所で持つ。
 * CONCERN_LABEL は Claude への指示の言葉なので変えない（「誤解されそう」に「所」をそのまま付けると「な」が抜けるため、別に持つ）。
 */
export const CONCERN_HEADING: Record<PostConcern, string> = {
  unclear: "分かりにくい所",
  misleading: "誤解されそうな所",
  pushy: "押しつけに聞こえる所",
};

/** 野党の答え（門を通った物）：引っかかる所1つと、代わりの言い方1つ */
export type OppositionPostVoice = { concern: PostConcern; why: string; edit: PostEdit };

/** プログラムが確かめた候補（番号つき。補佐はこれだけを読む） */
export type PostCandidate = PostEdit & { no: number; source: "twin" | "opposition" };

/** 補佐が選んだ1つ（文は候補の文をそのまま使う。理由は門を通った時だけ） */
export type AidePick = PostCandidate & { reason?: string };

/** 補佐の答え（確かめ済みの候補から3つまで） */
export type AidePostVoice = { picks: AidePick[] };

/** 門で外した物（日誌に書く） */
export type PostTeamDropped = { role: Exclude<PostTeamRole, "researcher">; field: string; problems: string[] };

/** 会議の答え。分身・野党・補佐は、確かめられなかった時は null */
export type PostTeamResult = {
  /** 会議にかけた下書きの中身の印（hashText）。画面の印と同じ時だけ出す */
  hash: string;
  /** ai = Claude / script = 決まった返事（AI なし） */
  mode: PostsMode;
  /** AI につながらなかったので決まった返事にした */
  noAi: boolean;
  twin: TwinPostVoice | null;
  opposition: OppositionPostVoice | null;
  /** 確かめ済みの候補（分身の直し → 野党の直しの順に番号） */
  candidates: PostCandidate[];
  aide: AidePostVoice | null;
  dropped: PostTeamDropped[];
  /** Claude を呼んだ回数（決まった返事は 0） */
  calls: number;
};

/** オーナーが補佐の直しに押した物（blocked = 入れられなかった） */
export type PickChoice = "applied" | "skipped" | "blocked";

/** 下書き（画面の中だけ）に残す会議の印 */
export type PostTeamRecord = {
  /** 会議の番号 */
  meetingId: string;
  startedAt: string;
  mode: PostsMode;
  /** 会議を始めた時の下書きの中身 */
  snapshot: string;
  /** 会議を始めた時の直した版の番号 */
  version: number;
  result?: PostTeamResult;
  /** changed = 答えが戻った時に下書きが変わっていた（出さない）/ failed = 答えが戻らなかった */
  dropped?: "changed" | "failed";
  /** 答えを出した後の、チームが知っている今の下書き（「入れる」で変わる） */
  text?: string;
  /** 答えを出した後にオーナーが手で直した（残りの候補は使えない） */
  edited?: boolean;
  /** 補佐の直しごとの、オーナーの選んだ物（key = 候補の番号） */
  picks: Record<number, PickChoice>;
  /** 「補佐の直し：入れた…」を日誌に書いた */
  summarized?: boolean;
};

/** 長い下書きの時の言葉（切り捨てずに、呼ばない） */
export const TOO_LONG = "長すぎるのでチームにかけられません";
/** 手で直した後の、残りの候補の言葉 */
export const DRAFT_CHANGED = "下書きが変わったので入れられません";
