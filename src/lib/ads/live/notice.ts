// 広告の案を承認した時の知らせの1行（画面に依らない形。直しU・docs/SPEC.md §1.7.8）。
// 広告のタブの承認の行と、ホームの承認の箱の行（止める・外す・足す）が同じ文を出す。LINE のボタンの承認と戻す案は試さない。
// サービスの名前は書かない（画面に出すのは、つながっている時の札だけ）。「100%」「必ず」「すぐ反映」は書かない。

import type { LiveTried } from "./panel";
import type { TryKind } from "./wire";

/** 承認した1件。route = 試す窓口をどうしたか（まだ分からない時は持たない） */
export type Approved = {
  kind: TryKind;
  no: number;
  text: string;
  /** ToDo に「効いたか見る」を足した（止める・外す） */
  todo: boolean;
  /** started = 試すを始めた / off = つないでいない / unknown = つながっているか分からない / not-run = ほかの操作の途中で動かせなかった */
  route?: "started" | "off" | "unknown" | "not-run";
};

const PAST: Record<TryKind, string> = { stop: "を止めました", exclude: "を外しました", add: "を広告を出す言葉に足しました" };
const SEEN: Record<TryKind, string> = { stop: "止まった", exclude: "外れた", add: "足された" };
const STATE: Record<TryKind, string> = { stop: "止まっている", exclude: "外れている", add: "足されている" };

export const MONEY_NOTE = "広告は出ず、お金は動きません";
export const HOME_LIST_NOTE = "一覧は広告のタブで見られます。";

const bare = (s: string) => s.replace(/。$/, "");

/** 承認した時の知らせ（where = 広告のタブか、ホームの承認の箱か） */
export function approvedNotice(a: Approved, tried: LiveTried | null, where: "ads" | "home"): string {
  const head = `✓ ${a.no}番「${a.text}」${PAST[a.kind]}`;
  const todo = a.todo ? "ToDo に「効いたか見る」を足しました。" : "";
  const kept = `${a.no}番「${a.text}」：広告の管理画面には反映しました。`;
  if (a.route === "off") return `${head}（広告の管理画面に反映）。${todo}テスト用の広告アカウントにはつないでいないので、送っていません。`;
  if (a.route === "unknown")
    return `${head}（広告の管理画面に反映）。${todo}テスト用の広告アカウントにつながっているか分からなかったので、送っていません（ページを読み込み直してください）。`;
  if (a.route === "not-run") return `${kept}テスト用の広告アカウントへは、いまは送れませんでした（ほかの操作の途中でした）。${todo}`;
  const t = tried && tried.kind === a.kind && tried.no === a.no ? tried : null;
  const home = where === "home" ? HOME_LIST_NOTE : "";
  if (!t || t.state === "sending") return `${head}（広告の管理画面に反映）。${todo}テスト用の広告アカウントを元の形に戻してから、この1件を送っています…`;
  if (t.state === "done") return `${head}。テスト用の広告アカウントを元の形に戻してから送り、読み直して${SEEN[a.kind]}のを確かめました（${MONEY_NOTE}）。${todo}${home}`;
  if (t.state === "already")
    return `${head}。テスト用の広告アカウントは、もう元の形にこの1件だけの形だったので書かず、読み直して${STATE[a.kind]}のを確かめました（${MONEY_NOTE}）。${todo}${home}`;
  if (t.state === "unknown") return `${kept}テスト用の広告アカウントへ送れたか分かりません（「テスト用アカウントから読み直す」で確かめてください）。${todo}${home}`;
  return `${kept}テスト用の広告アカウントへは、いまは送れませんでした（${bare(t.reason ?? "理由は分かりません")}）。${todo}${home}`;
}
