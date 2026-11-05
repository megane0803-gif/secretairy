// 会議の決まった返事（AI なし）。テストで Claude の代わりに使う。AI につながらない時・「決まった返事（AI なし）」の時にも使う。
// 架空のデータにある事だけを言う：リサーチャーの数（予約が0件か・売り・町の名前）・前のオーナーの判断（対象・承認か見送りか・その時の予約）・言葉そのもの。
// 数字・日付は書かない（同じ言葉の門を通る）。決まった返事は Claude を呼ばないので、呼んだ回数に数えない。

import { actionVerb, type AdAction } from "../report";
import type { TeamWriteRequest, TeamWriteResult, TeamWriter } from "./run";
import { keepVerb } from "./research";
import type { PastDecision, Research } from "./types";

/** 言葉から「だれが調べているか」を言う（言葉にある物だけ。無ければ「この言葉で調べた方」） */
const WHO_MOD: [RegExp, string][] = [
  [/安い|格安|料金|値段/, "値段を比べている"],
  [/近く|近い/, "近くで探している"],
  [/口コミ|評判/, "口コミを見比べている"],
];
const WHO_NOUN: [RegExp, string][] = [
  [/学生/, "学生"],
  [/大人/, "大人の方"],
];

export function audienceOf(r: Pick<Research, "text" | "featured">): string {
  const mod = WHO_MOD.find(([re]) => re.test(r.text))?.[1];
  const noun = WHO_NOUN.find(([re]) => re.test(r.text))?.[1];
  if (mod || noun) return `${mod ?? ""}${noun ?? "方"}`;
  if (r.featured) return "売りのメニューを探している方";
  return "この言葉で調べた方";
}

/** 今の言葉と同じように「予約につながっていなかった／いた」前の判断（新しい方から） */
function likePast(r: Research, past: PastDecision[]): PastDecision | null {
  const none = r.total.bookings === 0;
  return past.find((d) => (d.bookings === 0) === none) ?? null;
}

function twin(r: Research, past: PastDecision[]): Record<string, unknown> {
  if (past.length === 0)
    // 過去の判断が0件：過去には触れず、店のルールと数だけで言う
    return r.total.bookings === 0
      ? { guess: "approve", text: "店のルールと数だけで見ると、予約につながっていない言葉です。" }
      : { guess: "skip", text: "店のルールと数だけで見ると、予約につながっている言葉です。" };
  const like = likePast(r, past);
  if (like && r.total.bookings === 0)
    return like.decision === "approved"
      ? { guess: "approve", text: "前も予約につながらない言葉から見直した。" }
      : { guess: "skip", text: "前は予約につながらない言葉でも残した。" };
  if (like)
    return like.decision === "approved"
      ? { guess: "approve", text: "前は予約のあった言葉でも見直した。" }
      : { guess: "skip", text: "前は予約のあった言葉の案を見送った。" };
  const last = past[0];
  return last.decision === "approved"
    ? { guess: "approve", text: "前は案を承認して見直した。" }
    : { guess: "skip", text: "前は案を見送って残した。" };
}

function riskOf(r: Research, action: AdAction): string {
  const who = audienceOf(r);
  return action === "exclude" ? `外すと、${who}にも届かなくなる。` : `止めると、${who}にも広告が出なくなる。`;
}

function opposition(r: Research): Record<string, unknown> {
  return { stance: "against", risk: riskOf(r, r.action), alternative: "今回は残して次の見直しで確かめたい。" };
}

/** 補佐：反対の理由があれば、先に確かめる方（野党）を採る。無ければ分身 */
function aide(r: Research, voices: NonNullable<TeamWriteRequest["voices"]>): Record<string, unknown> {
  if (voices.opposition) {
    const because = voices.opposition.risk.replace(/[。！？]+$/, "");
    return {
      adopt: "opposition",
      conclusion: `今回は${keepVerb(r.action)}考えです。`,
      reason: `${because}からです。`,
      next: "次の見直しで、この言葉の予約をもう一度見ます。",
    };
  }
  const t = voices.twin!;
  return {
    adopt: "twin",
    conclusion: t.guess === "approve" ? `分身の予想のとおり、${actionVerb(r.action)}考えです。` : `分身の予想のとおり、${keepVerb(r.action)}考えです。`,
    reason: t.text,
    next: "押す前に、リサーチャーの数をもう一度見てください。",
  };
}

export function scriptTeamWriter(): TeamWriter {
  return {
    claude: false,
    async write(req: TeamWriteRequest): Promise<TeamWriteResult> {
      const { research: r, past } = req.material;
      if (req.role === "twin") return { raw: twin(r, past), stop: "end" };
      if (req.role === "opposition") return { raw: opposition(r), stop: "end" };
      return { raw: aide(r, req.voices ?? { twin: null, opposition: null }), stop: "end" };
    },
  };
}
