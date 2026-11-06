"use client";

// 右の列：ルールを足す入力欄と、「ためしに確かめる」。
// ためしに確かめると、いまのルール（このブラウザに足した物も入れて）でプログラムが判定する。
// ルールを足す・直すと、出ている結果もすぐ変わる（次の判定から効く）。

import { useMemo, useState } from "react";
import { Fold, Panel } from "@/components/parts";
import { calDay, shopNow, toHHMM, toMinutes, type CalDay } from "@/lib/calendar";
import { scopeTag } from "@/lib/rules/describe";
import { judge, type Booked, type Booking } from "@/lib/rules/judge";
import { instructionsFor } from "@/lib/rules/prompt";
import type { Rule } from "@/lib/rules/types";
import { useRules } from "@/lib/rules/useRules";
import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";
import { useCapacity } from "@/lib/useCapacity";
import { RuleForm } from "./RuleForm";
import { RuleWords } from "./RuleWords";
import { MenuPanel } from "./MenuPanel";
import type { RuleDraft } from "@/lib/rules/words";

type Props = {
  seed: Rule[];
  shop: { timezone: string; slotMinutes: number };
  days: CalDay[];
  /** 台帳（このブラウザの仮押さえ・確定も重ねる） */
  data: BookData;
  /** 言葉で書いて足す欄を出すか（AI の鍵がある時だけ。無ければ手で足す欄だけ） */
  wordsOn: boolean;
  /** 言葉で書く文の長さの上限（字。config/ai.json の ruleWords.maxTextChars） */
  wordsMaxChars: number;
};

export function RuleSide(props: Props) {
  const { add } = useRules(props.seed);
  // メニューは台帳の book.data.menus（ルールのタブの「メニュー」で直した分も重ねた1つの入口）から読む
  const book = useBook(props.data);
  const [added, setAdded] = useState<string | null>(null);
  // 言葉で書いた文から読み取った中身。入れなおすたびに足す欄を作りなおす（key）
  const [draft, setDraft] = useState<{ key: number; value: RuleDraft | null } | null>(null);
  // AI につながらなかったら、言葉の欄だけ出さない（手で足す欄はそのまま）
  const [noAi, setNoAi] = useState(false);
  return (
    <>
      <Panel title="同じ時間に受ける人数">
        <CapacityField />
      </Panel>
      <Panel title="メニュー">
        <MenuPanel data={props.data} />
      </Panel>
      <Panel title="ルールを足す">
        <p>種類を選んで、どこに効くかと数を入れます。足したルールは、すぐ次の判定から効きます。</p>
        {props.wordsOn && !noAi && (
          <RuleWords
            maxChars={props.wordsMaxChars}
            menus={book.data.menus}
            onFill={(value) => {
              setAdded(null);
              setDraft((d) => (value || d?.value ? { key: (d?.key ?? 0) + 1, value } : d));
            }}
            onNoAi={() => setNoAi(true)}
          />
        )}
        {props.wordsOn && noAi && <p className="hint">今は AI につながらないので、言葉で書く欄は出していません。下の欄で足してください。</p>}
        <RuleForm
          key={draft?.key ?? 0}
          menus={book.data.menus}
          draft={draft?.value ?? undefined}
          submitLabel="足す"
          onSubmit={(r) => {
            add(r, draft?.value ? "言葉で書いた文から" : undefined);
            setAdded(r.label);
            setDraft((d) => (d?.value ? { key: d.key + 1, value: null } : d));
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

/**
 * 同じ時間に受ける人数（店の設定の数。最初は config/shop.json の seats）。オーナーが幅（seatsRange）の中で選ぶ。
 * 変えた分はこのブラウザの中だけに残り、予約チャット・台帳・予約サイト・空き枠・AI の仕事の次の判定からすぐ効く。日誌に1行。
 */
function CapacityField() {
  const { seats, range, base, setSeats } = useCapacity();
  const choices = Array.from({ length: range.max - range.min + 1 }, (_, i) => range.min + i);
  return (
    <>
      <p>
        同じ時間に何人のお客様を受けるか。予約チャット・台帳・予約サイト・空き枠・AI の仕事が、みなこの数で数えます。
      </p>
      <div className="scope-row" role="radiogroup" aria-label="同じ時間に受ける人数">
        {choices.map((n) => (
          <label key={n} className={seats === n ? "pill on" : "pill"}>
            <input
              type="radio"
              name="capacity"
              value={n}
              checked={seats === n}
              onChange={(e) => {
                // 人が選んだときだけ（スクリプトから変えたことにはしない）
                if (e.nativeEvent.isTrusted) setSeats(n);
              }}
            />
            <span className="num">{n}</span>人
          </label>
        ))}
      </div>
      <p className="hint">
        どこに効くか：全体（店の設定）。最初は {base}人です。変えた分はこのブラウザの中だけに残り、「最初に戻す」で {base}人 に戻ります。
      </p>
    </>
  );
}

function TryPanel({ seed, shop, days: configDays, data }: Omit<Props, "wordsOn" | "wordsMaxChars">) {
  const { rules } = useRules(seed);
  const book = useBook(data);
  // 直したメニュー（ルールのタブの「メニュー」）の時間・最終受付で判定する
  const menus = book.data.menus;
  // 休みの日（予約のページで決めた分）も重ねた暦で（予約チャット・台帳と同じ判定）
  const days = useMemo(() => configDays.map((d) => calDay(book.shop, d.date)), [configDays, book.shop]);
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
      // 同じ時間に受ける人数（ルールのタブで変えた分も）
      seats: book.shop.seats,
      menus,
      existing: booked,
    });
  }, [asked, rules, days, book.shop.seats, menus, booked]);

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
              判定した時刻：{dayLabel(asked.now.date)} {asked.now.time}（店の時間帯）。入っている予約（このブラウザの仮押さえも）も数えます。
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
