"use client";

// 台帳から予約を入れる画面（電話・店頭で受けた予約）。スマホは下から出る1枚（ボトムシート）、PC は小さな窓。
// 上から順に：日時（押した時間が入っている）→ お客様（名字で探す）→ メニュー（組み合わせも。終わる時刻）→ 確かめの結果 → 「入れる」。
// 確かめは予約チャット・承認の箱と同じ判定（judgeSlot）で、入れる前と、保存する直前（その時の台帳で）の2回（src/lib/book/owner.ts）。
// 🔒 確定は人：オーナーが「入れる」を押した時だけ確定で台帳へ（承認の箱は通さない）。AI は使わない。

import { useEffect, useMemo, useRef, useState } from "react";
import { Checked, CustomerName } from "@/components/parts";
import { calDay, toHHMM, toMinutes } from "@/lib/calendar";
import { comboIdOf, resolveMenu } from "@/lib/combo";
import type { BookData } from "@/lib/book/data";
import { ownerBook, ownerCheck, ownerSlotContext, OWNER_TAG, type OwnerCheck, type OwnerOutcome } from "@/lib/book/owner";
import { CUSTOMER_PAGE, lastLabel, pickCountLabel, pickCustomers } from "@/lib/book/pickCustomer";
import { useBook } from "@/lib/book/useBook";
import { writeJournal } from "@/lib/journal";
import { SAVE_FAILED_MESSAGE } from "@/lib/browser";
import { useRules } from "@/lib/rules/useRules";

import type { SheetTarget } from "@/lib/book/weekView";
export type { SheetTarget };


