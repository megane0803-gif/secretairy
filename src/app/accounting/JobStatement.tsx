"use client";

// ホームの「AI の仕事」で届いた新しい明細（経理の「次の明細（試し）」の架空の明細）。
// いま効く自動のルール（登録で足した分も）で分けた結果を並べ、迷う物（人が選ぶ）を上に出す。AI は使わない。
// 試しの明細なので、ここからは登録しない（本当に登録するのはまだ。docs/SPEC.md §9.3）。

import { md, yen } from "@/lib/accounting/sales";
import { merchantName, USE_LABEL } from "@/lib/accounting/sort";
import { useAccounting } from "@/lib/accounting/useAccounting";
import { cardSorted } from "@/lib/jobs/run";
import { useJobs } from "@/lib/jobs/useJobs";

export function JobStatement() {
  const jobs = useJobs();
  const { seed, state } = useAccounting();
  const done = jobs.done.card;
  if (!done) return null;
  const c = cardSorted(seed, state);
  const manual = new Set([...c.sorted.fresh, ...c.sorted.known].map((i) => i.no));
  const items = [...seed.trial.items].sort((a, b) => Number(manual.has(b.no)) - Number(manual.has(a.no)) || a.no - b.no);
  return (
    <section className="inline-box" aria-labelledby="job-statement">
      <h2 id="job-statement">
        新しい明細（AI の仕事から）
      </h2>
      <p className="ad-change">
        <span>
          届いた <strong className="num">{c.total}</strong>件
        </span>
        <span className="arrow" aria-hidden>
          →
        </span>
        <span>
          自動 <strong className="num">{c.auto}</strong>件・迷う物 <strong className="num">{c.manual}</strong>件
        </span>
      </p>
      <ul className="acct-trial-rows">
        {items.map((i) => {
          const a = c.sorted.auto.find((x) => x.item.no === i.no);
          return (
            <li key={i.no}>
              <span>
                {md(i.date)} {merchantName(seed.merchants, i.merchantId)} <span className="num">{yen(i.amount)}</span>
              </span>
              {a ? (
                <span className={`tag use-${a.use}`}>
                  自動：{USE_LABEL[a.use]}
                  {c.sorted.byAdded.includes(i.no) && "（足したルール）"}
                </span>
              ) : (
                <span className="tag hold">迷う物（人が選ぶ）</span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="hint">
        {md(seed.trial.from)}〜{md(seed.trial.to)}の架空の明細です。試しなので登録はしません。
      </p>
    </section>
  );
}
