"use client";

// 台帳の予約を押すと開く1枚（スマホは下から出る1枚・PC は小さな窓。「予約を入れる」の1枚と同じ形・ボタンは下に止める）。
// 上に今の中身（お客様・日時・メニュー・終わる時刻・確定か仮押さえか・どこから入ったか）。
//   仮押さえ … 直さない。「仮押さえは承認の箱で、承認か見送りを決めます」と出し、承認の箱へ移れる
//   開始を過ぎた・カルテがある … 見るだけ
//   確定で開始前 … 「この予約を取り消す」（もう一度押した時だけ）と、日時・メニューを変える（judgeSlot で変える前と保存の直前の2回）
// 中身と確かめは src/lib/book/change.ts。🔒 確定は人：オーナーが押した時だけ。AI は使わない。

import { useEffect, useMemo, useRef, useState } from "react";
import { Checked, CustomerName } from "@/components/parts";
import { SAVE_FAILED_MESSAGE } from "@/lib/browser";
import { addDays, calDay, toHHMM, toMinutes } from "@/lib/calendar";
import { comboIdOf, resolveMenu } from "@/lib/combo";
import {
  cancelReservation,
  changeCheck,
  changeDays,
  changeReservation,
  endOf,
  HOLD_NOTE,
  KARTE_NOTE,
  openedMark,
  PAST_NOTE,
  resLabel,
  sheetMode,
  SOURCE_LABEL,
  type ChangeContext,
  type ChangeOutcome,
} from "@/lib/book/change";
import type { BookData } from "@/lib/book/data";
import type { OwnerCheck } from "@/lib/book/owner";
import { useBook } from "@/lib/book/useBook";
import { viewKey } from "@/lib/book/weekView";
import { writeJournal } from "@/lib/journal";
import { useRules } from "@/lib/rules/useRules";
import { CheckLines } from "./OwnerBookSheet";