export function OwnerBookSheet({ data, target, onClose }: { data: BookData; target: SheetTarget; onClose: () => void }) {
  const book = useBook(data);
  const { rules } = useRules(data.seedRules);
  const [start, setStart] = useState(target.start);
  const [query, setQuery] = useState("");
  // 出すお客様の数（「もっと表示」で足す）
  const [limit, setLimit] = useState(CUSTOMER_PAGE);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [menuIds, setMenuIds] = useState<string[]>([]);
  // 2回目に押した時：オーナーが見て「それでも入れる」としたルール
  const [asked, setAsked] = useState<string[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // 開いた時の「最初に戻す」の印
  const [openedEpoch] = useState(() => book.state.epoch);

  // 開いたら窓の中へ。Esc で閉じる
  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const day = calDay(book.shop, target.date);
  const step = Math.max(5, book.shop.slotMinutes);
  const times = useMemo(() => {
    if (!day.hours) return [target.start];
    const out: string[] = [];
    for (let t = toMinutes(day.hours.open); t + step <= toMinutes(day.hours.close); t += step) out.push(toHHMM(t));
    return out.includes(target.start) ? out : [target.start, ...out];
  }, [day.hours, step, target.start]);

  // 名字とよみで探し（カタカナでも）、前回来た日が新しい順（book/pickCustomer.ts）
  const pick = useMemo(() => pickCustomers(data.customers, book.kartes, query, limit), [data.customers, book.kartes, query, limit]);
  const found = pick.shown;
  const dayLabel = (d: string) => calDay(book.shop, d).label;
  const menuLabel = (id: string) => resolveMenu(data.menus, id)?.name ?? id;
  const customer = data.customers.find((c) => c.id === customerId) ?? null;
  const menuId = menuIds.length ? comboIdOf(data.menus, menuIds) : null;
  const menu = menuId ? resolveMenu(data.menus, menuId) : undefined;

  const ctx = { data: book.data, rules, now: new Date(book.nowIso) };
  // 入れる前の確かめ（いまの台帳で）
  const check: OwnerCheck | null = useMemo(() => {
    if (!customerId || !menuId) return null;
    const slot = ownerSlotContext(book.state, { data: book.data, rules, now: new Date(book.nowIso) }, customerId);
    return slot ? ownerCheck(slot, { menuId, date: target.date, start }) : null;
  }, [book.state, book.data, rules, book.nowIso, customerId, menuId, target.date, start]);

  const reset = () => {
    setAsked(null);
    setNote(null);
  };
  const toggleMenu = (id: string) => {
    reset();
    setMenuIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };

  const press = (e: React.MouseEvent) => {
    // 人が押した時だけ（スクリプトから押したことにはできない）
    if (!e.nativeEvent.isTrusted || !customerId || !menuId || !check) return;
    if (check.blocked.length) return;
    if (check.rules.length && !asked) {
      // 1回目：どのルールに当たるかを見せる。もう一度押せば入れる
      setAsked(check.rules.map((r) => r.key));
      setNote("オーナーが足したルールに当たります。お客様と話して決めた予約なら、もう一度押すと入れられます。");
      return;
    }
    let out: OwnerOutcome | null = null;
    // 保存する直前に、その時の台帳でもう一度確かめる（別の窓で入った予約とぶつからないように）。
    // 開いた後に「最初に戻す」が押されていたら入れない（startedEpoch）
    const w = book.update((s) => {
      out = ownerBook(s, { ...ctx, startedEpoch: { epoch: openedEpoch } }, { customerId, menuId, date: target.date, start }, asked ?? []);
      return out.state;
    });
    const o = out as OwnerOutcome | null;
    if (!o) return;
    // 書けなかった時は「入れました」と言わない（日誌も書かない。入力は残すので、もう一度押せる。直しA の形）
    if (o.ok && !w.ok) return setNote(SAVE_FAILED_MESSAGE);
    if (!o.ok) {
      setAsked(null);
      setNote(o.note);
      return;
    }
    writeJournal(...o.journal);
    setDone(o.message);
  };

  const title = "予約を入れる";
  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={box}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <span className="sheet-title">
            <strong>{title}</strong>
            <span className="tag owner">{OWNER_TAG}・確定</span>
          </span>
          <button type="button" className="btn small" onClick={onClose} aria-label="閉じる">
            閉じる
          </button>
        </div>

        {done ? (
          <div className="sheet-body">
            <Checked>{done}</Checked>
            <p className="hint">台帳・予約サイトの空き表・ホームの今日のお客様・前日のお知らせ・朝の要点に、確定の予約として入ります。</p>
            <button type="button" className="btn primary sheet-go" onClick={onClose}>
              閉じる
            </button>
          </div>
        ) : (
          <div className="sheet-body">
            <section className="sheet-step" aria-label="日時">
              <span className="sheet-label">1. 日時</span>
              <div className="sheet-when">
                <strong className="num">{day.label}</strong>
                <select
                  value={start}
                  onChange={(e) => {
                    reset();
                    setStart(e.target.value);
                  }}
                  aria-label="始まる時刻"
                >
                  {times.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <span className="hint">から</span>
              </div>
            </section>

            <section className="sheet-step" aria-label="お客様">
              <span className="sheet-label">2. お客様</span>
              <input
                type="search"
                className="sheet-search"
                placeholder="名字かよみで探す"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setLimit(CUSTOMER_PAGE);
                }}
                aria-label="お客様を名字かよみで探す"
              />
              <span className="hint" aria-live="polite">
                {pickCountLabel(pick, query)}（前回来た日が新しい順）
              </span>
              <div className="sheet-choices">
                {found.map(({ customer: c, last, showId }) => {
                  const lastText = lastLabel(last, dayLabel, menuLabel);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={c.id === customerId ? "sheet-choice on" : "sheet-choice"}
                      aria-pressed={c.id === customerId}
                      onClick={() => {
                        reset();
                        setCustomerId(c.id);
                      }}
                    >
                      <CustomerName surname={c.surname} fictional={c.fictional} />
                      {c.firstVisit && <span className="tag first">初めての方</span>}
                      {lastText && <small className="sheet-choice-last">{lastText}</small>}
                      {showId && <small className="sheet-choice-id num">番号 {c.id}</small>}
                    </button>
                  );
                })}
                {found.length === 0 && <p className="hint">その名字のお客様は一覧にいません（今ある一覧から選びます）</p>}
              </div>
              {pick.more && (
                <button type="button" className="btn sheet-more" onClick={() => setLimit((n) => n + CUSTOMER_PAGE)}>
                  もっと表示（あと {pick.matched - found.length}人）
                </button>
              )}
            </section>

            <section className="sheet-step" aria-label="メニュー">
              <span className="sheet-label">3. メニュー（いくつか選ぶと組み合わせ）</span>
              <div className="sheet-choices">
                {data.menus.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={menuIds.includes(m.id) ? "sheet-choice on" : "sheet-choice"}
                    aria-pressed={menuIds.includes(m.id)}
                    onClick={() => toggleMenu(m.id)}
                  >
                    <span>{m.name}</span>
                    <small className="num">{m.minutes}分</small>
                  </button>
                ))}
              </div>
              {menu && (
                <p className="sheet-end">
                  {menu.name}（<span className="num">{menu.minutes}</span>分）：<strong className="num">{start}</strong> から{" "}
                  <strong className="num">{toHHMM(toMinutes(start) + menu.minutes)}</strong> まで
                </p>
              )}
            </section>

            <section className="sheet-step" aria-label="確かめの結果">
              <span className="sheet-label">4. 確かめの結果（プログラム）</span>
              {!check ? (
                <p className="hint">お客様とメニューを選ぶと、予約チャット・承認の箱と同じ判定で確かめます。</p>
              ) : (
                <CheckLines check={check} />
              )}
            </section>

            <p className="hint">入れた予約は確定で台帳に入ります（承認の箱は通りません）。札は「{OWNER_TAG}」。</p>
            {/* 「入れる」は1枚の下に止めておく（上から選んでいる間も押せる所に） */}
            <div className="sheet-foot">
              {note && (
                <p className={check?.blocked.length ? "problems small" : "sheet-note"} role="status">
                  {note}
                </p>
              )}
              {check && check.blocked.length > 0 && !note && <p className="problems small">✗ 入れられません：{check.blocked[0].reason}</p>}
              <button
                type="button"
                className="btn primary sheet-go"
                onClick={press}
                disabled={!check || check.blocked.length > 0}
              >
                {check && check.rules.length && asked ? "ルールに当たるが、入れる（確定）" : "入れる（確定）"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 確かめの結果：✗（入れられない・もう一度押せば入れられる）を先に、✓ はまとめて。予約を変える1枚（ReservationSheet）も使う */
export function CheckLines({ check, verb = "入れられません" }: { check: OwnerCheck; verb?: string }) {
  const passed = check.lines.filter((l) => l.ok);
  return (
    <div className="sheet-checks">
      {check.blocked.length > 0 && (
        <ul className="problems small">
          {check.blocked.map((l) => (
            <li key={l.key}>
              ✗ {verb}：{l.label}（{l.reason}）
            </li>
          ))}
        </ul>
      )}
      {check.rules.length > 0 && (
        <ul className="sheet-rules small">
          {check.rules.map((l) => (
            <li key={l.key}>
              ! ルールに当たります：「{l.name ?? l.label}」（{l.reason}。どこに効くか：{l.scope ?? "全体"}）
            </li>
          ))}
        </ul>
      )}
      {check.ok ? (
        <Checked>受けられます（{check.lines.length}つの確かめを通りました）</Checked>
      ) : (
        passed.length > 0 && (
          <p className="hint">
            <span aria-hidden>✓</span> ほかの {passed.length}つの確かめは通りました
          </p>
        )
      )}
    </div>
  );
}
