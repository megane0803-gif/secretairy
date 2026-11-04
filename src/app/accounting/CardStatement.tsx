"use client";

// 経理タブの真ん中：通販の明細（架空）。AI の予想は使わない。
// 購入先ごとの自動のルールがある行はプログラムが仕分け、ルールの無い行だけ人が店用か私用を選ぶ。
// 人が選ぶ行は「初めての購入先」と「前にも仕分けた購入先」に分けて出す。「次から自動」の印は購入先ごと。
// 承認の箱は使わない（ホームの「承認待ち」にも入れない）。登録は右の列の人のボタンだけ。

import { Checked, Fold } from "@/components/parts";
import { md, yen } from "@/lib/accounting/sales";
import { merchantName, ruleLabel, USE_LABEL } from "@/lib/accounting/sort";
import { withAutoNext, withChoice } from "@/lib/accounting/state";
import { useAccounting } from "@/lib/accounting/useAccounting";
import type { CardItem, CardUse } from "@/lib/data/types";

type Acct = ReturnType<typeof useAccounting>;

function UseButtons({ acct, item }: { acct: Acct; item: CardItem }) {
  const cur = acct.state.choices[String(item.no)];
  const locked = !!acct.state.registered;
  const pick = (use: CardUse) => acct.update((s) => withChoice(acct.seed, s, item.no, use));
  return (
    <span className="acct-use" role="group" aria-label={`${item.no}番は店用か私用か`}>
      {(["shop", "private"] as const).map((u) => (
        <button
          key={u}
          type="button"
          className={cur === u ? `acct-use-btn on ${u}` : "acct-use-btn"}
          aria-pressed={cur === u}
          disabled={locked}
          onClick={() => pick(u)}
        >
          {USE_LABEL[u]}
        </button>
      ))}
    </span>
  );
}

function AutoNext({ acct, merchantId }: { acct: Acct; merchantId: string }) {
  const on = acct.state.autoNext.includes(merchantId);
  return (
    <label className={on ? "acct-auto on" : "acct-auto"}>
      <input
        type="checkbox"
        checked={on}
        disabled={!!acct.state.registered}
        onChange={(e) => acct.update((s) => withAutoNext(acct.seed, s, merchantId, e.target.checked))}
      />
      次から自動
    </label>
  );
}

function Row({ acct, item, withAuto }: { acct: Acct; item: CardItem; withAuto: boolean }) {
  return (
    <li className="acct-row">
      <span className="num acct-no">
        <strong>{item.no}</strong>番
      </span>
      <span className="acct-merchant">{merchantName(acct.seed.merchants, item.merchantId)}</span>
      <span className="num acct-date">{md(item.date)}</span>
      <span className="num acct-amount">{yen(item.amount)}</span>
      <UseButtons acct={acct} item={item} />
      {withAuto && <AutoNext acct={acct} merchantId={item.merchantId} />}
    </li>
  );
}

