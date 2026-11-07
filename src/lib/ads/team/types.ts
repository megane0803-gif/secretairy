// 広告の案の「AI のチーム」の会議の形（docs/SPEC.md §1.7.4）。
// SecretAIry はオーナーの側近。案をチームで話し合ってからオーナーに出す。決めるのは、いつもオーナーのボタンだけ。
//   リサーチャー（プログラム）・分身（Claude）・野党（Claude）・補佐（Claude）の4つの声。
// 🔒 会議には確定・承認の道具を渡さない。会議の答えは、承認BOXの行に「読む物」として添えるだけ。

import type { AdWeek } from "../../data/types";
import type { AdAction } from "../report";
import type { AdVerdict } from "../results";
import type { AdsMode } from "../wire";

export type TeamRole = "researcher" | "twin" | "opposition" | "aide";

/** 役の名前と短い説明（画面と日誌で使う） */
export const ROLE_NAME: Record<TeamRole, string> = {
  researcher: "リサーチャー",
  twin: "分身",
  opposition: "野党",
  aide: "補佐",
};

export const ROLE_DESC: Record<TeamRole, string> = {
  researcher: "店のデータを並べる係（プログラム）",
  twin: "「あなたならこう決めそう」を言う係",
  opposition: "反対の意見を出す係",
  aide: "2つの意見を聞いてまとめる側近",
};

/** 会議を始めた時の案の中身（「会議済み」の印。答えが戻った時に同じかを比べる） */
export type TeamSnapshot = { action: AdAction; no: number; text: string; reason: string };

/** 前のオーナーの判断1つ（対象・止める／外す・承認か見送りか・決めた日。理由は持たない） */
export type PastDecision = {
  text: string;
  action: AdAction;
  decision: "approved" | "skipped";
  /** 決めた日（YYYY-MM-DD） */
  date: string;
  /** その時の4週の予約の数（プログラムが表から入れた数） */
  bookings: number;
};

/** 前の判定（効いたかの判定。verdict.ts） */
export type PastJudgement = { no: number; text: string; action: AdAction; verdict: AdVerdict };

/** リサーチャー（プログラム）が店のデータから並べた物。数はここにだけ入る */
export type Research = {
  no: number;
  text: string;
  action: AdAction;
  kind: "keyword" | "term";
  featured: boolean;
  town: string | null;
  /** 古い順に4週分 */
  weeks: AdWeek[];
  total: AdWeek;
  /** この言葉の前の判定 */
  judgements: PastJudgement[];
  /** ほかの言葉の前の判定（新しい方から） */
  otherJudgements: PastJudgement[];
};

/** 分身の答え（言葉の門を通った物）。guess = 私なら（承認／見送り） */
export type TwinVoice = { guess: "approve" | "skip"; text: string; noHistory: boolean };

/** 野党の答え（言葉の門を通った物） */
export type OppositionVoice = { risk: string; alternative: string };

/** 補佐の答え（言葉の門を通った行だけ）。adopt = どちらの理由を採ったか */
export type AideVoice = { adopt: "twin" | "opposition"; conclusion?: string; reason?: string; next?: string };

/** 門で外した物（日誌に書く） */
export type TeamDropped = { role: Exclude<TeamRole, "researcher">; field: string; problems: string[] };

/** 会議の答え。分身・野党・補佐は、確かめられなかった時は null */
export type TeamResult = {
  snapshot: TeamSnapshot;
  /** ai = Claude / script = 決まった返事（AI なし） */
  mode: AdsMode;
  /** AI につながらなかったので決まった返事にした */
  noAi: boolean;
  twin: TwinVoice | null;
  opposition: OppositionVoice | null;
  aide: AideVoice | null;
  dropped: TeamDropped[];
  /** Claude を呼んだ回数（決まった返事は 0） */
  calls: number;
};

/** 承認BOXの行（広告の案）に残す会議の印 */
export type TeamRecord = {
  snapshot: TeamSnapshot;
  startedAt: string;
  mode: AdsMode;
  result?: TeamResult;
  /** changed = 答えが戻った時に案が変わっていた（出さない）/ failed = 答えが戻らなかった */
  dropped?: "changed" | "failed";
};
