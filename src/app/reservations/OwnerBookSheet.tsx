"use client";

// 台帳から予約を入れる画面（電話・店頭で受けた予約）。スマホは画面いっぱいの1枚、PC は小さな窓。中は3つの段（src/lib/book/ownerFlow.ts）：
//   ① お客様を選ぶ（枠を押すと最初にこれ）：名字かよみで探す・「前回来た日が新しい順／50音順」・前回からの間（book/pickCustomer.ts）。
//      50音順は行の見出しで区切り、右の端の索引で行へ動く。一覧は全員
//   ② メニューを選ぶ：前回のメニュー・よく使うメニュー・全部のメニュー（book/menuPick.ts。今の入口 book.data.menus から読む）。
//      いくつか選ぶと組み合わせ。下に止めた「メニューを決める」（何も選んでいない時は押せない）
//   ③ 確かめて入れる：日時（始まる時刻はここで変えられる）・お客様・メニュー・終わる時刻・確かめの結果・「入れる」
// どの段でも上に「戻る」（①では閉じる）。②③の上に選んだ日時を1行。戻って選び直した時は、選び直した所から先を消す。
// 確かめは予約チャット・承認の箱と同じ判定（judgeSlot）で、入れる前と、保存する直前（その時の台帳で）の2回（src/lib/book/owner.ts）。
// 🔒 確定は人：オーナーが「入れる」を押した時だけ確定で台帳へ（承認の箱は通さない）。AI は使わない。

import { useEffect, useMemo, useRef, useState } from "react";
import { Checked, CustomerName } from "@/components/parts";
import { calDay, toHHMM, toMinutes } from "@/lib/calendar";
import { comboIdOf, resolveMenu } from "@/lib/combo";
import type { BookData } from "@/lib/book/data";
import { menuColorClass } from "@/lib/book/menuColor";
import { frequentMenus, idsOfChoice, isChoice, lastMenuChoice, yen, type MenuChoice } from "@/lib/book/menuPick";
import { ownerBook, ownerCheck, ownerSlotContext, OWNER_TAG, type OwnerCheck, type OwnerOutcome } from "@/lib/book/owner";
import { canDecide, freshOwnerFlow, ownerFlowReduce, STAGE_LABEL, STAGES, type OwnerFlow, type OwnerFlowAction } from "@/lib/book/ownerFlow";
import { kanaGroups, kanaIndex, ORDER_LABEL, pickCountLabel, pickCustomers, type CustomerChoice, type CustomerOrder } from "@/lib/book/pickCustomer";
import { useBook } from "@/lib/book/useBook";
import { lastVisitOf } from "@/lib/karte/customers";
import { writeJournal } from "@/lib/journal";
import { SAVE_FAILED_MESSAGE } from "@/lib/browser";
import { useRules } from "@/lib/rules/useRules";
import type { Menu } from "@/lib/settings";

import type { SheetTarget } from "@/lib/book/weekView";
export type { SheetTarget };

