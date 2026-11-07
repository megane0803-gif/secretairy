"use client";

// 予約サイト。台帳の横に並べる、お客様が見る空き状況のつもりの画面。
// 台帳 → 予約サイト：台帳で「確定」した予約を受け取り、その枠を塞ぐ。仮押さえは送らない。
// 予約サイト → 台帳：「ここで予約が入る（デモ）」で、架空のお客様が自分で決めた予約が1件、空いている枠に入る
// （承認BOXは通さずに確定で台帳へ。札は「予約サイトから」。src/lib/book/site.ts）。AI は使わない。
// 「仮押さえと同じ枠に入れる（デモ）」は二重予約を防ぐ見せ場：その仮押さえを外し、ToDo に「別の日時を案内」を足す。
// 空き表のマスをオーナーが押すと、その時間を「ネットでは受けない」（止）にする・戻す（book/siteStops.ts）。効くのは予約サイトだけ。

import { useState } from "react";
import { toHHMM, toMinutes, weekFrom } from "@/lib/calendar";
import type { BookData } from "@/lib/book/data";
import { siteBook, siteCount, type SiteMode, type SiteOutcome } from "@/lib/book/site";
import { useBook } from "@/lib/book/useBook";
import { writeJournal } from "@/lib/journal";
import { useRules } from "@/lib/rules/useRules";
import { SAVE_FAILED_MESSAGE } from "@/lib/browser";
import { isStopped, siteStep, siteStopJournal } from "@/lib/book/siteStops";
import { useSiteStops } from "@/lib/book/useSiteStops";

