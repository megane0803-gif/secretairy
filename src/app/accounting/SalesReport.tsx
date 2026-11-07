"use client";

// 経理タブのいちばん上：売上。最初から入っている10月の数（seed/accounting.json）に、オーナーが入れた日報（このブラウザだけ）を重ねる。
// 大きい数字3つ（売上・来店・客単価）・日ごとの小さい棒（休業日は点。日報がある日は休業日でも棒。押すとその日の売上と来店）・支払い方法の割合の棒・日ごとの表。
// 月を選べる（最初から入っている月と、日報が入っている月）。数はどれもプログラムが日ごとの数から出す（accounting/daily.ts と sales.ts。AI は使わない）。
// 日報は freee にも会計にも AI にも送らない。
// 「日報を入れる」の1枚はここの1つだけ。経理の見出しの下のボタン（スマホ）とホームのボタン（/accounting?daily=today）は、accounting/dailyOpen.ts を通してここに開いてもらう。
// 内訳（技術・店販）を入れた日は、その日を押した時と日ごとの表に出し、月の大きい数字の下に内訳を入れた日の分を1行（数はプログラムが日ごとの数から足す）。

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BigNumber, Fold, MiniBar } from "@/components/parts";
import { onDailySheetRequest, wantsDailyOpen, withoutDailyOpen } from "@/lib/accounting/dailyOpen";
import { DAILY_SECTION_NOTE, initialMonth, monthAfterRemove, monthTitle, parseDaily, salesMonths, summarizeMonth, type DailyCommit } from "@/lib/accounting/daily";
import { yen } from "@/lib/accounting/sales";
import { useBookState, useMinute } from "@/lib/book/useBook";
import { DAILY_KEY, readBrowser, subscribeBrowser } from "@/lib/browser";
import { demoClock } from "@/lib/calendar";
import { getAccounting } from "@/lib/data/seed";
import { withHolidays } from "@/lib/holidays";
import { getAccountingSettings, getShop } from "@/lib/settings";
import { useHolidays } from "@/lib/useHolidays";
import { DailySheet } from "./DailySheet";

const readRaw = () => readBrowser(DAILY_KEY);
const noSub = () => () => {};

/** その日の内訳の1つ（「技術 25,000円・店販 5,000円」） */
export const splitText = (x: { tech: number; retail: number }) => `技術 ${yen(x.tech)}・店販 ${yen(x.retail)}`;

