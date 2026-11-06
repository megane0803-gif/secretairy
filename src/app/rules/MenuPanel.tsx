"use client";

// ルールのタブの「メニュー」の欄：今あるメニューの時間（分）・値段（円）・最終受付をオーナーが直す（menuEdits.ts）。
// 「保存」を押した時だけ変わる。直す前と後を並べて見せ、「やめる」で元に戻す。id・名前・色・組み合わせの中身は変えない。
// 保存の前に、これから先の確定の予約と期限の切れていない仮押さえを新しい時間で確かめ、重なり・閉店越え・最終受付に当たる予約があれば
// 一覧を出す。もう一度押した時だけ保存する（予約は動かさない）。その間に予約が変わったら一覧を出し直す。
// 書くのはこのブラウザの中だけ（BrowserWrite）。書けた時だけ日誌に1行「オーナー：メニューを直した（カラー 90分 → 60分）」。

import { useMemo, useState } from "react";
import { SAVE_FAILED_MESSAGE } from "@/lib/browser";
import type { BookData } from "@/lib/book/data";
import { sameEpoch } from "@/lib/book/state";
import { useBook } from "@/lib/book/useBook";
import {
  changeText,
  COMBO_EDIT_NOTE,
  commitMenus,
  fieldsOf,
  lastStartChoices,
  lastStartProblem,
  MENU_EDIT_NOTE,
  menuChanges,
  menuConflicts,
  menuLimitsOf,
  menusMark,
  minuteChoices,
  minutesProblem,
  priceProblem,
  saveStep,
  type MenuConflict,
} from "@/lib/menuEdits";
import { useMenus } from "@/lib/useMenus";
import type { Menu } from "@/lib/settings";

/** 入れている途中の値（値段は打っている途中の文字のまま持つ） */
type Draft = Record<string, { minutes: number; price: string; lastStart: string }>;

