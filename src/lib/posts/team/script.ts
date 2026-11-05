// 発信のチームの決まった返事（AI なし）。テストで Claude の代わりに使う。AI につながらない時にも使う。
// 架空のデータ（下書き・お店のメモ・ルール）にある事だけを言う：下書きの文の言い回しを変えるだけで、事実（日時・メニュー・値段・効き目）は足さない。
// 決まった返事は Claude を呼ばないので、呼んだ回数に数えない。同じ確かめ（gate.ts）を通る。

import type { TeamJsonResult } from "../../ads/team/claude";
import type { PostTeamWriteRequest, PostTeamWriter } from "./run";
import type { PostCandidate } from "./types";

/** 分身：お店のメモの言い回し（「〜してもらっている」「お伝えしている」のような話し言葉）に寄せる言いかえ */
const TWIN_SUBS: [RegExp, string][] = [
  [/お知らせです([。！])$/, "お知らせします$1"],
  [/楽しみにしています([。！])$/, "楽しみに待っています$1"],
  [/させていただきます/, "します"],
  [/お待ちしております/, "お待ちしています"],
  [/しております/, "しています"],
  [/いただけます/, "もらえます"],
];

function twin(sentences: string[], max: number): Record<string, unknown> {
  const edits: { from: string; to: string }[] = [];
  for (const s of sentences) {
    if (edits.length >= max) break;
    const sub = TWIN_SUBS.find(([re]) => re.test(s));
    if (sub) edits.push({ from: s, to: s.replace(sub[0], sub[1]) });
  }
  return { edits };
}

/** 野党：読む人の目で引っかかる所（押しつけに聞こえる → 言い切っていない の順に探す） */
function opposition(sentences: string[]): Record<string, unknown> {
  const pushy = sentences.find((s) => /ください([。！])$/.test(s));
  if (pushy)
    return {
      stance: "against",
      concern: "pushy",
      why: "お願いの形で終わると、読む人には押しつけに聞こえるかもしれません。",
      from: pushy,
      to: pushy.replace(/ぜひ、?/, "").replace(/(て|で)?ください([。！])$/, (_m, te: string | undefined, end: string) => `${te ?? ""}いただけたらうれしいです${end}`),
    };
  // 名詞で終わる文（「…メニュー。」）は、何を伝えたいかが分かりにくい
  const unclear = sentences.find((s) => /[一-鿿゠-ヿー][。]$/.test(s));
  if (unclear)
    return {
      stance: "against",
      concern: "unclear",
      why: "言い切っていないので、読む人には何を伝えたいかが分かりにくいところです。",
      from: unclear,
      to: unclear.replace(/。$/, "です。"),
    };
  // 引っかかる所が見つからない時は、反対の意見を出せない（画面は「反対意見を確かめられませんでした」）
  return { stance: "agree", concern: "unclear", why: "", from: "", to: "" };
}

/** 補佐：読む人の目（野党）を先に、次に分身。同じ元の文は1つ・maxPicks まで */
function aide(candidates: PostCandidate[], max: number): Record<string, unknown> {
  const order = [...candidates.filter((c) => c.source === "opposition"), ...candidates.filter((c) => c.source === "twin")];
  const picks: { no: number; reason: string }[] = [];
  const used = new Set<string>();
  for (const c of order) {
    if (picks.length >= max || used.has(c.from)) continue;
    used.add(c.from);
    picks.push({ no: c.no, reason: c.source === "opposition" ? "読む人に伝わりやすくなるからです。" : "オーナーの言い方に近づくからです。" });
  }
  return { picks };
}

/** maxTwinEdits / maxPicks は会議の上限（config/ai.json の postsTeam）と同じ数を渡す */
export function scriptPostTeamWriter(limits: { maxTwinEdits: number; maxPicks: number }): PostTeamWriter {
  return {
    claude: false,
    async write(req: PostTeamWriteRequest): Promise<TeamJsonResult> {
      const { sentences } = req.material;
      if (req.role === "twin") return { raw: twin(sentences, limits.maxTwinEdits), stop: "end" };
      if (req.role === "opposition") return { raw: opposition(sentences), stop: "end" };
      return { raw: aide(req.candidates ?? [], limits.maxPicks), stop: "end" };
    },
  };
}