export function SalesReport() {
  // 店の設定に、予約のページで決めた休みの日を重ねる（台帳と同じ。useBook）。休業日の判定はこの shop の calDay
  const { dates: holidays } = useHolidays();
  const shop = useMemo(() => withHolidays(getShop(), holidays), [holidays]);
  const seed = getAccounting().sales;
  const limits = getAccountingSettings().daily;
  const book = useBookState();
  const minute = useMinute();
  // 今日は「翌日へ」で進めた今日（予約の台帳と同じ決め方。休みの日を重ねてから calendar.ts の demoClock）
  const today = useMemo(() => demoClock(shop, new Date(minute * 60_000), book.state.dayOffset).today.date, [shop, minute, book.state.dayOffset]);
  const raw = useSyncExternalStore(subscribeBrowser, readRaw, () => null);
  const daily = useMemo(() => parseDaily(raw), [raw]);

  // 選んだ月（null = 開いた時の月）。もう選べない月（消した・最初に戻した）は「日報が入っている一番新しい月 → 10月」
  const [picked, setPicked] = useState<string | null>(null);
  const months = salesMonths(daily, seed.month);
  const month = picked ? monthAfterRemove(picked, daily, seed.month) : initialMonth(daily, seed.month);
  const s = useMemo(() => summarizeMonth(month, seed, daily, shop, today), [month, seed, daily, shop, today]);
  const hasDaily = s.days.some((d) => d.daily);

  const [pick, setPick] = useState<string | null>(null);
  const pickedDay = s.days.find((d) => d.date === pick);
  const [sheet, setSheet] = useState<{ date: string; n: number } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const openSheet = (date: string) => {
    setDone(null);
    setSheet((x) => ({ date, n: (x?.n ?? 0) + 1 }));
  };

  // ほかのボタン（経理の見出しの下・ホーム）からの「今日の1枚を開いて」。1枚はここの1つだけ（dailyOpen.ts）。
  // ホームから来た時（?daily=today）は、ブラウザの中身を読み終えた描画（hydrated）で開き、印は URL から消す（開き直しで、もう一度開かない）
  const hydrated = useSyncExternalStore(noSub, () => true, () => false);
  const todayRef = useRef(today);
  todayRef.current = today;
  const [wantOpen, setWantOpen] = useState(false);
  useEffect(() => onDailySheetRequest(() => setWantOpen(true)), []);
  useEffect(() => {
    const l = window.location;
    if (!wantsDailyOpen(l.search)) return;
    window.history.replaceState(window.history.state, "", withoutDailyOpen(l.pathname, l.search, l.hash));
    setWantOpen(true);
  }, []);
  useEffect(() => {
    if (!wantOpen || !hydrated) return;
    setWantOpen(false);
    setDone(null);
    setSheet((x) => ({ date: todayRef.current, n: (x?.n ?? 0) + 1 }));
  }, [wantOpen, hydrated]);

  // 「最初に戻す」で印が変わったら、開いている1枚を閉じる（戻す前に入れかけた数は保存しない。保存の側でも印を確かめる）
  const epochRef = useRef(book.state.epoch);
  useEffect(() => {
    if ((epochRef.current ?? "") === (book.state.epoch ?? "")) return;
    epochRef.current = book.state.epoch;
    setSheet(null);
    setPicked(null);
    setDone(null);
  }, [book.state.epoch]);

  const onDone = (r: Extract<DailyCommit, { ok: true }>) => {
    setSheet(null);
    setDone(r.message);
    setPick(null);
    // 入れた・直した時は、その日の月に切り替える。消した時は、その月がもう選べなければ戻す
    setPicked(r.kind === "remove" ? monthAfterRemove(month, r.state, seed.month) : r.month);
  };

  const at = months.indexOf(month);
  const title = monthTitle(month);

  return (
    <section className="acct-sales" aria-labelledby="acct-sales">
      <h2 id="acct-sales">
        {title}の売上
      </h2>
      <p className="hint">{DAILY_SECTION_NOTE}</p>
      <div className="acct-daily-bar">
        {/* スマホの幅では出さない（見出しのすぐ下の同じボタン DailyOpenTop を出す。同じボタンを2つ見せない。globals.css） */}
        <button type="button" className="btn primary acct-daily-open acct-daily-in" onClick={() => openSheet(today)}>
          日報を入れる
        </button>
        {months.length > 1 && (
          <div className="acct-months" role="group" aria-label="売上の月を選ぶ">
            <button type="button" className="btn" disabled={at <= 0} onClick={() => setPicked(months[at - 1])}>
              ← 前の月
            </button>
            <span className="acct-month-now" aria-live="polite">
              {title}
            </span>
            <button type="button" className="btn" disabled={at >= months.length - 1} onClick={() => setPicked(months[at + 1])}>
              次の月 →
            </button>
          </div>
        )}
      </div>
      {done && (
        <p className="hint" role="status">
          {done}
        </p>
      )}
      <div className="bignums">
        <BigNumber label="売上" value={s.total} unit="円" />
        <BigNumber label="来店" value={s.visits} unit="人" />
        <BigNumber label="客単価" value={s.perVisit} unit="円" />
      </div>
      {s.split.days > 0 && (
        <p className="acct-split-month">
          {splitText(s.split)}
          <span className="hint">（内訳を入れた {s.split.days}日分）</span>
        </p>
      )}

      <h3 className="acct-h3">日ごとの売上</h3>
      <div className="daybars" role="group" aria-label={`${s.month}月の日ごとの売上（棒を押すと、その日の売上と来店）`}>
        {s.days.map((d) =>
          d.shown ? (
            <button
              key={d.date}
              type="button"
              className={["daybar", pick === d.date ? "on" : "", d.daily ? "daily" : ""].filter(Boolean).join(" ")}
              aria-pressed={pick === d.date}
              aria-label={`${d.label} 売上 ${yen(d.sales)}・来店 ${d.visits}人${d.daily ? "（日報）" : ""}${d.open ? "" : "（休業日）"}`}
              title={`${d.label} ${yen(d.sales)}${d.daily ? "（日報）" : ""}`}
              onClick={() => setPick(pick === d.date ? null : d.date)}
            >
              <span style={{ height: `${s.maxDay > 0 && d.sales > 0 ? Math.max(4, Math.round((d.sales / s.maxDay) * 100)) : 0}%` }} />
            </button>
          ) : (
            <span key={d.date} className="daybar closed" role="img" aria-label={`${d.label} ${d.holiday ? "休みの日" : "定休日"}`} title={`${d.label} ${d.holiday ? "休みの日" : "定休日"}`}>
              <i />
            </span>
          ),
        )}
      </div>
      {hasDaily && (
        <div className="daybars-marks" aria-hidden>
          {s.days.map((d) => (
            <span key={d.date}>{d.daily ? <i /> : null}</span>
          ))}
        </div>
      )}
      <div className="daybars-labels" aria-hidden>
        {s.days.map((d) => (
          <span key={d.date}>{d.day === 1 || d.day % 5 === 0 ? d.day : ""}</span>
        ))}
      </div>
      <p className="acct-pickday" role="status">
        {pickedDay ? (
          <>
            <strong>{pickedDay.label}</strong> 売上 <strong className="num">{yen(pickedDay.sales)}</strong>・来店 <strong className="num">{pickedDay.visits}人</strong>
            {pickedDay.daily && <span className="tag own acct-daily-tag">日報</span>}
            {pickedDay.split && <span className="acct-split-day num">（{splitText(pickedDay.split)}）</span>}
          </>
        ) : (
          <span className="hint">
            棒を押すと、その日の売上と来店が出ます。点は定休日{s.days.some((d) => d.holiday) && "・休みの日"}です。{hasDaily && "棒の下の印は、日報から入った日です。"}
          </span>
        )}
      </p>

      <h3 className="acct-h3">支払い方法の割合</h3>
      <ul className="acct-methods">
        {s.methods.map((m) => (
          <li key={m.id}>
            <span className="acct-method-name">{m.name}</span>
            <MiniBar value={m.amount} max={s.total} label={`${m.name}の割合`} />
            <span className="num acct-method-pct">
              <strong>{m.pct}</strong>%
            </span>
            <span className="num hint">{yen(m.amount)}</span>
          </li>
        ))}
      </ul>

      <Fold summary={s.missingCount > 0 ? `表で見る（日ごとの売上・日報がまだの日 ${s.missingCount}日）` : "表で見る（日ごとの売上）"}>
        <div className="ad-scroll">
          <table className="table acct-table">
            <thead>
              <tr>
                <th>日</th>
                <th className="num">売上</th>
                <th className="num">来店</th>
                <th className="num">客単価</th>
              </tr>
            </thead>
            <tbody>
              {s.days.map((d) => (
                <tr key={d.date} className={d.shown ? (d.missing ? "missing" : undefined) : "off"}>
                  <td>
                    {d.label}
                    {d.daily && <span className="tag own acct-daily-tag">日報</span>}
                  </td>
                  {d.missing ? (
                    <td colSpan={3}>
                      <button type="button" className="btn small acct-missing" onClick={() => openSheet(d.date)} aria-label={`${d.label} の日報はまだです。押すと入れられます`}>
                        まだ（押して入れる）
                      </button>
                    </td>
                  ) : d.shown && d.ahead ? (
                    <td colSpan={3} className="hint">
                      —
                    </td>
                  ) : d.shown ? (
                    <>
                      <td className="num">
                        {yen(d.sales)}
                        {d.split && <small className="acct-split-cell">{splitText(d.split)}</small>}
                      </td>
                      <td className="num">{d.visits}人</td>
                      <td className="num">{d.visits > 0 ? yen(Math.round(d.sales / d.visits)) : "—"}</td>
                    </>
                  ) : (
                    <td colSpan={3}>{d.holiday ? "休みの日" : "定休日"}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Fold>

      {sheet && (
        <DailySheet
          key={sheet.n}
          date={sheet.date}
          today={today}
          seed={seed}
          daily={daily}
          shop={shop}
          limits={limits}
          onClose={() => setSheet(null)}
          onDone={onDone}
        />
      )}
    </section>
  );
}