export function BookingSite({ data }: { data: BookData }) {
  const book = useBook(data);
  const { rules } = useRules(data.seedRules);
  const { stops, toggle } = useSiteStops();
  const [note, setNote] = useState<string | null>(null);
  const holds = book.pending.length;
  const received = siteCount(book.state);

  // 押されたのは本物の操作の時だけ（デモのボタン。お客様が予約サイトで決めたつもり）
  const press = (mode: SiteMode) => (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    let out: SiteOutcome | null = null;
    const w = book.update((s) => {
      out = siteBook(s, { data: book.data, rules, now: new Date(), stops }, mode);
      return out.state;
    });
    const o = out as SiteOutcome | null;
    if (!o) return;
    // 書けなかった時は「入りました」と言わない（日誌も書かない。直しA の形）
    if (o.ok && !w.ok) return setNote(SAVE_FAILED_MESSAGE);
    if (o.ok) writeJournal(...o.journal);
    setNote(o.ok ? o.message : o.note);
  };
  // 休みの日（予約のページで決めた分）も「休」にする
  const days = weekFrom(book.shop, book.today);
  const confirmed = book.all.filter((r) => r.status === "confirmed");
  const opens = days.filter((d) => d.hours).map((d) => toMinutes(d.hours!.open));
  const closes = days.filter((d) => d.hours).map((d) => toMinutes(d.hours!.close));
  const from = opens.length ? Math.min(...opens) : 600;
  const to = closes.length ? Math.max(...closes) : 1200;
  const step = siteStep(data.shop);
  const times: number[] = [];
  for (let t = from; t < to; t += step) times.push(t);
  const nowMin = toMinutes(book.now.time);
  const fresh = confirmed.filter((r) => r.source === "chat" && r.date >= book.today.date).length;
  const stoppedAhead = stops.filter((k) => k.slice(0, 10) >= book.now.date).length;

  // オーナーがマスを押した：その時間をネットでは受けないにする・戻す（日誌に1行）
  const flip = (e: React.MouseEvent, date: string, label: string, t: number) => {
    if (!e.nativeEvent.isTrusted) return;
    const start = toHHMM(t);
    const on = !isStopped(stops, date, start);
    const w = toggle(date, start, on);
    if (!w) return;
    if (!w.ok) return setNote(SAVE_FAILED_MESSAGE);
    writeJournal({ who: "オーナー", text: siteStopJournal(label, start, toHHMM(t + step), on) });
    setNote(on ? `${label} ${start}–${toHHMM(t + step)} をネットでは受けないにしました（もう一度押すと戻ります）` : `${label} ${start}–${toHHMM(t + step)} のネットの受付を戻しました`);
  };

  return (
    <section className="site" aria-label="予約サイト">
      <div className="site-head">
        <strong>{data.shop.name} 予約サイト</strong>
      </div>
      <p className="hint">
        台帳で確定した予約を受け取って、枠を塞ぎます。仮押さえは送りません。予約サイトでお客様が決めた予約は、承認BOXを通さずに台帳へ入ります（予約サイト → 台帳）。
      </p>
      <div className="site-demo">
        <button type="button" className="btn small" onClick={press("free")}>
          ここで予約が入る（デモ）
        </button>
        <button
          type="button"
          className="btn small"
          onClick={press("onHold")}
          disabled={holds === 0}
          title={holds === 0 ? "予約チャットで仮押さえをすると押せます" : "いちばん古い仮押さえと同じ枠に入れます"}
        >
          仮押さえと同じ枠に入れる（デモ）
        </button>
      </div>
      {note && (
        <p className="hint site-demo-note" role="status">
          {note}
        </p>
      )}
      <div className="site-scroll">
        <table className="site-grid">
          <thead>
            <tr>
              <th scope="col">時刻</th>
              {days.map((d) => (
                <th key={d.date} scope="col">
                  {d.label.replace(/（.）/, "")}
                  <br />
                  <small>{d.label.match(/（(.)）/)?.[1]}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {times.map((t) => (
              <tr key={t}>
                <th scope="row" className="num">
                  {toHHMM(t)}
                </th>
                {days.map((d) => {
                  if (!d.hours) return <td key={d.date} className="off" aria-label="お休み">休</td>;
                  const open = toMinutes(d.hours.open);
                  const close = toMinutes(d.hours.close);
                  if (t < open || t >= close) return <td key={d.date} className="off">–</td>;
                  if (d.date === book.now.date && t + step <= nowMin) return <td key={d.date} className="off">–</td>;
                  const here = confirmed.filter((r) => r.date === d.date && r.startMin < t + step && t < r.endMin);
                  const left = Math.max(0, book.shop.seats - here.length);
                  const byChat = here.some((r) => r.source === "chat");
                  const bySite = here.some((r) => r.source === "site");
                  const stopped = isStopped(stops, d.date, toHHMM(t));
                  const mark = stopped ? "止" : left === 0 ? "×" : left < book.shop.seats ? "△" : "○";
                  const title = `${d.label} ${toHHMM(t)}：${stopped ? "ネットでは受けない（押すと戻す）" : `のこり${left}席（押すとネットでは受けないにする）`}${byChat ? "（承認で確定した予約が入っています）" : ""}${bySite ? "（この予約サイトで入った予約があります）" : ""}`;
                  return (
                    <td
                      key={d.date}
                      className={[stopped ? "stopped" : left === 0 ? "full" : left < book.shop.seats ? "few" : "free", byChat ? "bychat" : "", bySite ? "bysite" : ""].join(" ").trim()}
                    >
                      <button type="button" className="site-cell" onClick={(e) => flip(e, d.date, d.label, t)} aria-pressed={stopped} aria-label={title} title={title}>
                        {mark}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="site-legend">
        ○ 空き　△ のこりわずか　× 満席　止 ネットでは受けない（オーナーが止めた時間。マスを押すと止める・戻す。予約サイトだけに効き、予約チャットと台帳から入れる予約はそのまま）　<span className="bychat-key">太枠</span> 承認で確定した予約が入った枠　<u className="bysite-key">点線の下線</u> この予約サイトで入った枠
        {stoppedAhead > 0 && (
          <>
            （止めた時間 <strong className="num">{stoppedAhead}</strong> マス）
          </>
        )}
        {fresh > 0 && (
          <>
            （<strong className="num">{fresh}</strong> 件受け取り済み）
          </>
        )}
        {received > 0 && (
          <>
            （予約サイトから <strong className="num">{received}</strong> 件入った）
          </>
        )}
      </p>
    </section>
  );
}
