"use client";

// ホームの「LINE とつなぐ」。6けたのつなぐ番号を出し、オーナーが店の LINE に送ると、その LINE の人とこの画面がつながる（期限つき）。
// つながったら「朝の要点を LINE に送る」（プログラムが文にする。AI は使わない）。
// 画面が開いている間だけ動く（受け取りに行くのは LineBridge.tsx）。印・LINE の人の番号は出さない。

import { useState } from "react";
import { Checked, Fold } from "@/components/parts";
import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";
import { writeJournal } from "@/lib/journal";
import { latestBefore, nextLines } from "@/lib/karte/record";
import { morningText } from "@/lib/line/morning";
import { newLineState, type LineMode } from "@/lib/line/state";
import { lineApi, problemText, setLineStatus, updateLineState, useLineState, useLineStatus } from "@/lib/line/useLine";
import { freeRanges } from "@/lib/reservations";
import { getLineSettings, type KarteHeading } from "@/lib/settings";

function hm(iso: string | undefined, timezone: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString("ja-JP", { timeZone: timezone, month: "numeric", day: "numeric" })} ${d.toLocaleTimeString("ja-JP", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })}`;
}

/** needsPasscode = 環境変数 LINE_OWNER_PASSCODE がある（つなぐときにオーナー用の合言葉を求める。中身は画面に来ない） */
export function LinePanel({ data, headings, needsPasscode = false }: { data: BookData; headings: KarteHeading[]; needsPasscode?: boolean }) {
  const { state } = useLineState();
  const status = useLineStatus();
  const book = useBook(data);
  const settings = getLineSettings();
  const [busy, setBusy] = useState(false);
  const [passcode, setPasscode] = useState("");
  const tz = data.shop.timezone;

  const start = async (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted || busy) return;
    if (needsPasscode && !passcode.trim()) {
      setLineStatus({ problem: "オーナー用の合言葉を入れてから押してください" });
      return;
    }
    setBusy(true);
    const res = await lineApi.start(state?.token, needsPasscode ? passcode.trim() : undefined);
    setBusy(false);
    if (!res.ok) {
      setLineStatus({ problem: problemText(res.code, res.message) });
      // 合言葉そのものは日誌に書かない
      if (res.code === "passcode") writeJournal({ who: "プログラム", text: "LINE とつなぐのを止めた（オーナー用の合言葉がちがう）" });
      return;
    }
    setPasscode("");
    setLineStatus({ problem: null, last: null });
    updateLineState(() => newLineState(res.token, res.code, res.codeExpiresAt, state?.mode ?? "ai"));
    writeJournal({ who: "オーナー", text: `LINE とつなぐ番号を出した（${settings.codeMinutes}分まで）` });
  };

  const stop = async (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted || !state) return;
    const was = state.linked;
    updateLineState(() => null);
    setLineStatus({ problem: null, last: null });
    await lineApi.unlink(state.token);
    writeJournal({ who: "オーナー", text: was ? "LINE とのつなぎを切った" : "LINE とつなぐのをやめた" });
  };

  const setMode = (mode: LineMode) => {
    updateLineState((x) => (x ? { ...x, mode } : x));
    writeJournal({ who: "オーナー", text: `LINE の一言の振り分けを「${mode === "ai" ? "AI" : "決まった返事（AI なし）"}」にした` });
  };

  const sendMorning = async (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted || !state?.linked || busy) return;
    const menuName = (id: string) => book.data.menus.find((m) => m.id === id)?.name ?? id;
    const items = book.all
      .filter((r) => r.date === book.today.date)
      .map((r) => {
        const prev = latestBefore(book.kartes, r.customer.id, book.today.date);
        return {
          start: r.start,
          end: r.end,
          surname: r.customer.surname,
          menu: r.menu.name ?? menuName(r.menu.id),
          hold: r.status === "hold",
          next: prev ? nextLines(prev, headings) : null,
        };
      });
    const free = freeRanges(book.shop, book.today, book.all, book.now.date === book.today.date ? book.now.time : undefined);
    const text = morningText({
      shopName: data.shop.name,
      todayLabel: book.today.label,
      items,
      open: !!book.today.hours,
      free,
      slotMinutes: data.shop.slotMinutes,
    });
    setBusy(true);
    const res = await lineApi.send({ token: state.token, messages: [{ type: "text", text }] });
    setBusy(false);
    if (res.ok) {
      writeJournal({ who: "オーナー", text: `朝の要点を LINE に送った（今日の予約 ${items.length}件・空き ${free.seatSlots}枠。プログラムが文にした）` });
      setLineStatus({ problem: null, last: "✓ 朝の要点を LINE に送りました" });
    } else {
      writeJournal({ who: "プログラム", text: `朝の要点を LINE に送れなかった（${res.code === "limit" ? "送る上限" : "うまくいかなかった"}）` });
      setLineStatus({ problem: problemText(res.code, res.message) });
    }
  };

  return (
    <div className="line-panel">
      {!state && (
        <>
          <p className="hint">
            6けたのつなぐ番号を出します。店の LINE 公式アカウントに、オーナーの LINE からその番号を送ると、この画面とつながります（
            {settings.linkHours}時間有効です）。画面を開いている間だけ動きます。
          </p>
          {needsPasscode && (
            <label className="line-passcode">
              オーナー用の合言葉
              <input
                type="password"
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                autoComplete="current-password"
                maxLength={200}
                aria-describedby="line-passcode-hint"
              />
              <small id="line-passcode-hint" className="hint">
                この店では、つなぐ前にオーナー用の合言葉を確かめます。
              </small>
            </label>
          )}
          <button type="button" className="btn primary" onClick={start} disabled={busy || (needsPasscode && !passcode.trim())}>
            LINE とつなぐ
          </button>
        </>
      )}

      {state && !state.linked && state.code && (
        <>
          <p className="hint">店の LINE に、このつなぐ番号を送ってください。</p>
          <p className="line-code num" aria-label={`つなぐ番号 ${state.code.split("").join(" ")}`}>
            {state.code}
          </p>
          <p className="hint">期限 {hm(state.codeExpiresAt, tz)} まで（1回だけ使えます）。つながると、ここが変わります。</p>
          <button type="button" className="btn small" onClick={stop}>
            やめる
          </button>
        </>
      )}

      {state?.linked && (
        <>
          <Checked>LINE とつながっています（期限 {hm(state.until, tz)} まで）</Checked>
          <p className="hint">
            LINE で一言送ると、この画面が受け取って「予約の仮押さえ」「ToDo」「カルテのメモ」に振り分けます。承認待ちは LINE にも届きます（承認／見送り）。
          </p>
          <div className="line-mode" role="group" aria-label="一言の振り分け">
            <span className="hint">振り分け：</span>
            <label>
              <input type="radio" name="line-mode" checked={state.mode === "ai"} onChange={() => setMode("ai")} /> AI
            </label>
            <label>
              <input type="radio" name="line-mode" checked={state.mode === "script"} onChange={() => setMode("script")} /> 決まった返事（AI なし）
            </label>
          </div>
          <div className="line-buttons">
            <button type="button" className="btn primary" onClick={sendMorning} disabled={busy}>
              朝の要点を LINE に送る
            </button>
            <button type="button" className="btn small" onClick={stop}>
              つなぎを切る
            </button>
          </div>
        </>
      )}

      {status.problem && (
        <p className="problems small" role="alert">
          {status.problem}
        </p>
      )}
      {status.last && (
        <p className="hint" role="status">
          {status.last}
        </p>
      )}

      <Fold summary="くわしく">
        <ul className="line-notes">
          <li>LINE からの知らせは、店の LINE の秘密で署名を確かめ、違う物は捨てます。つながっていない人の LINE では何も動きません。</li>
          <li>画面が閉じている時に LINE が来たら「画面を開いている間だけ動きます」と返します。</li>
          <li>予約は予約チャットと同じ道具とプログラムの判定を通し、仮押さえまで。確定は、承認BOXか LINE の「承認」ボタン（つないだ LINE の人だけ・1つの行で1回だけ）。</li>
          <li>
            返事で済む時は返事で返します（数えない）。送る（数える）のは承認待ちの知らせと朝の要点で、1日 {settings.dailyPushLimit}通まで（無料は月200通）。
          </li>
          <li>お客様の名前は AI に送りません（〔お客様〕に置きかえ、だれかは画面のプログラムが名字で決めます）。データはこのブラウザの中だけ。LINE の知らせは受け取るまでの短い間だけ預けます。</li>
        </ul>
      </Fold>
    </div>
  );
}
