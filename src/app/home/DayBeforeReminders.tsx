"use client";

// 「翌日へ」を押した後に出す、前日のお知らせ（デモ）。お客様のスマホの画面の形で、1人に1つ。
// 文は決まった形（AI なし）。日時とメニューはプログラムが台帳から入れた物。🔒 本当には送らない。

import { CustomerName } from "@/components/parts";
import type { Reminder } from "@/lib/reminder";

export function DayBeforeReminders({
  reminders,
  dayLabel,
  sentLabel,
  demoNote,
  onClose,
}: {
  reminders: Reminder[];
  /** 予約の日（例 11/5（木）） */
  dayLabel: string;
  /** 届いたつもりの日（前日。例 11/4（水）） */
  sentLabel: string;
  demoNote: string;
  onClose: () => void;
}) {
  return (
    <section className="brief remind" aria-labelledby="brief-remind">
      <div className="remind-head">
        <h3 id="brief-remind">前日のお知らせ（{dayLabel}のご予約）</h3>
        <button type="button" className="btn small" onClick={onClose}>
          閉じる
        </button>
      </div>
      <p className="remind-demo">{demoNote}</p>
      {reminders.length === 0 ? (
        <p className="empty">{dayLabel}の確定の予約が無いので、お知らせはありません。</p>
      ) : (
        <ul className="remind-list" role="list">
          {reminders.map((m) => (
            <li key={m.reservationId} className="remind-phone" aria-label={`${m.surname}様のスマホの画面`}>
              <p className="remind-bar">
                <CustomerName surname={m.surname} />
                <span className="hint">のスマホ</span>
              </p>
              <p className="remind-sent hint">{sentLabel} に届いたつもり</p>
              <p className="remind-bubble">{m.text}</p>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">文は決まった形です（AI は使いません）。日時とメニューは台帳からプログラムが入れました。</p>
    </section>
  );
}