/** 購入先ごとにまとめて出す。1件だけの購入先は行に「次から自動」、2件より多い購入先は見出しに1つ */
function Group({ acct, items, kind }: { acct: Acct; items: CardItem[]; kind: "fresh" | "known" }) {
  const merchants = [...new Set(items.map((i) => i.merchantId))];
  return (
    <ul className="acct-rows">
      {merchants.map((mid) => {
        const rows = items.filter((i) => i.merchantId === mid);
        const h = acct.seed.history.find((x) => x.merchantId === mid);
        const problem = acct.gate.problems.find((p) => p.merchantId === mid)?.text;
        if (rows.length === 1 && kind === "fresh") return <Row key={mid} acct={acct} item={rows[0]} withAuto />;
        return (
          <li key={mid} className={problem ? "acct-merchant-box ng" : "acct-merchant-box"}>
            <div className="acct-merchant-head">
              <strong>{merchantName(acct.seed.merchants, mid)}</strong>
              <span className="hint">今回 {rows.length}件</span>
              {h && (
                <span className="hint">
                  前の月まで：店用 {h.shop}件・私用 {h.private}件
                </span>
              )}
              <AutoNext acct={acct} merchantId={mid} />
            </div>
            <ul className="acct-rows">
              {rows.map((i) => (
                <Row key={i.no} acct={acct} item={i} withAuto={false} />
              ))}
            </ul>
            {problem && (
              <p className="problems small" role="alert">
                {problem}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function CardStatement() {
  const acct = useAccounting();
  const { seed, settings, sorted, state } = acct;
  const total = seed.statement.items.length;
  const manual = sorted.fresh.length + sorted.known.length;
  const added = new Set(state.addedRules.map((r) => r.merchantId));

  return (
    <section className="acct-card-sec" aria-labelledby="acct-card">
      <h2 id="acct-card">
        通販の明細 <span className="tag fictional">架空</span>
      </h2>
      <p className="hint">
        {settings.service}が{settings.cardSource}から取り込んだ、未処理の明細（{md(seed.statement.from)}〜{md(seed.statement.to)}）。来るのは日付・購入先・金額だけで、品名はありません。
      </p>

      <div className="karte-card acct-bigcard">
        <p className="ad-change">
          <span>
            未処理 <strong className="num">{total}</strong>件
          </span>
          <span className="arrow" aria-hidden>
            →
          </span>
          <span>
            自動 <strong className="num">{sorted.auto.length}</strong>件・人が選ぶ <strong className="num">{manual}</strong>件
          </span>
          {state.registered && <span className="tag ok">登録済み</span>}
        </p>
        <p className="karte-why">購入先ごとの自動のルール（{seed.rules.length}件）がある明細を、プログラムが店用・私用に分けました。ルールの無い購入先だけ人が選びます。</p>
        <Checked>AI の予想は使っていません（購入先のルールだけで分けています）</Checked>
      </div>

      <h3 className="acct-h3">人が選ぶ {manual}件</h3>
      <p className="hint">1行ずつ「店用」か「私用」を押します。「次から自動」に印を付けた購入先は、登録のときに自動のルールに足します（今回の印で）。</p>
      <h4 className="acct-h4">初めての購入先（{sorted.fresh.length}件）</h4>
      <Group acct={acct} items={sorted.fresh} kind="fresh" />
      <h4 className="acct-h4">前にも仕分けた購入先（{sorted.known.length}件）</h4>
      <p className="hint">前の月までに店用と私用の両方があったので、自動のルールがありません。</p>
      <Group acct={acct} items={sorted.known} kind="known" />

      <Fold summary={`自動で仕分けた ${sorted.auto.length}件（くわしく）`}>
        <div className="ad-scroll">
          <table className="table acct-table">
            <thead>
              <tr>
                <th className="num">番号</th>
                <th>購入先</th>
                <th>日付</th>
                <th className="num">金額</th>
                <th>仕分け</th>
              </tr>
            </thead>
            <tbody>
              {sorted.auto.map(({ item, use }) => (
                <tr key={item.no}>
                  <td className="num">{item.no}番</td>
                  <td>{merchantName(seed.merchants, item.merchantId)}</td>
                  <td>{md(item.date)}</td>
                  <td className="num">{yen(item.amount)}</td>
                  <td>
                    <span className={`tag use-${use}`}>{USE_LABEL[use]}</span> ✓ ルール
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Fold>
      <Fold summary={`自動のルール（購入先ごと・${acct.rules.length}件）`}>
        <ul className="acct-rules">
          {acct.rules.map((r) => (
            <li key={r.merchantId}>
              {ruleLabel(seed.merchants, r)}
              {added.has(r.merchantId) ? <span className="tag own">今回足した</span> : <span className="tag text">前の月まで</span>}
            </li>
          ))}
        </ul>
        <p className="hint">足した自動のルールは、次の明細からすぐ効きます。ホームの「最初に戻す」で前の月までの{seed.rules.length}件に戻ります。</p>
      </Fold>
    </section>
  );
}
