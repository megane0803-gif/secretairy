"use client";

// 右の列：ルールを足す入力欄と、「ためしに確かめる」。
// ためしに確かめると、いまのルール（このブラウザに足した物も入れて）でプログラムが判定する。
// ルールを足す・直すと、出ている結果もすぐ変わる（次の判定から効く）。

import { useMemo, useState } from "react";
import { Fold, Panel } from "@/components/parts";
import { shopNow, toHHMM, toMinutes, type CalDay } from "@/lib/calendar";
import { scopeTag } from "@/lib/rules/describe";
import { judge, type Booked, type Booking, type JudgeMenu } from "@/lib/rules/judge";
import { instructionsFor } from "@/lib/rules/prompt";
import type { Rule } from "@/lib/rules/types";
import { useRules } from "@/lib/rules/useRules";
import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";
import { RuleForm } from "./RuleForm";

type Props = {
  seed: Rule[];
  menus: JudgeMenu[];
  shop: { timezone: string; seats: number; slotMinutes: number };
  days: CalDay[];
  /** 台帳（このブラウザの仮押さえ・確定も重ねる） */
  data: BookData;
};

export function RuleSide(props: Props) {
  const { add } = useRules(props.seed);
  const [added, setAdded] = useState<string | null>(null);
  return (
    <>
      <Panel title="ルールを足す">
        <p>種類を選んで、どこに効くかと数を入れます。足したルールは、すぐ次の判定から効きます。</p>
        <RuleForm
          menus={props.menus}
          submitLabel="足す"
          onSubmit={(r) => {
            add(r);
            setAdded(r.label);
          }}
        />
        {added && (
          <p className="checked" role="status">
            <span aria-hidden>✓</span> 足しました：{added}
          </p>
        )}
      </Panel>
      <TryPanel {...props} />
    </>
  );
}

function TryPanel({ seed, menus, shop, days, data }: Props) {
  const { rules } = useRules(seed);
  const book = useBook(data);
  const booked: Booked[] = useMemo(
    () => book.booked.map((b) => ({ date: b.date, start: b.start, menuIds: [b.menuId], newCustomer: b.newCustomer })),
    [book.booked],
  );
  const firstOpen = days.find((d, i) => i > 0 && d.open) ?? days[0];
  const [menuId, setMenuId] = useState(menus[0]?.id ?? "");
  const [date, setDate] = useState(firstOpen?.date ?? "");
  const [start, setStart] = useState("13:00");
  const [newCustomer, setNewCustomer] = useState(false);
  const [asked, setAsked] = useState<{ booking: Booking; now: { date: string; time: string } } | null>(null);
  const menuName = (id: string) => menus.find((m) => m.id === id)?.name ?? id;

  const times = useMemo(() => {
    const open = days.filter((d) => d.hours).map((d) => toMinutes(d.hours!.open));
    const close = days.filter((d) => d.hours).map((d) => toMinutes(d.hours!.close));
    const from = open.length ? Math.min(...open) : 600;
    const to = close.length ? Math.max(...close) : 1200;
    const step = Math.max(5, shop.slotMinutes);
    const out: string[] = [];
    for (let t = from; t < to; t += step) out.push(toHHMM(t));
    return out;
  }, [days, shop.slotMinutes]);

  // ルールが変わると、ここもすぐ判定しなおす
  const verdict = useMemo(() => {
    if (!asked) return null;
    const day = days.find((d) => d.date === asked.booking.date);
    return judge({
      rules,
      booking: asked.booking,
      now: asked.now,
      hours: day?.hours ?? null,
      seats: shop.seats,
      menus,
      existing: booked,
    });
  }, [asked, rules, days, shop.seats, menus, booked]);

  const ask = (e: React.FormEvent) => {
    e.preventDefault();
    setAsked({ booking: { date, start, menuIds: [menuId], newCustomer }, now: shopNow(shop) });
  };

  const dayLabel = (d: string) => days.find((x) => x.date === d)?.label ?? d;

  return (
    <Panel title="ためしに確かめる">
      <p>この予約を受けてよいか、プログラムがルールで判定します。AI はこの結果に従うだけです。</p>
      <form className="tryform" onSubmit={ask}>
        <label>
          メニュー
          <select value={menuId} onChange={(e) => setMenuId(e.target.value)}>
            {menus.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}（{m.minutes}分）
              </option>
            ))}
          </select>
        </label>
        <label>
          日にち
          <select value={date} onChange={(e) => setDate(e.target.value)}>
            {days.map((d) => (
              <option key={d.date} value={d.date}>
                {d.label}
                {d.open ? "" : "（お休み）"}
              </option>
            ))}
          </select>
        </label>
        <label>
          始まる時刻
          <select value={start} onChange={(e) => setStart(e.target.value)}>
            {times.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={newCustomer} onChange={(e) => setNewCustomer(e.target.checked)} />
          初めての方
        </label>
        <button type="submit" className="btn primary">
          確かめる
        </button>
      </form>

      {asked && verdict && (
        <div className={verdict.ok ? "verdict ok" : "verdict ng"} aria-live="polite">
          <p className="verdict-head">
            <span aria-hidden>{verdict.ok ? "✓" : "✗"}</span> {verdict.ok ? "受けられます" : "受けられません"}
          </p>
          <p className="verdict-what">
            {dayLabel(asked.booking.date)} {asked.booking.start} {asked.booking.menuIds.map(menuName).join("・")}
            {asked.booking.newCustomer ? "（初めての方）" : ""}
            <br />
            <small>
              判定した時刻：{dayLabel(asked.now.date)} {asked.now.time}（店の時間帯）。入っている予約（架空・このブラウザの仮押さえも）も数えます。
            </small>
          </p>
          <ul className="verdict-list">
            {verdict.results.map((r, i) => (
              <li key={`r${i}`} className={r.ok ? "ok" : "ng"}>
                <span aria-hidden>{r.ok ? "✓" : "✗"}</span>
                <span>
                  {r.rule.label} <span className="tag">{scopeTag(r.rule, menuName)}</span>
                  <small>{r.reason}</small>
                </span>
              </li>
            ))}
            {verdict.base.map((b) => (
              <li key={b.id} className={b.ok ? "ok" : "ng"}>
                <span aria-hidden>{b.ok ? "✓" : "✗"}</span>
                <span>
                  {b.label} <span className="tag text">店の設定</span>
                  <small>{b.reason}</small>
                </span>
              </li>
            ))}
          </ul>
          {verdict.texts.some((r) => !r.locked) && (
            <p className="hint">
              文のルール {verdict.texts.filter((r) => !r.locked).length} 本は、プログラムでは確かめず AI への指示に入れます。
            </p>
          )}
          <p className="hint">ルールを足す・直す・消すと、この結果もすぐ変わります。</p>
          <Fold summary="AI（Claude）に渡す指示を見る">
            <pre className="prompt">{instructionsFor(rules, verdict.situation, menuName, verdict)}</pre>
          </Fold>
        </div>
      )}
    </Panel>
  );
}
