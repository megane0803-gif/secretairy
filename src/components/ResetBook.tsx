"use client";

// 「最初に戻す」：このブラウザの変化を1回で全部最初に戻す（src/lib/reset.ts）。
// 予約は本当の今日を起点に作り直し（仮押さえ・承認の箱・足した ToDo・保存したカルテ・「翌日へ」も消える）、
// 広告（案・止めた／外した言葉）と経理（選んだ印・登録・足した自動のルール）、カルテの施術メモ・案・録音から作った文字と要点、発信の下書き（保存した物も）、
// LINE の預かり（届けた印・サーバーに預けてある知らせ。つなぎは残す）も戻す。日誌には残す。
// 台帳（予約タブ）と朝の要点（ホーム）の両方に置く。

import { useState } from "react";
import type { BookData } from "@/lib/book/data";
import { freeeSendingNow, resetUnderFreeeLock, useFreeeSending, useFreeeStarted } from "@/lib/freee/useFreee";
import { writeJournal } from "@/lib/journal";
import { lineApi } from "@/lib/line/useLine";
import { getLineSettings } from "@/lib/settings";
import { RESET_FAILED_MESSAGE, resetAll, type ResetOutcome } from "@/lib/reset";
import { shopToday } from "@/lib/calendar";

export function ResetBook({ data }: { data: BookData }) {
  const baseToday = shopToday(data.shop).today;
  const [asking, setAsking] = useState(false);
  // 経理で freee（テスト事業所）に送っている間は戻さない
  const sending = useFreeeSending();
  const freeeStarted = useFreeeStarted();
  const [blocked, setBlocked] = useState(false);
  const [failed, setFailed] = useState(false);

  const onReset = async (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    if (freeeSendingNow()) return setBlocked(true);
    // freee の排他の中で戻す（ほかのタブが freee とやりとりしている間は戻さない）
    let got: ResetOutcome | null = null;
    const done = await resetUnderFreeeLock(() => {
      // 起点は休みの日を見ない本当の今日（休みの日も最初に戻すので、店の設定だけで決める）
      got = resetAll(baseToday.date);
    });
    if (!done) return setBlocked(true);
    setBlocked(false);
    const out = got as ResetOutcome | null;
    // ブラウザに書けなかった時は「最初に戻した」と言わない（日誌も書かない。もう一度押せる）
    if (!out || !out.written) return setFailed(true);
    setFailed(false);
    const lineToken = out.lineToken;
    writeJournal({
      who: "オーナー",
      text: `最初に戻した：${baseToday.label}を起点に、予約・仮押さえ・承認の箱・足した ToDo（済みの印も）・保存したカルテ・人が直したカルテ（最初の状態の物も）・カルテのメモと案・録音から作った文字と要点・「翌日へ」を作り直し、広告と経理（自動のルールも・日報も）・発信の下書き・「AI の仕事」の済みの印${lineToken ? "・LINE の預かり" : ""}・同じ時間に受ける人数（${data.shop.seats}人）・休みの日・予約サイトで止めた時間を最初に戻した`,
    });
    setAsking(false);
    // サーバーに預けてある LINE の知らせ（まだ受け取っていない物）も消す。つなぎは残す
    if (lineToken)
      void lineApi.clear(lineToken).then((r) => {
        if (!r.ok) writeJournal({ who: "プログラム", text: `LINE の預かり物を消せなかった（${Math.ceil(getLineSettings().inboxSeconds / 60)}分で自然に消えます）` });
      });
  };

  return asking ? (
    <span className="rule-buttons" role="group" aria-label="最初に戻すかどうか">
      {freeeStarted && <span>経理の選びは画面だけ戻します。freee（テスト事業所）の記録は残ります（結果が分からない明細の印も残します）。</span>}
      {failed && <span role="alert">{RESET_FAILED_MESSAGE}</span>}
      {blocked && <span role="alert">経理で freee とやりとりしている間は、最初に戻せません。終わってから押してください。</span>}
      <span>本当の今日を起点に作り直します。仮押さえ・承認の箱・ToDo（足した物・済みの印）・保存したカルテ・人が直したカルテ（最初の状態の物も最初の中身に）・カルテのメモ・録音から作った文字と要点・広告・経理（足した自動のルールも・日報も）・保存した発信の下書き・「AI の仕事」（4行とも「これから」に）・LINE の預かり・同じ時間に受ける人数（{data.shop.seats}人に）・休みの日（予約のページで決めた日）・予約サイトで止めた時間も最初に戻ります（LINE のつなぎは残します）。</span>
      <button type="button" className="btn danger" onClick={(e) => void onReset(e)} disabled={sending}>
        最初に戻す
      </button>
      <button type="button" className="btn" onClick={() => setAsking(false)}>
        やめる
      </button>
    </span>
  ) : (
    <>
      <button type="button" className="btn small" onClick={() => setAsking(true)} disabled={sending}>
        最初に戻す
      </button>
      {sending && <span className="hint">経理で送っている間は、最初に戻せません</span>}
    </>
  );
}
