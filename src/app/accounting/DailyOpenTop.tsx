"use client";

// 経理のタブの見出しのすぐ下（スマホの幅だけ。登録の欄より上）の「日報を入れる」。TabPage の beside に置く（画面の枠は直さない）。
// 押すと、売上の欄の今日の1枚が開く（売上の欄の中の「日報を入れる」と同じ動き。1枚は売上の欄の1つだけ。accounting/dailyOpen.ts）。
// PC の幅では出さない（今まで通り、売上の欄の中のボタンだけ）。スマホの幅では売上の欄の中のボタンを出さない（同じボタンを2つ見せない。globals.css）。

import { requestDailySheet } from "@/lib/accounting/dailyOpen";

export function DailyOpenTop() {
  return (
    <div className="acct-daily-top">
      <button type="button" className="btn primary acct-daily-open" onClick={() => requestDailySheet()}>
        日報を入れる
      </button>
    </div>
  );
}
