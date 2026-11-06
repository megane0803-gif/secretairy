"use client";

// 承認の箱。ホームの右の列と、予約タブの中に同じ行を出す。
// 1行に「何を・いつ・理由」。ボタンは「承認／直す／見送り」。押すとプログラムが実行する（AI は使わない）。
// 🔒 確定は人：確定は、人が画面のボタンを押したときだけ。押した事（ブラウザの本物の操作か）を確かめてから呼ぶ。

import { useState } from "react";
import { candidateLabel, judgeSlot } from "@/lib/ai/slots";
import { withApproved, withReleased, type PendingRow } from "@/lib/book/state";
import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";
import { writeJournal } from "@/lib/journal";
import { useRules } from "@/lib/rules/useRules";
import { resolveMenu } from "@/lib/combo";
import { approvalsFor, type ApprovalView } from "@/lib/approvals";
import { useApprovals } from "@/lib/useApprovals";
import { AdApprovalRows } from "./AdApprovalRows";
import { Checked, CustomerName } from "./parts";

export function ApprovalBox({
  data,
  compact = false,
  only = "all",
}: {
  data: BookData;
  compact?: boolean;
  /** 予約タブでは予約の行だけ（広告の案は出さない）。ホームは全部 */
  only?: ApprovalView;
}) {
  const book = useBook(data);
  const { rules } = useRules(data.seedRules);
  const [done, setDone] = useState<string | null>(null);
  // 行は approvals.ts の1か所で決める（上の帯・朝の要点の数と同じ物）。広告の案も同じ箱に出す
  const queue = approvalsFor(useApprovals(), only);

  if (queue.count === 0)
    return (
      <>
        <Checked>承認待ちはありません</Checked>
        {done && (
          <p className="hint" role="status">
            {done}
          </p>
        )}
      </>
    );

  const press = (e: React.MouseEvent, row: PendingRow, how: "approve" | "fixed" | "skipped") => {
    // 人がボタンを押したときだけ（スクリプトから押したことにはできない）
    if (!e.nativeEvent.isTrusted) return;
    const r = row.reservation;
    const customer = data.customers.find((c) => c.id === r.customerId);
    const surname = customer?.surname ?? "お客";
    const what = `${surname}様 ${candidateLabel(data, r)}`;
    if (how === "approve") {
      book.update((s) => withApproved(s, row.approval.id, new Date().toISOString()));
      writeJournal({ who: "オーナー", text: `承認：${what} を確定し、台帳に入れた` });
      setDone(`✓ 確定しました：${what}`);
    } else {
      book.update((s) => withReleased(s, row.approval.id, how, surname, new Date().toISOString(), book.today.date));
      writeJournal({
        who: "オーナー",
        text: `${how === "fixed" ? "直す" : "見送り"}：${what} の仮押さえを外し、ToDo に「${surname}様に別の日時を案内」を足した（お客様の了解なしに時間は変えない）`,
      });
      setDone(`仮押さえを外し、ToDo に足しました：${surname}様に別の日時を案内`);
    }
  };

  return (
    <ul className={compact ? "approvals compact" : "approvals"}>
      {queue.reservations.map((row) => {
        const r = row.reservation;
        const customer = data.customers.find((c) => c.id === r.customerId);
        const menu = resolveMenu(data.menus, r.menuId);
        // いまの台帳とルールで、もう一度確かめる（自分の仮押さえは数えない）
        const v = judgeSlot(
          {
            shop: book.shop,
            menus: data.menus,
            rules,
            booked: book.booked.filter((b) => b.id !== r.id),
            customer: { id: r.customerId, surname: customer?.surname ?? "", firstVisit: customer?.firstVisit ?? false },
            now: book.now,
            today: book.today,
          },
          r,
        );
        return (
          <li key={row.approval.id} className="approval">
            <div className="approval-what">
              <span className="tag hold">仮押さえ</span>
              {customer && <CustomerName surname={customer.surname} />}
              <strong>{menu?.name ?? r.menuId}</strong>
            </div>
            <div className="approval-when num">{candidateLabel(data, r).replace(` ${menu?.name ?? r.menuId}`, "")}</div>
            <p className="approval-why">{row.approval.reason}</p>
            {v.ok ? (
              <p className="checked small">
                <span aria-hidden>✓</span> いまの台帳とルールでも受けられます
              </p>
            ) : (
              <p className="problems small">✗ いまの台帳・ルールでは受けられません。確かめてから押してください</p>
            )}
            <div className="approval-buttons" role="group" aria-label="この仮押さえをどうするか">
              <button type="button" className="btn primary" onClick={(e) => press(e, row, "approve")}>
                承認
              </button>
              <button type="button" className="btn" onClick={(e) => press(e, row, "fixed")}>
                直す
              </button>
              <button type="button" className="btn" onClick={(e) => press(e, row, "skipped")}>
                見送り
              </button>
            </div>
          </li>
        );
      })}
      {only !== "reservations" && <AdApprovalRows seedRules={data.seedRules} />}
      {!compact && (
        <li className="hint">
          承認＝確定して台帳に入ります。直す・見送り＝お客様の了解なしに時間は変えないので、仮押さえを外して ToDo に「別の日時を案内」を足します。
          広告の案は、承認＝広告でその言葉を止める（外す）。直す＝一言で1回だけ出しなおし。見送り＝案を閉じる。
        </li>
      )}
    </ul>
  );
}
