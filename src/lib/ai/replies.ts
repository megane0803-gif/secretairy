// 予約ではない話への返し方と、「お客様に出した候補」の決め方。どれもプログラムが出す。
// - 「今日やってますか」：店の設定（営業日・営業時間）から、やっているかだけ（メニューは聞かない）
// - お礼・感想：お礼だけ（予約は勧めない）
// - 別の用事（忘れ物など）で「お店に確かめてご連絡します」と言ったら、ToDo に「○○（架空）様：用件の1行」を足す
// - 候補のボタン：その返事の文に出てきた候補だけ（数も同じ）。仮押さえができた・取りやめた後は出さない

import { calDay, toMinutes } from "../calendar";
import type { ShopSettings } from "../settings";
import { normalizeText } from "./dates";
import type { Candidate } from "./wire";

/** 「今日やってますか」への答え（店の設定から） */
export function openTodayLine(shop: ShopSettings, now: { date: string; time: string }): string {
  const day = calDay(shop, now.date);
  if (!day.hours) {
    // 次の営業日
    for (let i = 1; i <= 14; i++) {
      const [y, m, d] = now.date.split("-").map(Number);
      const next = calDay(shop, new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
      if (next.hours) return `今日（${day.label}）はお休み${day.holiday ? "" : "（定休日）"}です。次は ${next.label} ${next.hours.open}〜${next.hours.close} に営業します。`;
    }
    return `今日（${day.label}）はお休み${day.holiday ? "" : "（定休日）"}です。`;
  }
  const t = toMinutes(now.time);
  if (t >= toMinutes(day.hours.close)) return `今日（${day.label}）の営業は ${day.hours.close} までで、もう終わりました。`;
  if (t < toMinutes(day.hours.open)) return `今日（${day.label}）は ${day.hours.open}〜${day.hours.close} で営業します。`;
  return `今日（${day.label}）は ${day.hours.open}〜${day.hours.close} で営業しています。`;
}

// 1人で営業する店なので「スタッフ」とは言わない。予約や次の来店も勧めない
export const THANKS_REPLY = "うれしいお言葉をありがとうございます。とても励みになります。";
export const ASK_SHOP_REPLY = "お店に確かめてご連絡します。";
export const CANCELED_REPLY = "かしこまりました。またいつでもご相談ください。";

export function asksOpenToday(text: string): boolean {
  return /(今日|本日|きょう).{0,8}(やって|営業|開いて|あいて|空いてる日|お休み|休み)/.test(text);
}

export function isThanks(text: string): boolean {
  return /(ありがとう|有難う|助かりました|よかったです|良かったです|気に入|満足|すてき|素敵|最高|うれしい|嬉しい)/.test(text);
}

/** 予約ではない別の用事（忘れ物・落とし物など） */
export function isErrand(text: string): boolean {
  return /(忘れ物|わすれもの|落とし物|置き忘れ|忘れて(しまい|しまった|いった|帰)|忘れたかも|領収書|駐車場)/.test(text);
}

/** 取りやめ（予約をやめる） */
export function isCancel(text: string): boolean {
  return /(やめ(ます|たい|て|とき|る)|やっぱり(いい|大丈夫)|キャンセル|取り消|取りやめ|とりやめ)/.test(text);
}

/** 日時を変えたい */
export function isShift(text: string): boolean {
  return /(ずら|変え|かえたい|変更|別の日|別の時間|ほかの日|他の日)/.test(text);
}

/** 返事の文が「お店に確かめて連絡します」と言っているか */
export function promisesShop(text: string): boolean {
  return /お店に(確かめ|確認し)/.test(text) || /確認して(から)?、?ご?連絡/.test(text);
}

/** お客様の文を ToDo の用件の1行にする（お客様の言葉のまま。最初の1文・40字まで） */
export function errandLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const first = flat.split(/[。？！?!]/).find((s) => s.trim().length >= 4)?.trim() ?? flat;
  return first.length > 40 ? `${first.slice(0, 40)}…` : first;
}

/** 文の中で、その候補（日付と時刻の両方）がどこに出てくるか。出てこなければ -1 */
export function mentionAt(text: string, c: Candidate): number {
  const t = normalizeText(text);
  const [, m, d] = c.date.split("-").map(Number);
  const [hh, mm] = c.start.split(":");
  const h = Number(hh);
  const dates = [`${m}/${d}`, `${m}月${d}日`];
  const times = [`${h}:${mm}`, `${hh}:${mm}`];
  if (mm === "00") times.push(`${h}時`);
  if (mm === "30") times.push(`${h}時半`, `${h}時30分`);
  let best = -1;
  for (const dt of dates) {
    let from = 0;
    for (;;) {
      const i = t.indexOf(dt, from);
      if (i < 0) break;
      // 「11/1」が「11/13」の頭に当たらないように
      const next = t[i + dt.length];
      if (!(next && /\d/.test(next))) {
        const after = t.slice(i + dt.length, i + dt.length + 25);
        if (times.some((x) => {
          const j = after.indexOf(x);
          // 終わりの時刻（「13:00–14:00」の 14:00）は始まりに数えない
          return j >= 0 && !/[\d–\-〜~ー]/.test(after[j - 1] ?? "") && !/\d/.test(after[j + x.length] ?? "");
        })) {
          if (best < 0 || i < best) best = i;
        }
      }
      from = i + dt.length;
    }
  }
  return best;
}

/** 候補のボタンに出す数の上限（文に出た物だけを出す。道具を何回か呼んでも、これより多くは出さない） */
export const MAX_SHOWN = 4;

/**
 * その返事でお客様に出した候補。文に出てきた順。
 * - 仮押さえができた返事 → なし
 * - 文に日付と時刻が出てきた候補（この相談で道具が出した物 pool と、前の返事で出した物 previous）。
 *   同じ日時でメニューだけちがう物は、この相談の物を使う（「ヘッドスパに変えたい。11/6の15時で」→ ヘッドスパ）
 * - 文に出てこないが「1つ目」と番号を付けて出している → この相談で道具が出した最後の候補
 * - どれでもない（取りやめ・お礼・聞き返しなど）→ なし
 */
export function shownCandidates(
  text: string,
  pool: Candidate[],
  latest: Candidate[] | null,
  held: boolean,
  previous: Candidate[] = [],
): Candidate[] {
  if (held) return [];
  // 前の返事の物 → この相談の物（道具を呼んだ順）の順に重ねるので、同じ日時ならあとの（新しい）方が残る
  const byTime = new Map<string, { c: Candidate; at: number }>();
  for (const c of [...previous, ...pool]) {
    const at = mentionAt(text, c);
    if (at >= 0) byTime.set(`${c.date}|${c.start}`, { c, at });
  }
  const list = [...byTime.values()].sort((a, b) => a.at - b.at).map((h) => h.c);
  if (list.length) return list.slice(0, MAX_SHOWN);
  if (latest && latest.length && /(1|一|ひと)つ目/.test(normalizeText(text))) return latest.slice(0, MAX_SHOWN);
  return [];
}