export function OwnerBookSheet({ data, target, onClose }: { data: BookData; target: SheetTarget; onClose: () => void }) {
  const book = useBook(data);
  const { rules } = useRules(data.seedRules);
  const [flow, setFlow] = useState<OwnerFlow>(() => freshOwnerFlow(target.start));
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<CustomerOrder>("recent");
  const [done, setDone] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // 開いた時の「最初に戻す」の印
  const [openedEpoch] = useState(() => book.state.epoch);
  const { stage, customerId, menuIds, start, asked, note } = flow;

  const go = (a: OwnerFlowAction) => {
    const next = ownerFlowReduce(flow, a, target);
    if (next === null) return onClose();
    setFlow(next);
  };

  // 開いたら窓の中へ。Esc で閉じる
  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // 段が変わったら、1枚の一番上から見せる
  useEffect(() => {
    if (box.current) box.current.scrollTop = 0;
  }, [stage]);

  const day = calDay(book.shop, target.date);
  const step = Math.max(5, book.shop.slotMinutes);
  const times = useMemo(() => {
    if (!day.hours) return [target.start];
    const out: string[] = [];
    for (let t = toMinutes(day.hours.open); t + step <= toMinutes(day.hours.close); t += step) out.push(toHHMM(t));
    return out.includes(target.start) ? out : [target.start, ...out];
  }, [day.hours, step, target.start]);

  const menus = book.data.menus;
  const customer = data.customers.find((c) => c.id === customerId) ?? null;
  const menuId = menuIds.length ? comboIdOf(menus, menuIds) : null;
  const menu = menuId ? resolveMenu(menus, menuId) : undefined;
  const endOf = (m: { minutes: number }) => toHHMM(toMinutes(start) + m.minutes);

  const ctx = { data: book.data, rules, now: new Date(book.nowIso) };
  // 入れる前の確かめ（いまの台帳で）
  const check: OwnerCheck | null = useMemo(() => {
    if (!customerId || !menuId) return null;
    const slot = ownerSlotContext(book.state, { data: book.data, rules, now: new Date(book.nowIso) }, customerId);
    return slot ? ownerCheck(slot, { menuId, date: target.date, start }) : null;
  }, [book.state, book.data, rules, book.nowIso, customerId, menuId, target.date, start]);

  const press = (e: React.MouseEvent) => {
    // 人が押した時だけ（スクリプトから押したことにはできない）
    if (!e.nativeEvent.isTrusted || !customerId || !menuId || !check) return;
    if (check.blocked.length) return;
    if (check.rules.length && !asked) {
      // 1回目：どのルールに当たるかを見せる。もう一度押せば入れる
      go({ kind: "asked", keys: check.rules.map((r) => r.key), note: "オーナーが足したルールに当たります。お客様と話して決めた予約なら、もう一度押すと入れられます。" });
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
    if (o.ok && !w.ok) return go({ kind: "note", note: SAVE_FAILED_MESSAGE });
    if (!o.ok) {
      setFlow((f) => ({ ...f, asked: null, note: o.note }));
      return;
    }
    writeJournal(...o.journal);
    setDone(o.message);
  };

  const title = "予約を入れる";
  const when = (
    <p className="obs-when" aria-label="選んだ日時">
      <strong className="num">{day.label}</strong> <strong className="num">{start}</strong> から
      {customer && (
        <>
          {" "}
          ・ <CustomerName surname={customer.surname} />
        </>
      )}
    </p>
  );

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div
        className="sheet owner-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`${title}：${STAGE_LABEL[stage]}`}
        ref={box}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          {done ? (
            <span />
          ) : (
            <button type="button" className="btn small obs-back" onClick={() => go({ kind: "back" })} aria-label={stage === "customer" ? "戻る（閉じる。何も入れません）" : "戻る（前の段へ）"}>
              ← 戻る
            </button>
          )}
          <span className="sheet-title">
            <strong>{title}</strong>
            <span className="tag owner">{OWNER_TAG}・確定</span>
          </span>
          {done || stage !== "customer" ? (
            <button type="button" className="btn small" onClick={onClose} aria-label="閉じる">
              閉じる
            </button>
          ) : (
            <span />
          )}
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
            <ol className="obs-steps" aria-label="段">
              {STAGES.map((st, i) => (
                <li key={st} className={st === stage ? "on" : STAGES.indexOf(stage) > i ? "past" : ""} aria-current={st === stage ? "step" : undefined}>
                  <span className="num">{i + 1}</span> {STAGE_LABEL[st]}
                </li>
              ))}
            </ol>

            {stage === "customer" && (
              <CustomerStage
                book={book}
                data={data}
                dayLabel={`${day.label} ${start} から`}
                query={query}
                setQuery={setQuery}
                order={order}
                setOrder={setOrder}
                selected={customerId}
                onPick={(id) => go({ kind: "customer", id })}
              />
            )}

            {stage === "menu" && (
              <>
                {when}
                <MenuStage
                  menus={menus}
                  last={customerId ? lastMenuChoice(menus, lastVisitOf(book.kartes, customerId)) : null}
                  frequent={frequentMenus(book.all, book.now.date, menus)}
                  selected={menuIds}
                  onToggle={(id) => go({ kind: "toggleMenu", id })}
                  onSet={(c) => go({ kind: "setMenus", ids: isChoice(menus, menuIds, c.id) ? [] : idsOfChoice(c.id) })}
                />
                <div className="sheet-foot">
                  {menu ? (
                    <p className="obs-decide-what">
                      {menu.name}：<strong className="num">{start}</strong>〜<strong className="num">{endOf(menu)}</strong>
                    </p>
                  ) : (
                    <p className="hint">メニューを選ぶと、何時から何時までかが出ます。</p>
                  )}
                  <button type="button" className="btn primary sheet-go" onClick={() => go({ kind: "decide" })} disabled={!canDecide(flow)}>
                    メニューを決める
                  </button>
                </div>
              </>
            )}

            {stage === "confirm" && (
              <>
                {when}
                <section className="sheet-step" aria-label="日時">
                  <span className="sheet-label">日時</span>
                  <div className="sheet-when">
                    <strong className="num">{day.label}</strong>
                    <select value={start} onChange={(e) => go({ kind: "start", time: e.target.value })} aria-label="始まる時刻">
                      {times.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                    <span className="hint">から</span>
                  </div>
                </section>
                <dl className="sheet-facts">
                  <dt>お客様</dt>
                  <dd>{customer && <CustomerName surname={customer.surname} />}</dd>
                  <dt>メニュー</dt>
                  <dd>
                    {menu && (
                      <>
                        {menu.name}（<span className="num">{menu.minutes}</span>分・<span className="num">{yen(menu.price)}</span>）
                      </>
                    )}
                  </dd>
                  <dt>終わる時刻</dt>
                  <dd>{menu && <strong className="num">{endOf(menu)}</strong>}</dd>
                </dl>

                <section className="sheet-step" aria-label="確かめの結果">
                  <span className="sheet-label">確かめの結果（プログラム）</span>
                  {!check ? <p className="hint">予約チャット・承認の箱と同じ判定で確かめます。</p> : <CheckLines check={check} />}
                </section>

                <p className="hint">入れた予約は確定で台帳に入ります（承認の箱は通りません）。札は「{OWNER_TAG}」。</p>
                {/* 「入れる」は1枚の下に止めておく */}
                <div className="sheet-foot">
                  {note && (
                    <p className={check?.blocked.length ? "problems small" : "sheet-note"} role="status">
                      {note}
                    </p>
                  )}
                  {check && check.blocked.length > 0 && !note && <p className="problems small">✗ 入れられません：{check.blocked[0].reason}</p>}
                  <button type="button" className="btn primary sheet-go" onClick={press} disabled={!check || check.blocked.length > 0}>
                    {check && check.rules.length && asked ? "ルールに当たるが、入れる（確定）" : "入れる（確定）"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

type Book = ReturnType<typeof useBook>;

/** ① お客様を選ぶ */
function CustomerStage({
  book,
  data,
  dayLabel,
  query,
  setQuery,
  order,
  setOrder,
  selected,
  onPick,
}: {
  book: Book;
  data: BookData;
  dayLabel: string;
  query: string;
  setQuery: (q: string) => void;
  order: CustomerOrder;
  setOrder: (o: CustomerOrder) => void;
  selected: string | null;
  onPick: (id: string) => void;
}) {
  // 名字とよみで探し（カタカナでも）、並べ方は2つ（book/pickCustomer.ts）。前回からの間は台帳の今日から数える
  const pick = useMemo(() => pickCustomers(data.customers, book.kartes, query, { order, today: book.now.date }), [data.customers, book.kartes, query, order, book.now.date]);
  const groups = order === "kana" ? kanaGroups(pick.shown) : null;
  const index = groups ? kanaIndex(groups) : [];
  const row = (c: CustomerChoice) => (
    <li key={c.customer.id}>
      <button type="button" className={c.customer.id === selected ? "obs-row on" : "obs-row"} aria-pressed={c.customer.id === selected} onClick={() => onPick(c.customer.id)}>
        <CustomerName surname={c.customer.surname} />
        {c.showId && <small className="sheet-choice-id num">番号 {c.customer.id}</small>}
        <small className={c.last ? "obs-since" : "obs-since first"}>{c.since}</small>
      </button>
    </li>
  );

  return (
    <section className="sheet-step obs-customers" aria-label="お客様を選ぶ">
      <p className="obs-when">
        <strong className="num">{dayLabel}</strong>
      </p>
      <input type="search" className="sheet-search" placeholder="名字かよみで探す" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="お客様を名字かよみで探す" />
      <div className="obs-order" role="group" aria-label="並べ方">
        {(["recent", "kana"] as CustomerOrder[]).map((o) => (
          <button key={o} type="button" className={o === order ? "btn small on" : "btn small"} aria-pressed={o === order} onClick={() => setOrder(o)}>
            {ORDER_LABEL[o]}
          </button>
        ))}
      </div>
      <span className="hint" aria-live="polite">
        {pickCountLabel(pick, query)}
      </span>
      {pick.shown.length === 0 ? (
        <p className="hint">その名字のお客様は一覧にいません（今ある一覧から選びます）</p>
      ) : groups ? (
        <div className="obs-kana-wrap">
          <div className="obs-kana-list">
            {groups.map((g) => (
              <section key={g.id} className="obs-kana-group" aria-labelledby={`obs-g-${g.id}`}>
                <h3 id={`obs-g-${g.id}`} className="obs-kana-head">
                  {g.label}
                </h3>
                <ul className="obs-rows">{g.items.map(row)}</ul>
              </section>
            ))}
          </div>
          {/* 右の端の索引：押すとその行へ動く */}
          <nav className="obs-kana-index" aria-label="50音の行へ動く">
            {index.map((k) => (
              <button
                key={k.id}
                type="button"
                className="obs-kana-btn"
                disabled={!k.has}
                onClick={() => document.getElementById(`obs-g-${k.id}`)?.scrollIntoView({ block: "start" })}
                aria-label={`${k.label}行へ`}
              >
                {k.label}
              </button>
            ))}
          </nav>
        </div>
      ) : (
        <ul className="obs-rows">{pick.shown.map(row)}</ul>
      )}
    </section>
  );
}

/** ② メニューを選ぶ：前回のメニュー → よく使うメニュー → 全部のメニュー */
function MenuStage({
  menus,
  last,
  frequent,
  selected,
  onToggle,
  onSet,
}: {
  menus: Menu[];
  last: MenuChoice | null;
  frequent: MenuChoice[];
  selected: string[];
  onToggle: (id: string) => void;
  onSet: (c: MenuChoice) => void;
}) {
  const line = (m: Menu, on: boolean, onClick: () => void, key: string, extra?: string) => (
    <li key={key}>
      <button type="button" className={`obs-menu ${menuColorClass(m)}${on ? " on" : ""}`} aria-pressed={on} onClick={onClick}>
        <span className="obs-swatch" aria-hidden />
        <span className="obs-menu-name">{m.name}</span>
        <span className="obs-menu-nums">
          <span className="num">{yen(m.price)}</span> <span className="num">{m.minutes}分</span>
          {extra && <small className="hint"> {extra}</small>}
        </span>
      </button>
    </li>
  );
  return (
    <section className="sheet-step" aria-label="メニューを選ぶ">
      {last && (
        <>
          <h3 className="obs-menu-head">前回のメニュー</h3>
          <ul className="obs-rows">{line(last.menu, isChoice(menus, selected, last.id), () => onSet(last), `last-${last.id}`)}</ul>
        </>
      )}
      {frequent.length > 0 && (
        <>
          <h3 className="obs-menu-head">よく使うメニュー</h3>
          <ul className="obs-rows">{frequent.map((c) => line(c.menu, isChoice(menus, selected, c.id), () => onSet(c), `freq-${c.id}`, `${c.count}回`))}</ul>
        </>
      )}
      <h3 className="obs-menu-head">全部のメニュー（いくつか選ぶと組み合わせ）</h3>
      <ul className="obs-rows">{menus.map((m) => line(m, selected.includes(m.id), () => onToggle(m.id), `all-${m.id}`))}</ul>
      {(last || frequent.length > 0) && <p className="hint">前回・よく使うの行は、押すとそれだけを選びます（もう一度押すと外します）。</p>}
    </section>
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
