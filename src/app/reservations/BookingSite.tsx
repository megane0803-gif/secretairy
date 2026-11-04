"use client";

// 予約サイト（架空）。台帳の横に並べる、お客様が見る空き状況のつもりの画面。
// 今は台帳 → 予約サイトの片方向だけ：台帳で「確定」した予約を受け取り、その枠を塞ぐ。仮押さえはまだ送らない。

import { toHHMM, toMinutes, weekFrom } from "@/lib/calendar";
import type { BookData } from "@/lib/book/data";
import { useBook } from "@/lib/book/useBook";

export function BookingSite({ data }: { data: BookData }) {
  const book = useBook(data);
  const days = weekFrom(data.shop, book.today);
  const confirmed = book.all.filter((r) => r.status === "confirmed");
  const opens = days.filter((d) => d.hours).map((d) => toMinutes(d.hours!.open));
  const closes = days.filter((d) => d.hours).map((d) => toMinutes(d.hours!.close));
  const from = opens.length ? Math.min(...opens) : 600;
  const to = closes.length ? Math.max(...closes) : 1200;
  const step = Math.max(15, data.shop.slotMinutes);
  const times: number[] = [];
  for (let t = from; t < to; t += step) times.push(t);
  const nowMin = toMinutes(book.now.time);
  const fresh = confirmed.filter((r) => r.source === "chat" && r.date >= book.today.date).length;

  return (
    <section className="site" aria-label="予約サイト（架空）">
      <div className="site-head">
        <strong>{data.shop.name} 予約サイト</strong>
        <span className="tag fictional">架空</span>
      </div>
      <p className="hint">台帳で確定した予約を受け取って、枠を塞ぎます（台帳 → 予約サイトの片方向）。仮押さえは送りません。</p>
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
                  const mark = left === 0 ? "×" : left < book.shop.seats ? "△" : "○";
                  return (
                    <td
                      key={d.date}
                      className={[left === 0 ? "full" : left < book.shop.seats ? "few" : "free", byChat ? "bychat" : ""].join(" ").trim()}
                      title={`${d.label} ${toHHMM(t)}：のこり${left}席${byChat ? "（承認で確定した予約が入っています）" : ""}`}
                    >
                      {mark}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="site-legend">
        ○ 空き　△ のこりわずか　× 満席　<span className="bychat-key">太枠</span> 承認で確定した予約が入った枠
        {fresh > 0 && (
          <>
            （<strong className="num">{fresh}</strong> 件受け取り済み）
          </>
        )}
      </p>
    </section>
  );
}