export function MenuPanel({ data }: { data: BookData }) {
  const book = useBook(data);
  const { base } = useMenus();
  // 今のメニューは台帳の book.data.menus（読む入口は1つ）
  const current = book.data.menus;
  const lim = menuLimitsOf(data.shop);
  const [draft, setDraft] = useState<Draft | null>(null);
  // 見せた一覧（もう一度押した時に、今の一覧と同じかを見る）。epoch = 見せた時の「最初に戻す」の印
  const [ask, setAsk] = useState<{ mark: string; list: MenuConflict[]; epoch?: string; again: boolean } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const rowOf = (m: Menu) => {
    const d = draft?.[m.id];
    const f = fieldsOf(m, lim);
    return d ?? { minutes: f.minutes, price: String(f.price), lastStart: f.lastStart };
  };

  // 直した後のメニュー（入れている途中。数として読めない値段は、そのメニューの問題として出す）
  const { next, problems } = useMemo(() => {
    const problems: { id: string; name: string; text: string }[] = [];
    const next: Menu[] = current.map((m) => {
      const d = draft?.[m.id];
      if (!d) return m;
      const price = d.price.trim() === "" ? NaN : Number(d.price);
      const why = minutesProblem(d.minutes, lim) ?? priceProblem(price, lim) ?? lastStartProblem(d.lastStart, lim);
      if (why) {
        problems.push({ id: m.id, name: m.name, text: why });
        return m;
      }
      return { ...m, minutes: d.minutes, price, lastStart: d.lastStart };
    });
    return { next, problems };
  }, [current, draft, lim]);
  const changes = useMemo(() => menuChanges(current, next, data.shop), [current, next, data.shop]);
  const edited = current !== base && menuChanges(base, current, data.shop).length > 0;

  const setField = (m: Menu, k: "minutes" | "price" | "lastStart", v: string) => {
    setNote(null);
    setDraft((d) => {
      const row = { ...(d?.[m.id] ?? rowOf(m)) };
      if (k === "minutes") row.minutes = Number(v);
      else if (k === "price") row.price = v;
      else row.lastStart = v;
      return { ...(d ?? {}), [m.id]: row };
    });
  };

  const cancel = () => {
    setDraft(null);
    setAsk(null);
    setNote(null);
  };

  const press = (e: React.MouseEvent) => {
    // 人が押した時だけ（スクリプトから押したことにはしない）
    if (!e.nativeEvent.isTrusted) return;
    if (problems.length) return setNote(`${problems[0].name}：${problems[0].text}`);
    if (changes.length === 0) return setNote("変わった所がありません");
    const list = menuConflicts({ shop: book.shop, menus: next, all: book.all, now: book.now });
    // 一覧を見せた後に「最初に戻す」が押されていたら、その一覧は使わない
    const shownMark = ask && sameEpoch(book.state, ask.epoch) ? ask.mark : null;
    const step = saveStep(list, menusMark(next, base, data.shop), shownMark);
    if (step.kind === "show") {
      setAsk({ mark: step.mark, list, epoch: book.state.epoch, again: ask !== null });
      setNote(null);
      return;
    }
    // 書けた時だけ日誌に1行（commitMenus）。書けなかった時は「直した」と言わない。入力はそのまま残す
    const { write } = commitMenus(next, current, base, data.shop);
    if (!write.ok) return setNote(SAVE_FAILED_MESSAGE);
    setDraft(null);
    setAsk(null);
    setNote(`保存しました：${changes.map(changeText).join("・")}。予約チャット・台帳・予約サイト・LINE・AI の仕事の次の判定から効きます。`);
  };

  return (
    <div className="menu-edit">
      <p>メニューごとの時間・値段・最終受付です。予約の判定と、台帳の終わる時刻がこの時間で決まります。</p>
      <p className="hint">{MENU_EDIT_NOTE}</p>
      <ul className="menu-edit-list">
        {current.map((m) => {
          const row = rowOf(m);
          const b = base.find((x) => x.id === m.id);
          const changed = !!b && menuChanges([b], [m], data.shop).length > 0;
          const bad = problems.find((p) => p.id === m.id);
          return (
            <li key={m.id} className="menu-edit-row">
              <p className="menu-edit-name">
                <strong>{m.name}</strong>
                {changed && <span className="tag text">直した</span>}
                {m.includes?.length ? <small className="hint"> {COMBO_EDIT_NOTE}</small> : null}
              </p>
              <div className="menu-edit-fields">
                <label>
                  時間
                  <select value={row.minutes} onChange={(e) => setField(m, "minutes", e.target.value)} aria-label={`${m.name}の時間`}>
                    {minuteChoices(lim).map((n) => (
                      <option key={n} value={n}>
                        {n}分
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  値段（円）
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={lim.maxPrice}
                    step={1}
                    value={row.price}
                    onChange={(e) => setField(m, "price", e.target.value)}
                    aria-label={`${m.name}の値段（円）`}
                    aria-invalid={bad ? true : undefined}
                  />
                </label>
                <label>
                  最終受付
                  <select value={row.lastStart} onChange={(e) => setField(m, "lastStart", e.target.value)} aria-label={`${m.name}の最終受付`}>
                    {lastStartChoices(lim).map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
              </div>
              {bad && (
                <p className="problems" role="alert">
                  {bad.text}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="hint">
        設定に無い組み合わせ（カット＋ヘッドスパのように選んだメニューを足す物）は、中のメニューの時間と値段を足して決まります。時間は {lim.minMinutes}〜{lim.maxMinutes}分（{lim.step}分きざみ）、値段は 0〜{lim.maxPrice.toLocaleString("ja-JP")}円、最終受付は {lim.firstOpen}〜{lim.lastClose}（{lim.step}分きざみ）です。
      </p>

      {changes.length > 0 && (
        <div className="menu-edit-diff" aria-live="polite">
          <p className="verdict-head">直す前 → 後</p>
          <ul>
            {changes.map((c) => (
              <li key={`${c.id}-${c.field}`}>
                {c.name} {c.field === "minutes" ? "時間" : c.field === "price" ? "値段" : "最終受付"}：<span className="num">{c.before}</span> → <span className="num">{c.after}</span>
              </li>
            ))}
          </ul>
          <p className="hint">保存すると、台帳の予約の終わる時刻は新しい時間で出ます（もう過ぎた予約も）。</p>
        </div>
      )}

      {ask && (
        <div className="holiday-ask" role="alertdialog" aria-label="当たる予約がある">
          <p className="problems">
            {ask.again ? "予約か直す中身が変わったので、一覧を出し直しました。" : ""}新しい時間で確かめると、当たる予約が {ask.list.length}件 あります。保存しても予約は動かしません。もう一度「保存」を押すと保存します。
          </p>
          <ul className="holiday-list">
            {ask.list.map((c) => (
              <li key={c.id}>
                {c.label}
                <small> {c.reasons.join("・")}</small>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="form-buttons">
        <button type="button" className="btn primary" onClick={press} disabled={!draft}>
          {ask ? "それでも保存する" : "保存"}
        </button>
        <button type="button" className="btn" onClick={cancel} disabled={!draft}>
          やめる
        </button>
      </div>
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
      {edited && !draft && <p className="hint">直したメニューがあります。「最初に戻す」で設定の値に戻ります。</p>}
    </div>
  );
}
