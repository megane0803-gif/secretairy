// オーナーが足す・直すルールを確かめる所。
// 形がおかしい物・鍵つきの2つ（locked.ts）を緩める中身の物は受け付けず、理由を1文で返す。
// ブラウザに残っていた物を読むときも、ここを通して同じように確かめる（手で書きかえられても緩まない）。

import { TAB_IDS, type TabId } from "../tabs";
import type { Rule } from "./types";

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

/** 数の範囲。画面の入力欄も同じ範囲にする */
export const LIMITS = {
  minLeadMinutes: { min: 1, max: 60 * 24 * 60 }, // 60日前まで
  maxNewCustomersPerDay: { min: 0, max: 99 },
  bufferAfterMinutes: { min: 1, max: 240 },
  textLength: 200,
} as const;

/** 型のルール（プログラムが確かめる）は予約の判定で使うので、タブは「予約」だけ */
export const PROGRAM_TABS: TabId[] = ["reservations"];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---- 鍵つきの2つを緩める中身か ----
// 全角の英数字は半角に、空白は詰めてから見る

function normalize(s: string): string {
  return s
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, "")
    .toLowerCase();
}

// 🔒 確定は人
const CONFIRM = /(確定|確約|本予約|コンファーム|confirm)/;
const NOT_HUMAN = /(ai|エーアイ|自動|ボット|bot|チャット|line|ライン|任せ|まかせ|勝手|代わり|かわり)/;
const NO_HUMAN = /(人|オーナー|スタッフ|承認|ボタン).{0,6}(いらない|要らない|不要|なし|無し|なくて|無くて|しない|省く|はぶく|飛ばす|とばす)/;

// 🔒 健康や医療の判断はしない
const HEALTH =
  /(健康|医療|病気|持病|頭皮|皮膚|肌|アレルギー|かぶれ|炎症|湿疹|傷|妊娠|妊婦|授乳|薬|服薬|治療|通院|手術|パッチテスト|体調|症状|アトピー|喘息|ぜんそく)/;
const JUDGE =
  /(大丈夫|だいじょうぶ|問題な|心配な|平気|安全|危な|やめた(方|ほう)|やめて(おく|ください)|控え|ひかえ|施術(して|でき)|できます|できません|受けて(いい|よい|も)|いい(です|よ)|勧め|すすめ|お断り|断る|判断|診断|見立て)/;

// 🔒 の2つそのものを外す・無視する
const LOOSEN_LOCKED = /(鍵|🔒|ロック).{0,8}(無視|守らな|外す|はずす|消す|緩め|ゆるめ|なくす|無効)/;

/** 鍵つきの2つを緩める中身なら、受け付けない理由を1文で返す。問題なければ null */
export function lockedConflict(text: string): string | null {
  const t = normalize(text);
  if (LOOSEN_LOCKED.test(t)) return "🔒 の2つは外したり緩めたりできません。";
  if (CONFIRM.test(t) && (NOT_HUMAN.test(t) || NO_HUMAN.test(t)))
    return "🔒「確定は人」とぶつかります。確定は、人がボタンを押したときだけです。";
  if (NO_HUMAN.test(t) && /(予約|仮押さえ|承認)/.test(t))
    return "🔒「確定は人」とぶつかります。確定は、人がボタンを押したときだけです。";
  if (HEALTH.test(t) && JUDGE.test(t))
    return "🔒「健康や医療の判断はしない」とぶつかります。AI はお客様の言葉をそのまま人につなぎます。";
  return null;
}

// ---- 形を確かめる ----

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

function inRange(n: unknown, lim: { min: number; max: number }): n is number {
  return isInt(n) && n >= lim.min && n <= lim.max;
}

/**
 * オーナーのルールとして受け付けてよいか。受け付けるときは、余計な物を落とした形を返す。
 * menuIds を渡すと、メニューがあるかも確かめる。
 */
export function validateOwnerRule(raw: unknown, menuIds?: string[]): Checked<Rule> {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "ルールの形になっていません。" };
  const r = raw as Record<string, unknown>;
  if (r.locked) return { ok: false, reason: "🔒 のルールは足したり直したりできません。" };
  if (typeof r.id !== "string" || !r.id || r.id.startsWith("locked-"))
    return { ok: false, reason: "ルールの印（id）がおかしいです。" };
  const check = r.check as Record<string, unknown> | undefined;
  if (!check || typeof check !== "object") return { ok: false, reason: "ルールの種類がありません。" };

  // どこに効くか
  let scope: Pick<Rule, "level"> & Record<string, unknown>;
  if (r.level === "global") scope = { level: "global" };
  else if (r.level === "tab") {
    if (!TAB_IDS.includes(r.tab as TabId)) return { ok: false, reason: "どのタブに効くかを選んでください。" };
    if (check.kind !== "text" && !PROGRAM_TABS.includes(r.tab as TabId))
      return { ok: false, reason: "この種類のルールは、全体・予約のタブ・メニューのどれかに付けてください。" };
    scope = { level: "tab", tab: r.tab };
  } else if (r.level === "menu") {
    if (typeof r.menuId !== "string" || !r.menuId) return { ok: false, reason: "どのメニューに効くかを選んでください。" };
    if (menuIds && !menuIds.includes(r.menuId)) return { ok: false, reason: "そのメニューは見つかりません。" };
    scope = { level: "menu", menuId: r.menuId };
  } else return { ok: false, reason: "どこに効くかを選んでください。" };

  const label = typeof r.label === "string" ? r.label.trim() : "";
  if (!label) return { ok: false, reason: "ルールの文を書いてください。" };
  if (label.length > LIMITS.textLength) return { ok: false, reason: `文は ${LIMITS.textLength} 字までにしてください。` };
  // 型のルールの文も AI への指示に入るので、同じように確かめる
  const conflict = lockedConflict(label);
  if (conflict) return { ok: false, reason: conflict };
  const base = { ...scope, id: r.id } as Rule;

  switch (check.kind) {
    case "minLeadMinutes":
    case "maxNewCustomersPerDay":
    case "bufferAfterMinutes": {
      const lim = LIMITS[check.kind];
      if (!inRange(check.value, lim))
        return { ok: false, reason: `数は ${lim.min} から ${lim.max} までの整数で入れてください。` };
      return { ok: true, value: { ...base, label, check: { kind: check.kind, value: check.value } } };
    }
    case "noSameDay": {
      if (check.with === undefined || check.with === null || check.with === "")
        return { ok: true, value: { ...base, label, check: { kind: "noSameDay" } } };
      // 相手のメニューを付ける（組み合わせに効かせる）のは、メニューごとのルールだけ
      if (scope.level !== "menu") return { ok: false, reason: "いっしょに入れないメニューを付けるときは、「メニュー」に付けてください。" };
      if (typeof check.with !== "string") return { ok: false, reason: "いっしょに入れないメニューを選んでください。" };
      if (check.with === scope.menuId) return { ok: false, reason: "ちがうメニューを選んでください。" };
      if (menuIds && !menuIds.includes(check.with)) return { ok: false, reason: "そのメニューは見つかりません。" };
      return { ok: true, value: { ...base, label, check: { kind: "noSameDay", with: check.with } } };
    }
    case "lastStart":
      if (typeof check.time !== "string" || !HHMM.test(check.time))
        return { ok: false, reason: "時刻は 18:00 のように入れてください。" };
      return { ok: true, value: { ...base, label, check: { kind: "lastStart", time: check.time } } };
    case "text":
      return { ok: true, value: { ...base, label, check: { kind: "text" } } };
    default:
      return { ok: false, reason: "ルールの種類が分かりません。" };
  }
}
