"use client";

// 経理の日報を入れる1枚（スマホは下から出る1枚・PC は小さな窓）。上から順に：日付 → 来店 → 支払い方法ごとの売上 → 合計（プログラムが足す）→「入れる」。
// 数の確かめ・保存・日誌は accounting/daily.ts の commitDaily（人のボタンだけが呼ぶ）。どこにも送らない（freee・会計・AI のどれも呼ばない）。
// 書けなかった時は SAVE_FAILED_MESSAGE を出し、閉じずに数を残す。開いた時の「最初に戻す」の印を持ち、戻した後は保存しない（画面は印が変わったら閉じる）。

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { calDay } from "@/lib/calendar";
import {
  checkDaily,
  commitDaily,
  dailyOf,
  DAILY_RULE_NOTE,
  draftFor,
  isRealDate,
  monthTitle,
  monthOf,
  type DailyCommit,
  type DailyDraft,
  type DailyState,
  type DailyField,
} from "@/lib/accounting/daily";
import { browserDailyDeps } from "@/lib/accounting/dailyStore";
import { yen } from "@/lib/accounting/sales";
import { keyboardInset } from "@/lib/sheetInset";
import { currentEpoch } from "@/lib/book/store";
import type { SalesMonth } from "@/lib/data/types";
import type { DailyLimits, ShopSettings } from "@/lib/settings";

type Props = {
  /** 開いた時の日付 */
  date: string;
  today: string;
  seed: SalesMonth;
  daily: DailyState;
  shop: ShopSettings;
  limits: DailyLimits;
  onClose: () => void;
  /** 保存できた（入れた・直した・消した）時 */
  onDone: (r: Extract<DailyCommit, { ok: true }>) => void;
};

