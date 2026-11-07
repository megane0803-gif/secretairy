"use client";

// ルールのタブの「メニュー」の欄：今あるメニューの時間（分）・値段（円）・最終受付をオーナーが直す・メニューを足す・足したメニューを消す（menuEdits.ts）。
// メニューごとの欄は1行に畳める（押すと開く・閉じる。最初は全部畳む）。畳んだ行には「名前・時間・値段・最終受付」を1行で出し、
// 保存していない変更がある欄は畳んでも「直しかけ」の札が見える。「＋ メニューを足す」も押すまでは1行。
// 「保存」を押した時だけ変わる。直す前と後を並べて見せ、「やめる」で元に戻す。設定にあるメニューの id・名前・色・組み合わせの中身は変えない。
// 保存の前に、これから先の確定の予約と期限の切れていない仮押さえを新しい時間で確かめ、重なり・閉店越え・最終受付に当たる予約があれば
// 一覧を出す。もう一度押した時だけ保存する（予約は動かさない）。その間に予約が変わったら一覧を出し直す。
// 足したメニューは、台帳（予約・カルテ）やルールで使っている間は消せない（どこで使っているかを出す）。
// 書くのはこのブラウザの中だけ（BrowserWrite）。書けた時だけ日誌に書く「オーナー：メニューを直した（カラー 90分 → 60分）」
// 「オーナー：メニューを足した（トリートメント 30分・3,000円）」「オーナー：メニューを消した（トリートメント）」。

import { useMemo, useState } from "react";
import { SAVE_FAILED_MESSAGE } from "@/lib/browser";
import type { BookData } from "@/lib/book/data";
import { menuColorClass } from "@/lib/book/menuColor";
import { sameEpoch } from "@/lib/book/state";
import { useBook } from "@/lib/book/useBook";
import { calDay, toHHMM, toMinutes } from "@/lib/calendar";
import {
  changeText,
  COMBO_EDIT_NOTE,
  commitMenus,
  defaultMenuColor,
  fieldsOf,
  isOwnMenuId,
  lastStartChoices,
  lastStartProblem,
  MENU_EDIT_NOTE,
  menuChanges,
  menuColorChoices,
  menuConflicts,
  menuLimitsOf,
  menuNameProblem,
  menusMark,
  menuUses,
  minuteChoices,
  minutesProblem,
  nextOwnId,
  ownMenusOf,
  ownMenuText,
  priceProblem,
  saveStep,
  type MenuConflict,
} from "@/lib/menuEdits";
import { useRules } from "@/lib/rules/useRules";
import { useMenus } from "@/lib/useMenus";
import type { Menu } from "@/lib/settings";

/** 入れている途中の値（値段は打っている途中の文字のまま持つ） */
type Row = { minutes: number; price: string; lastStart: string };
type Draft = Record<string, Row>;
/** 足す途中のメニュー */
type Adding = Row & { name: string; color: string };

/** 色の名前（画面に出す言葉） */
const COLOR_NAME: Record<string, string> = { sky: "空色", purple: "紫", pink: "桃色", green: "緑", rose: "ばら色", olive: "オリーブ" };

const ADD_ID = "__add";

/**
 * メニューごとの欄の、畳んだ1行（押すと開く・閉じる）：色・名前・「時間・値段・最終受付」・札（足した・直した・直しかけ）。
 * 保存していない変更がある欄は、畳んでも「直しかけ」の札が見える（half）
 */
export function MenuRowHead(p: {
  menu: Pick<Menu, "name" | "color">;
  /** 「60分・4,800円・最終受付 19:00」（保存した値） */
  text: string;
  own: boolean;
  changed: boolean;
  half: "直しかけ" | "消す（保存前）" | null;
  open: boolean;
  bodyId: string;
  onToggle: () => void;
}) {
  return (
    <button type="button" className="menu-edit-head" aria-expanded={p.open} aria-controls={p.bodyId} onClick={p.onToggle}>
      <span className="rfold-mark" aria-hidden />
      <span className={`menu-edit-dot ${menuColorClass(p.menu)}`} aria-hidden />
      <strong className="menu-edit-title">{p.menu.name}</strong>
      <span className="menu-edit-sum num">{p.text}</span>
      {p.own && <span className="tag own">足した</span>}
      {p.changed && <span className="tag text">直した</span>}
      {p.half && <span className="tag warn">{p.half}</span>}
    </button>
  );
}