export function ReservationSheet({
  data,
  id,
  onClose,
  onMoved,
  onApprovals,
}: {
  data: BookData;
  id: string;
  onClose: () => void;
  /** 変えられた時：変えた先の日の週へ */
  onMoved: (date: string) => void;
  /** 仮押さえの時：承認の箱へ */
  onApprovals: () => void;
}) {
  const book = useBook(data);
  const { rules } = useRules(data.seedRules);
  const key = viewKey(book.state.epoch, book.dayOffset);
  const live = book.all.find((r) => r.id === id) ?? null;
  // 開いた時の印と中身（保存の直前に、印も中身もそのままかを確かめる。change.ts）
  const [mark] = useState(() => (live ? openedMark(key, live) : null));
  const box = useRef<HTMLDivElement>(null);
  const [date, setDate] = useState(live?.date ?? "");
  const [start, setStart] = useState(live?.start ?? "");
  const [menuIds, setMenuIds] = useState<string[]>(() => (live ? live.menu.id.split("+") : []));
  const [asked, setAsked] = useState<string[] | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 開いた時の予約（取り消した後・変えた後も、上の中身は開いた時の物を出す）
  const r = live ?? null;
  const ctx: ChangeContext = { data: book.data, rules, now: new Date(book.nowIso), kartes: book.kartes };
  const mode = r ? sheetMode(r, book.now, book.kartes) : null;
  const stale = !!mark && mark.key !== key;

  const days = useMemo(() => {
    const d = changeDays(book.state, { data: book.data, rules, now: new Date(book.nowIso) });
    const out: string[] = [];
    for (let x = d.first; x <= d.last && out.length < 400; x = addDays(x, 1)) out.push(x);
    return out;
  }, [book.state, book.data, rules, book.nowIso]);
  const day = date ? calDay(book.shop, date) : null;
  const step = Math.max(5, book.shop.slotMinutes);
  const times = useMemo(() => {
    if (!day?.hours) return start ? [start] : [];
    const out: string[] = [];
    for (let t = toMinutes(day.hours.open); t + step <= toMinutes(day.hours.close); t += step) out.push(toHHMM(t));
    return out.includes(start) || !start ? out : [start, ...out];
  }, [day?.hours, step, start]);

  const menuId = menuIds.length ? comboIdOf(book.data.menus, menuIds) : null;
  const menu = menuId ? resolveMenu(book.data.menus, menuId) : undefined;
  const same = !!r && !!menu && date === r.date && start === r.start && menu.id === r.menu.id;

  const check: OwnerCheck | null = useMemo(() => {
    if (!r || mode !== "edit" || !menuId || !date || !start || same) return null;
    return changeCheck(book.state, { data: book.data, rules, now: new Date(book.nowIso) }, r.id, { menuId, date, start });
  }, [r, mode, menuId, date, start, same, book.state, book.data, rules, book.nowIso]);

  const reset = () => {
    setAsked(null);
    setNote(null);
    setConfirmCancel(false);
  };

  // 書く：保存の直前の確かめ（change.ts）を通り、ブラウザに書けた時だけ、画面と日誌を変える
  const write = (f: (s: typeof book.state) => ChangeOutcome): ChangeOutcome | null => {
    let out: ChangeOutcome | null = null;
    const w = book.update((s) => {
      out = f(s);
      return out.state;
    });
    const o = out as ChangeOutcome | null;
    if (!o) return null;
    if (o.ok && !w.ok) {
      setNote(SAVE_FAILED_MESSAGE);
      return null;
    }
    return o;
  };

  const pressCancel = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted || !mark || stale) return;
    if (!confirmCancel) {
      setNote(null);
      setConfirmCancel(true);
      return;
    }
    const o = write((s) => cancelReservation(s, ctx, mark));
    if (!o) return;
    if (!o.ok) {
      setConfirmCancel(false);
      return setNote(o.note);
    }
    writeJournal(...o.journal);
    setDone(o.message);
  };

  const pressChange = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted || !mark || stale || !menuId || !check) return;
    if (check.blocked.length) return;
    if (check.rules.length && !asked) {
      setAsked(check.rules.map((x) => x.key));
      setNote("オーナーが足したルールに当たります。お客様と話して決めたなら、もう一度押すと変えられます。");
      return;
    }
    const o = write((s) => changeReservation(s, ctx, mark, { date, start, menuId }, asked ?? []));
    if (!o) return;
    if (!o.ok) {
      setAsked(null);
      return setNote(o.note);
    }
    writeJournal(...o.journal);
    setDone(o.message);
    if (o.date) onMoved(o.date);
  };

  const title = mode === "edit" && !done ? "予約を見る・直す" : "予約を見る";
  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} ref={box} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span className="sheet-title">
            <strong>{title}</strong>
          </span>
          <button type="button" className="btn small" onClick={onClose} aria-label="閉じる">
            閉じる
          </button>
        </div>

        {done ? (
          <div className="sheet-body">
            <Checked>{done}</Checked>
            <p className="hint">台帳・予約サイトの空き表・ホームの今日のお客様・前日のお知らせ・朝の要点に、今の中身で出ます。</p>
            <button type="button" className="btn primary sheet-go" onClick={onClose}>
              閉じる
            </button>
          </div>
        ) : !r || !mark ? (
          <div className="sheet-body">
            <p className="problems small">この予約はもう台帳にありません（ほかの画面で取り消されたかもしれません）。</p>
            <button type="button" className="btn sheet-go" onClick={onClose}>
              閉じる
            </button>
          </div>
        ) : (
          <div className="sheet-body">
            <dl className="sheet-facts">
              <dt>お客様</dt>
              <dd>
                <CustomerName surname={r.customer.surname} />
                {r.customer.firstVisit && <span className="tag first">初めての方</span>}
              </dd>
              <dt>日時</dt>
              <dd>
                <span>
                  <strong className="num">{calDay(book.shop, r.date).label}</strong> <strong className="num">{r.start}</strong>–<span className="num">{r.end}</span>
                </span>
              </dd>
              <dt>メニュー</dt>
              <dd>
                <span>
                  {r.menu.name}（<span className="num">{r.menu.minutes}</span>分・<span className="num">{r.end}</span> に終わる）
                </span>
              </dd>
              <dt>状態</dt>
              <dd>{r.status === "hold" ? <span className="tag hold">仮押さえ</span> : <span className="tag ok">確定</span>}</dd>
              <dt>どこから</dt>
              <dd>
                <span className="tag">{SOURCE_LABEL[r.source]}</span>
              </dd>
            </dl>

            {mode === "hold" && (
              <>
                <p className="sheet-note">{HOLD_NOTE}。</p>
                <div className="sheet-foot">
                  <button type="button" className="btn primary sheet-go" onClick={onApprovals}>
                    承認の箱へ
                  </button>
                </div>
              </>
            )}
            {mode === "past" && <p className="hint">{PAST_NOTE}。</p>}
            {mode === "karte" && <p className="hint">{KARTE_NOTE}。</p>}

            {mode === "edit" && (
              <>
                <section className="sheet-step" aria-label="日時とメニューを変える">
                  <span className="sheet-label">日時とメニューを変える</span>
                  <div className="sheet-when">
                    <select
                      value={date}
                      onChange={(e) => {
                        reset();
                        setDate(e.target.value);
                      }}
                      aria-label="日付"
                    >
                      {(days.includes(date) ? days : [date, ...days]).map((d) => {
                        const c = calDay(book.shop, d);
                        return (
                          <option key={d} value={d}>
                            {c.label}
                            {c.open ? "" : c.holiday ? "（休みの日）" : "（お休み）"}
                          </option>
                        );
                      })}
                    </select>
                    <select
                      value={start}
                      onChange={(e) => {
                        reset();
                        setStart(e.target.value);
                      }}
                      aria-label="始まる時刻"
                      disabled={times.length === 0}
                    >
                      {times.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                    <span className="hint">から</span>
                  </div>
                  <span className="hint">メニュー（いくつか選ぶと組み合わせ）</span>
                  <div className="sheet-choices">
                    {book.data.menus.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className={menuIds.includes(m.id) ? "sheet-choice on" : "sheet-choice"}
                        aria-pressed={menuIds.includes(m.id)}
                        onClick={() => {
                          reset();
                          setMenuIds((cur) => (cur.includes(m.id) ? cur.filter((x) => x !== m.id) : [...cur, m.id]));
                        }}
                      >
                        <span>{m.name}</span>
                        <small className="num">{m.minutes}分</small>
                      </button>
                    ))}
                  </div>
                  {menu && start && (
                    <p className="sheet-end">
                      {menu.name}（<span className="num">{menu.minutes}</span>分）：<strong className="num">{start}</strong> から{" "}
                      <strong className="num">{endOf(start, menu.minutes)}</strong> まで
                    </p>
                  )}
                </section>

                <section className="sheet-step" aria-label="確かめの結果">
                  <span className="sheet-label">確かめの結果（プログラム）</span>
                  {same ? (
                    <p className="hint">日時かメニューを変えると、台帳から入れる時と同じ判定で確かめます（この予約自身とはぶつかりません）。</p>
                  ) : !check ? (
                    <p className="hint">メニューを選んでください。</p>
                  ) : (
                    <CheckLines check={check} verb="変えられません" />
                  )}
                </section>

                <div className="sheet-foot">
                  {stale && (
                    <p className="problems small" role="status">
                      1枚を開いた後に「翌日へ」か「最初に戻す」が押されました。閉じて、もう一度押してください。
                    </p>
                  )}
                  {note && (
                    <p className={note === SAVE_FAILED_MESSAGE ? "problems small" : "sheet-note"} role="status">
                      {note}
                    </p>
                  )}
                  {confirmCancel ? (
                    <div className="sheet-confirm" role="group" aria-label="取り消す中身の確かめ">
                      <p className="sheet-note">
                        取り消す中身：{resLabel(book.shop, { surname: r.customer.surname, date: r.date, start: r.start, menuName: r.menu.name })}
                        （{r.end} に終わる）。もう一度押すと取り消します（空きに戻ります）。
                      </p>
                      <div className="sheet-actions">
                        <button type="button" className="btn sheet-go" onClick={() => setConfirmCancel(false)}>
                          やめる
                        </button>
                        <button type="button" className="btn danger sheet-go" onClick={pressCancel}>
                          取り消す（確定）
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="sheet-actions">
                      <button type="button" className="btn sheet-go" onClick={pressCancel} disabled={stale}>
                        この予約を取り消す
                      </button>
                      <button
                        type="button"
                        className="btn primary sheet-go"
                        onClick={pressChange}
                        disabled={stale || !check || check.blocked.length > 0}
                      >
                        {check && check.rules.length && asked ? "ルールに当たるが、変える" : "この内容に変える"}
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