export function DailySheet({ date, today, seed, daily, shop, limits, onClose, onDone }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // 開いた時の「最初に戻す」の印（戻す前に入れかけた数を、戻した後に保存しない）
  const [epoch] = useState(() => currentEpoch());
  const [draft, setDraft] = useState<DailyDraft>(() => draftFor(date, daily, seed).draft);
  const [from, setFrom] = useState(() => draftFor(date, daily, seed).from);
  const [problem, setProblem] = useState<{ text: string; fields: DailyField[] } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);

  // スマホ：数字のキーボードが出ている間は、その高さだけ1枚を上げ、1枚の高さも見えている所に合わせる（「入れる」を下へ動かさずに押せるように）。
  // 値は CSS の変数に入れるだけで、使うのはスマホの幅の CSS だけ（PC の見た目は変えない）
  useEffect(() => {
    const d = ref.current;
    const vv = window.visualViewport;
    if (!d || !vv) return;
    const apply = () => {
      d.style.setProperty("--daily-kb", `${keyboardInset(window.innerHeight, vv)}px`);
      d.style.setProperty("--daily-vvh", `${Math.round(vv.height)}px`);
      // 1枚が縮んだら、入れている欄を1枚のまん中へ（下に止めた「入れる」の陰に隠れないように）
      const el = document.activeElement;
      if (el instanceof HTMLInputElement && d.contains(el)) requestAnimationFrame(() => el.scrollIntoView({ block: "center" }));
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
    };
  }, []);

  const ctx = { today, methods: seed.methods, limits, shop };
  const check = useMemo(() => checkDaily(draft, { today, methods: seed.methods, limits, shop }), [draft, today, seed.methods, limits, shop]);
  const own = isRealDate(draft.date) ? dailyOf(daily, draft.date) : null;
  const day = isRealDate(draft.date) ? calDay(shop, draft.date) : null;

  const pickDate = (next: string) => {
    setProblem(null);
    setConfirmRemove(false);
    if (!isRealDate(next)) return setDraft((d) => ({ ...d, date: next }));
    // 日付を変えたら、その日の数を読み直す（その日の日報 → 最初から入っている10月の数 → 空欄）
    const r = draftFor(next, daily, seed);
    setDraft(r.draft);
    setFrom(r.from);
  };
  const setField = (k: string, v: string) => {
    setProblem(null);
    setConfirmRemove(false);
    setDraft((d) => (k === "visits" ? { ...d, visits: v } : { ...d, pay: { ...d.pay, [k]: v } }));
  };

  const finish = (r: DailyCommit) => {
    if (r.ok) return onDone(r);
    if (r.reset) return onClose();
    // 書けなかった時・決まりで断った時は、閉じずに数を残す
    setProblem({ text: r.message, fields: r.errors?.map((e) => e.field) ?? [] });
  };
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!(e.nativeEvent as SubmitEvent).isTrusted) return;
    if (!check.ok) return setProblem({ text: check.errors[0].text, fields: check.errors.map((x) => x.field) });
    finish(commitDaily(browserDailyDeps, { ...ctx, epoch, action: { kind: "save", draft } }));
  };
  const remove = (e: React.MouseEvent) => {
    if (!e.isTrusted || !own) return;
    if (!confirmRemove) return setConfirmRemove(true);
    finish(commitDaily(browserDailyDeps, { ...ctx, epoch, action: { kind: "remove", date: own.date } }));
  };

  const bad = (f: DailyField) => (problem?.fields.includes(f) || (!check.ok && check.errors.some((x) => x.field === f)) ? true : undefined);
  const errorOf = (f: DailyField) => (!check.ok ? check.errors.find((x) => x.field === f)?.text : undefined);
  const numberInput = (id: string, label: string, unit: string, value: string) => {
    const err = errorOf(id);
    return (
      <label className="daily-field" key={id}>
        <span className="daily-label">{label}</span>
        <span className="daily-input">
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9０-９,，]*"
            autoComplete="off"
            enterKeyHint="next"
            placeholder="0"
            value={value}
            aria-invalid={bad(id)}
            onChange={(e) => setField(id, e.target.value)}
          />
          <span className="daily-unit">{unit}</span>
        </span>
        {err && <small className="daily-err">{err}</small>}
      </label>
    );
  };

  return (
    <dialog
      ref={ref}
      className="daily-sheet"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <form className="daily-form" onSubmit={save} noValidate>
        <div className="daily-head">
          <h2 id={titleId}>{own ? "この日の日報を直す" : "日報を入れる"}</h2>
          <button type="button" className="btn daily-close" onClick={onClose} aria-label="閉じる">
            閉じる
          </button>
        </div>
        <p className="hint daily-rule">{DAILY_RULE_NOTE}</p>

        <label className="daily-field">
          <span className="daily-label">日付</span>
          <input type="date" className="daily-date" max={today} value={draft.date} aria-invalid={bad("date")} onChange={(e) => pickDate(e.target.value)} />
          {errorOf("date") && <small className="daily-err">{errorOf("date")}</small>}
          {day && (
            <small className="hint">
              {day.label}
              {!day.open && (
                <strong className="daily-closed">・この日は休業日です（{day.holiday ? "休みの日" : "定休日"}。臨時に営業した日も入れられます）</strong>
              )}
              {from === "seed" && "・最初から入っている数を出しています"}
              {from === "daily" && "・入れた日報の数を出しています"}
            </small>
          )}
        </label>

        {numberInput("visits", "来店", "人", draft.visits)}
        <fieldset className="daily-pay">
          <legend>支払い方法ごとの売上</legend>
          {seed.methods.map((m) => numberInput(m.id, m.name, "円", draft.pay[m.id] ?? ""))}
        </fieldset>

        {/* 合計と「入れる」は、スマホでは1枚の下に止める（台帳の「予約を入れる」1枚と同じ形）。PC では今まで通りに並ぶ（display: contents） */}
        <div className="daily-foot">
          <div className="daily-total" role="status" aria-live="polite">
            <span>合計（プログラムが足した数）</span>
            <strong className="num">{check.total === null ? "—" : yen(check.total)}</strong>
          </div>
          {errorOf("total") && <small className="daily-err">{errorOf("total")}</small>}

          {problem && (
            <p className="problems" role="alert">
              {problem.text}
            </p>
          )}

          <button type="submit" className="btn primary daily-submit">
            {own ? "直す" : "入れる"}
          </button>
        </div>
        {own && (
          <button type="button" className={confirmRemove ? "btn danger daily-remove on" : "btn danger daily-remove"} onClick={remove}>
            {confirmRemove ? "もう一度押すと消します" : "この日の日報を消す"}
          </button>
        )}
        {own && confirmRemove && (
          <small className="hint">
            {monthOf(own.date) === seed.month && seed.days.some((d) => d.date === own.date)
              ? `消すと、最初から入っている${monthTitle(seed.month)}の数に戻ります。`
              : "消すと、この日の数は空に戻ります。"}
          </small>
        )}
      </form>
    </dialog>
  );
}