export function MenuPanel({ data }: { data: BookData }) {
  const book = useBook(data);
  const { base, seq } = useMenus();
  const { rules } = useRules(data.seedRules);
  // 今のメニューは台帳の book.data.menus（読む入口は1つ。足したメニューも入っている）
  const current = book.data.menus;
  const lim = menuLimitsOf(data.shop);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<string[]>([]);
  const [adding, setAdding] = useState<Adding | null>(null);
  // 開いている欄（最初は全部畳む）。足す欄は ADD_ID
  const [open, setOpen] = useState<string[]>([]);
  // 見せた一覧（もう一度押した時に、今の一覧と同じかを見る）。epoch = 見せた時の「最初に戻す」の印
  const [ask, setAsk] = useState<{ mark: string; list: MenuConflict[]; epoch?: string; again: boolean } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // 足す欄の問題は、名前を入れ始めるか「保存」を押した後だけ出す（開いたとたんに赤い文を出さない）
  const [addTried, setAddTried] = useState(false);

  const ownCount = ownMenusOf(current).length;
  const dayLabel = (d: string) => calDay(book.shop, d).label;
  const surnameOf = (id: string) => data.customers.find((c) => c.id === id)?.surname;

  const rowOf = (m: Menu): Row => {
    const d = draft?.[m.id];
    const f = fieldsOf(m, lim);
    return d ?? { minutes: f.minutes, price: String(f.price), lastStart: f.lastStart };
  };
  const isOpen = (id: string) => open.includes(id);
  const toggle = (id: string) => setOpen((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));

  // 直した・足した・消した後のメニュー（入れている途中。数として読めない値段は、そのメニューの問題として出す）
  const { next, problems } = useMemo(() => {
    const problems: { id: string; name: string; text: string }[] = [];
    const next: Menu[] = [];
    for (const m of current) {
      if (removing.includes(m.id)) continue;
      const d = draft?.[m.id];
      if (!d) {
        next.push(m);
        continue;
      }
      const price = d.price.trim() === "" ? NaN : Number(d.price);
      const why = minutesProblem(d.minutes, lim) ?? priceProblem(price, lim) ?? lastStartProblem(d.lastStart, lim);
      if (why) {
        problems.push({ id: m.id, name: m.name, text: why });
        next.push(m);
      } else next.push({ ...m, minutes: d.minutes, price, lastStart: d.lastStart });
    }
    if (adding) {
      const price = adding.price.trim() === "" ? NaN : Number(adding.price);
      const why =
        menuNameProblem(adding.name, next, lim, rules) ??
        minutesProblem(adding.minutes, lim) ??
        priceProblem(price, lim) ??
        lastStartProblem(adding.lastStart, lim) ??
        (menuColorChoices(base).includes(adding.color) ? null : "色を選んでください");
      if (why) problems.push({ id: ADD_ID, name: "足すメニュー", text: why });
      else
        next.push({
          id: nextOwnId(current, seq),
          name: adding.name.trim(),
          minutes: adding.minutes,
          price,
          lastStart: adding.lastStart,
          color: adding.color,
        });
    }
    return { next, problems };
  }, [current, draft, removing, adding, lim, rules, base, seq]);
  const changes = useMemo(() => menuChanges(current, next, data.shop), [current, next, data.shop]);
  const edited = current !== base && menuChanges(base, current, data.shop).length > 0;
  const pending = draft !== null || removing.length > 0 || adding !== null;

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

  const setAdd = (k: keyof Adding, v: string) => {
    setNote(null);
    setAdding((a) => (a ? { ...a, [k]: k === "minutes" ? Number(v) : v } : a));
  };

  const startAdd = () => {
    setNote(null);
    if (!adding) {
      const minutes = minuteChoices(lim)[0] ?? lim.minMinutes;
      const last = toHHMM(Math.max(toMinutes(lim.firstOpen), toMinutes(lim.lastClose) - Math.max(minutes, lim.step * 2)));
      setAdding({ name: "", minutes, price: "", lastStart: lastStartChoices(lim).includes(last) ? last : lim.lastClose, color: defaultMenuColor(base, current) });
    }
    toggle(ADD_ID);
  };

  const cancel = () => {
    setAddTried(false);
    setDraft(null);
    setRemoving([]);
    setAdding(null);
    setAsk(null);
    setNote(null);
  };

  const usesOf = (id: string) => menuUses(id, { menus: current, all: book.all, kartes: book.kartes, rules, dayLabel, surnameOf });

  const press = (e: React.MouseEvent) => {
    // 人が押した時だけ（スクリプトから押したことにはしない）
    if (!e.nativeEvent.isTrusted) return;
    if (adding) setAddTried(true);
    if (problems.length) return setNote(`${problems[0].name}：${problems[0].text}`);
    if (changes.length === 0) return setNote("変わった所がありません");
    // 消す前に、もう一度台帳を確かめる（開いた後に予約が入ったかもしれない）
    for (const id of removing) {
      const uses = usesOf(id);
      if (uses.length) return setNote(`${current.find((m) => m.id === id)?.name ?? ""}は使っている所があるので消せません：${uses.map((u) => u.label).join("・")}`);
    }
    if (ownMenusOf(next).length > lim.maxAdded) return setNote(`足せるメニューは ${lim.maxAdded}個 までです`);
    const list = menuConflicts({ shop: book.shop, menus: next, all: book.all, now: book.now });
    // 一覧を見せた後に「最初に戻す」が押されていたら、その一覧は使わない
    const shownMark = ask && sameEpoch(book.state, ask.epoch) ? ask.mark : null;
    const step = saveStep(list, menusMark(next, base, data.shop), shownMark);
    if (step.kind === "show") {
      setAsk({ mark: step.mark, list, epoch: book.state.epoch, again: ask !== null });
      setNote(null);
      return;
    }
    // 書けた時だけ日誌に書く（commitMenus）。書けなかった時は「直した」と言わない。入力はそのまま残す
    const { write } = commitMenus(next, current, base, data.shop);
    if (!write.ok) return setNote(SAVE_FAILED_MESSAGE);
    setDraft(null);
    setRemoving([]);
    setAdding(null);
    setAddTried(false);
    setAsk(null);
    setOpen((o) => o.filter((x) => x !== ADD_ID));
    setNote(`保存しました：${changes.map(changeText).join("・")}。予約チャット・台帳・予約サイト・LINE・AI の仕事の次の判定から効きます。`);
  };

  const fieldsFor = (name: string, row: Row, on: (k: "minutes" | "price" | "lastStart", v: string) => void, bad: boolean) => (
    <div className="menu-edit-fields">
      <label>
        時間
        <select value={row.minutes} onChange={(e) => on("minutes", e.target.value)} aria-label={`${name}の時間`}>
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
          onChange={(e) => on("price", e.target.value)}
          aria-label={`${name}の値段（円）`}
          aria-invalid={bad ? true : undefined}
        />
      </label>
      <label>
        最終受付
        <select value={row.lastStart} onChange={(e) => on("lastStart", e.target.value)} aria-label={`${name}の最終受付`}>
          {lastStartChoices(lim).map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
    </div>
  );

  const addBad = adding && (adding.name !== "" || addTried) ? problems.find((p) => p.id === ADD_ID) : undefined;
  const addFull = ownCount >= lim.maxAdded;

  return (
    <div className="menu-edit">
      <p>メニューごとの時間・値段・最終受付です。予約の判定と、台帳の終わる時刻がこの時間で決まります。行を押すと開きます。</p>
      <p className="hint">{MENU_EDIT_NOTE}</p>
      <ul className="menu-edit-list">
        {current.map((m) => {
          const row = rowOf(m);
          const b = base.find((x) => x.id === m.id);
          const own = isOwnMenuId(m.id);
          const changed = !!b && menuChanges([b], [m], data.shop).length > 0;
          const bad = problems.find((p) => p.id === m.id);
          const gone = removing.includes(m.id);
          const half = !!draft?.[m.id] || gone;
          const shown = isOpen(m.id);
          const uses = own && shown ? usesOf(m.id) : [];
          const bodyId = `menu-edit-${m.id}`;
          return (
            <li key={m.id} className="menu-edit-row" data-open={shown ? "true" : "false"}>
              <MenuRowHead
                menu={m}
                text={ownMenuText(m, lim)}
                own={own}
                changed={changed}
                half={gone ? "消す（保存前）" : half ? "直しかけ" : null}
                open={shown}
                bodyId={bodyId}
                onToggle={() => toggle(m.id)}
              />
              {shown && (
                <div className="menu-edit-body" id={bodyId}>
                  {m.includes?.length ? <p className="hint">{COMBO_EDIT_NOTE}</p> : null}
                  {gone ? (
                    <p className="hint">「保存」を押すと、このメニューを消します。「やめる」で元に戻します。</p>
                  ) : (
                    fieldsFor(m.name, row, (k, v) => setField(m, k, v), !!bad)
                  )}
                  {bad && (
                    <p className="problems" role="alert">
                      {bad.text}
                    </p>
                  )}
                  {own && !gone && (
                    <div className="menu-edit-remove">
                      {uses.length ? (
                        <>
                          <p className="hint">使っている所があるので、消せません（予約・カルテ・ルールから外れたら消せます）：</p>
                          <ul className="holiday-list">
                            {uses.map((u, i) => (
                              <li key={i}>{u.label}</li>
                            ))}
                          </ul>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            setNote(null);
                            setRemoving((r) => [...r, m.id]);
                            setDraft((d) => {
                              if (!d?.[m.id]) return d;
                              const { [m.id]: _drop, ...rest } = d;
                              void _drop;
                              return Object.keys(rest).length ? rest : null;
                            });
                          }}
                        >
                          このメニューを消す
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
        <li className="menu-edit-row menu-edit-add" data-open={isOpen(ADD_ID) ? "true" : "false"}>
          <button type="button" className="menu-edit-head" aria-expanded={isOpen(ADD_ID)} aria-controls="menu-edit-add" onClick={startAdd} disabled={addFull && !adding}>
            <span className="rfold-mark" aria-hidden />
            <strong className="menu-edit-title">＋ メニューを足す</strong>
            <span className="menu-edit-sum">{addFull ? `足せるのは ${lim.maxAdded}個 までです` : `単品のメニュー（あと ${lim.maxAdded - ownCount}個）`}</span>
            {adding && <span className="tag warn">直しかけ</span>}
          </button>
          {isOpen(ADD_ID) && adding && (
            <div className="menu-edit-body" id="menu-edit-add">
              <div className="menu-edit-fields menu-edit-addname">
                <label>
                  名前（{lim.maxNameChars}字まで）
                  <input
                    type="text"
                    value={adding.name}
                    maxLength={lim.maxNameChars * 2}
                    onChange={(e) => setAdd("name", e.target.value)}
                    aria-label="足すメニューの名前"
                    aria-invalid={addBad ? true : undefined}
                    placeholder="例：トリートメント"
                  />
                </label>
                <label>
                  色
                  <span className="menu-edit-color">
                    <span className={`menu-edit-dot ${menuColorClass({ color: adding.color })}`} aria-hidden />
                    <select value={adding.color} onChange={(e) => setAdd("color", e.target.value)} aria-label="足すメニューの色">
                      {menuColorChoices(base).map((c) => {
                        const users = current.filter((x) => x.color === c).map((x) => x.name);
                        return (
                          <option key={c} value={c}>
                            {COLOR_NAME[c] ?? c}
                            {users.length ? `（${users.join("・")}と同じ）` : ""}
                          </option>
                        );
                      })}
                    </select>
                  </span>
                </label>
              </div>
              {fieldsFor("足すメニュー", adding, (k, v) => setAdd(k, v), !!addBad)}
              {addBad && (
                <p className="problems" role="alert">
                  {addBad.text}
                </p>
              )}
              <p className="hint">足せるのは単品だけです。ほかのメニューといっしょの予約（組み合わせ）は、今と同じく時間と値段を足して作ります。</p>
              <div className="form-buttons">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setAdding(null);
                    setAddTried(false);
                    setNote(null);
                    setOpen((o) => o.filter((x) => x !== ADD_ID));
                  }}
                >
                  足すのをやめる
                </button>
              </div>
            </div>
          )}
        </li>
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
                {c.field === "added" ? (
                  <>
                    （なし） → <strong>{c.name}</strong> <span className="num">{c.after}</span>
                  </>
                ) : c.field === "removed" ? (
                  <>
                    <strong>{c.name}</strong> <span className="num">{c.before}</span> → （消す）
                  </>
                ) : (
                  <>
                    {c.name} {c.field === "minutes" ? "時間" : c.field === "price" ? "値段" : "最終受付"}：<span className="num">{c.before}</span> → <span className="num">{c.after}</span>
                  </>
                )}
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
        <button type="button" className="btn primary" onClick={press} disabled={!pending}>
          {ask ? "それでも保存する" : "保存"}
        </button>
        <button type="button" className="btn" onClick={cancel} disabled={!pending}>
          やめる
        </button>
      </div>
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
      {edited && !pending && <p className="hint">直した・足したメニューがあります。「最初に戻す」で設定の値に戻り、足したメニューは消えます。</p>}
    </div>
  );
}
