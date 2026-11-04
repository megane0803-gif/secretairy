"use client";

// 経理タブのいちばん上：架空の1か月の売上。見るだけで、どこにも送らない。
// 大きい数字3つ（売上・来店・客単価）・日ごとの小さい棒（定休日は点。押すとその日の売上と来店）・支払い方法の割合の棒。
// 数はどれもプログラムが日ごとの数から出す（AI は使わない）。

import { useMemo, useState } from "react";
import { BigNumber, Fold, MiniBar } from "@/components/parts";
import { summarizeSales, yen } from "@/lib/accounting/sales";
import { getAccounting } from "@/lib/data/seed";
import { getShop } from "@/lib/settings";

export function SalesReport() {
  const s = useMemo(() => summarizeSales(getAccounting().sales, getShop()), []);
  const [pick, setPick] = useState<string | null>(null);
  const picked = s.days.find((d) => d.date === pick);

  return (
    <section className="acct-sales" aria-labelledby="acct-sales">
      <h2 id="acct-sales">
        {s.month}月の売上 <span className="tag fictional">架空</span>
      </h2>
      <p className="hint">見るだけです（どこにも送りません）。数はどれもプログラムが日ごとの数から出しています。</p>
      <div className="bignums">
        <BigNumber label="売上" value={s.total} unit="円" />
        <BigNumber label="来店" value={s.visits} unit="人" />
        <BigNumber label="客単価" value={s.perVisit} unit="円" />
      </div>

      <h3 className="acct-h3">日ごとの売上</h3>
      <div className="daybars" role="group" aria-label={`${s.month}月の日ごとの売上（棒を押すと、その日の売上と来店）`}>
        {s.days.map((d) =>
          d.open ? (
            <button
              key={d.date}
              type="button"
              className={pick === d.date ? "daybar on" : "daybar"}
              aria-pressed={pick === d.date}
              aria-label={`${d.label} 売上 ${yen(d.sales)}・来店 ${d.visits}人`}
              title={`${d.label} ${yen(d.sales)}`}
              onClick={() => setPick(pick === d.date ? null : d.date)}
            >
              <span style={{ height: `${s.maxDay > 0 ? Math.max(4, Math.round((d.sales / s.maxDay) * 100)) : 0}%` }} />
            </button>
          ) : (
            <span key={d.date} className="daybar closed" role="img" aria-label={`${d.label} 定休日`} title={`${d.label} 定休日`}>
              <i />
            </span>
          ),
        )}
      </div>
      <div className="daybars-labels" aria-hidden>
        {s.days.map((d) => (
          <span key={d.date}>{d.day === 1 || d.day % 5 === 0 ? d.day : ""}</span>
        ))}
      </div>
      <p className="acct-pickday" role="status">
        {picked ? (
          <>
            <strong>{picked.label}</strong> 売上 <strong className="num">{yen(picked.sales)}</strong>・来店 <strong className="num">{picked.visits}人</strong>
          </>
        ) : (
          <span className="hint">棒を押すと、その日の売上と来店が出ます。点は定休日です。</span>
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

      <Fold summary="表で見る（日ごとの売上）">
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
                <tr key={d.date} className={d.open ? undefined : "off"}>
                  <td>{d.label}</td>
                  {d.open ? (
                    <>
                      <td className="num">{yen(d.sales)}</td>
                      <td className="num">{d.visits}人</td>
                      <td className="num">{d.visits > 0 ? yen(Math.round(d.sales / d.visits)) : "—"}</td>
                    </>
                  ) : (
                    <td colSpan={3}>定休日</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Fold>
    </section>
  );
}
