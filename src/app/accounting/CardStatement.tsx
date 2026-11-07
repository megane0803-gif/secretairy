"use client";

// 経理タブの真ん中：カードと銀行の明細。AI の予想は使わない。
// つないでいない画面はアプリの中の架空の明細、freee（テスト事業所）とつないでいる時は freee から読んだ、まだ処理していない明細。
// freee から読めなかった時は、理由を出して止める（黙って架空の明細に切り替えない）。
// 出金：購入先ごとの自動のルールがある行はプログラムが仕分け、ルールの無い行だけ人が店用か私用を選ぶ。
// 人が選ぶ行は「初めての購入先」と「前にも仕分けた購入先」に分けて出す。「次から自動」の印は購入先ごと。
// 入金：見せるだけ（仕分けも登録もしない）。
// 承認BOXは使わない（ホームの「承認待ち」にも入れない）。登録は右の列の人のボタンだけ。

import { Checked, Fold } from "@/components/parts";
import { ACCT_CHOOSE_ID, ChooseLink } from "./ChooseLink";
import { FreeeConnectForm } from "./FreeePanel";
import { ACCOUNT_LABEL, SIDE_LABEL, type StatementRow } from "@/lib/accounting/rows";
import { md, yen } from "@/lib/accounting/sales";
import { merchantName, ruleLabel, USE_LABEL } from "@/lib/accounting/sort";
import { effectiveRules } from "@/lib/accounting/state";
import { useStatement } from "@/lib/accounting/useStatement";
import type { CardUse } from "@/lib/data/types";
import { FREEE_STATE_LABEL, stateOf } from "@/lib/freee/state";
import { listErrorText } from "@/lib/freee/useFreee";

type St = ReturnType<typeof useStatement>;

function UseButtons({ st, item }: { st: St; item: StatementRow }) {
  const cur = st.view.choices[item.key];
  const locked = st.locked(item.key);
  return (
    <span className="acct-use" role="group" aria-label={`${rowName(item)}は店用か私用か`}>
      {(["shop", "private"] as const).map((u: CardUse) => (
        <button
          key={u}
          type="button"
          className={cur === u ? `acct-use-btn on ${u}` : "acct-use-btn"}
          aria-pressed={cur === u}
          disabled={locked}
          onClick={() => st.choose(item.key, u)}
        >
          {USE_LABEL[u]}
        </button>
      ))}
    </span>
  );
}

/** 読み上げの名前（架空の明細は番号、freee の明細は日付と摘要） */
const rowName = (r: StatementRow) => (r.no !== null ? `${r.no}番` : `${md(r.date)}の${r.text}`);

function AutoNext({ st, merchantId }: { st: St; merchantId: string }) {
  const on = st.view.autoNext.includes(merchantId);
  return (
    <label className={on ? "acct-auto on" : "acct-auto"}>
      <input type="checkbox" checked={on} disabled={st.autoLocked} onChange={(e) => st.toggleAuto(merchantId, e.target.checked)} />
      次から自動
    </label>
  );
}

/** 行の頭：架空の明細は番号、どちらも口座と出金・入金の札 */
function RowHead({ item }: { item: StatementRow }) {
  return (
    <>
      {item.no !== null && (
        <span className="num acct-no">
          <strong>{item.no}</strong>番
        </span>
      )}
      <span className={`tag acct-acc acct-acc-${item.account}`}>{ACCOUNT_LABEL[item.account]}</span>
      <span className={item.side === "income" ? "tag ok" : "tag text"}>{SIDE_LABEL[item.side]}</span>
    </>
  );
}

/** freee の明細の記録の札（まだ以外） */
function StateTag({ st, item }: { st: St; item: StatementRow }) {
  if (st.view.mode !== "freee") return null;
  const s = stateOf(st.record, item.key);
  if (s === "pending") return null;
  return <span className={s === "registered" || s === "already" ? "tag ok" : "tag hold"}>{FREEE_STATE_LABEL[s]}</span>;
}

function Row({ st, item, withAuto }: { st: St; item: StatementRow; withAuto: boolean }) {
  return (
    <li className="acct-row">
      <RowHead item={item} />
      <span className="acct-merchant">{item.text}</span>
      <span className="num acct-date">{md(item.date)}</span>
      <span className="num acct-amount">{yen(item.amount)}</span>
      {item.side === "expense" && <UseButtons st={st} item={item} />}
      {withAuto && item.merchantId !== null && <AutoNext st={st} merchantId={item.merchantId} />}
      <StateTag st={st} item={item} />
    </li>
  );
}

/** 購入先ごとにまとめて出す。1件だけの購入先は行に「次から自動」、2件より多い購入先は見出しに1つ。購入先が決まらない行は1行ずつ */
function Group({ st, items, kind }: { st: St; items: StatementRow[]; kind: "fresh" | "known" }) {
  const { acct } = st;
  const merchants = [...new Set(items.map((i) => i.merchantId))];
  return (
    <ul className="acct-rows">
      {merchants.map((mid) => {
        const rows = items.filter((i) => i.merchantId === mid);
        if (mid === null) return rows.map((r) => <Row key={r.key} st={st} item={r} withAuto={false} />);
        const h = acct.seed.history.find((x) => x.merchantId === mid);
        const problem = st.view.gate.problems.find((p) => p.merchantId === mid)?.text;
        if (rows.length === 1 && kind === "fresh") return <Row key={mid} st={st} item={rows[0]} withAuto />;
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
              <AutoNext st={st} merchantId={mid} />
            </div>
            <ul className="acct-rows">
              {rows.map((i) => (
                <Row key={i.key} st={st} item={i} withAuto={false} />
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
  const st = useStatement();
  const { acct, view, phase } = st;
  const { seed, settings, state } = acct;
  const live = view.mode === "freee";
  const note = live ? settings.freee.statementNote : settings.statementNote;
  const range = phase.phase === "ok" ? phase.range : live ? null : { from: seed.statement.from, to: seed.statement.to };

  const head = (
    <>
      <h2 id="acct-card">カードと銀行の明細</h2>
      <p className="hint">
        {note}
        {range ? `（${md(range.from)}〜${md(range.to)}）` : ""}。来るのは口座・日付・入金か出金か・摘要（購入先や振込元）・金額だけで、品名はありません。
      </p>
    </>
  );

  if (phase.phase === "loading")
    return (
      <section className="acct-card-sec" aria-labelledby="acct-card">
        {head}
        <p className="hint" role="status">
          {settings.freee.label}から読んでいます…
        </p>
      </section>
    );
  if (phase.phase === "error")
    return (
      <section className="acct-card-sec" aria-labelledby="acct-card">
        {head}
        <div className="problems" role="alert">
          <p>{listErrorText(phase.reason, phase.reconnect)}</p>
          <p className="hint">アプリの中の明細には切り替えていません。</p>
          {phase.reconnect && <FreeeConnectForm label="もう一度 freee とつなぐ" />}
        </div>
      </section>
    );

  const { sorted } = view;
  const expenses = sorted.auto.length + sorted.fresh.length + sorted.known.length;
  const manual = sorted.fresh.length + sorted.known.length;
  const added = new Set(state.addedRules.map((r) => r.merchantId));
  const rules = live ? effectiveRules(seed.rules, state) : seed.rules;
  const shown = live ? effectiveRules(seed.rules, state) : acct.rules;

  return (
    <section className="acct-card-sec" aria-labelledby="acct-card">
      {head}
      {phase.phase === "ok" && phase.bank && (
        <p className="problems small" role="status">
          {phase.bank}
        </p>
      )}
      {phase.phase === "ok" && phase.capped && (
        <p className="problems small" role="status">
          多いので、新しい方から{settings.freee.maxListRows}件だけ出しています
        </p>
      )}

      <div className="karte-card acct-bigcard">
        <p className="ad-change">
          {/* 押せない「→」は外した（押せそうに見えるため）。人が選ぶ所へはリンクで飛ぶ */}
          <span>
            未処理 <strong className="num">{view.rows.length}</strong>件（出金 <span className="num">{expenses}</span>件・入金 <span className="num">{view.incomes.length}</span>件）：
          </span>
          <span>
            自動 <strong className="num">{sorted.auto.length}</strong>件・
            {manual > 0 ? (
              <ChooseLink>
                人が選ぶ <strong className="num">{manual}</strong>件 ↓
              </ChooseLink>
            ) : (
              <>
                人が選ぶ <strong className="num">{manual}</strong>件
              </>
            )}
          </span>
          {!live && state.registered && <span className="tag ok">登録済み</span>}
        </p>
        <p className="karte-why">
          出金のうち、購入先ごとの自動のルール（{rules.length}件）がある明細を、プログラムが店用・私用に分けました。ルールの無い購入先だけ人が選びます。入金は見せるだけです。
        </p>
        <Checked>AI の予想は使っていません（購入先のルールだけで分けています）</Checked>
      </div>

      {live && view.rows.length === 0 && <p className="hint">まだ処理していない明細はありません。</p>}

      <h3 className="acct-h3" id={ACCT_CHOOSE_ID}>
        人が選ぶ {manual}件
      </h3>
      <p className="hint">1行ずつ「店用」か「私用」を押します。「次から自動」に印を付けた購入先は、登録のときに自動のルールに足します（今回の印で）。</p>
      {live && <p className="hint">摘要に購入先の名前がちょうど1つ入っている明細だけ、その購入先のルールを使います（0か2つ以上なら人が選びます）。</p>}
      <h4 className="acct-h4">初めての購入先（{sorted.fresh.length}件）</h4>
      <Group st={st} items={sorted.fresh} kind="fresh" />
      <h4 className="acct-h4">前にも仕分けた購入先（{sorted.known.length}件）</h4>
      <p className="hint">前の月までに店用と私用の両方があったので、自動のルールがありません。</p>
      <Group st={st} items={sorted.known} kind="known" />

      <h3 className="acct-h3">入金（見るだけ）{view.incomes.length}件</h3>
      <p className="hint">{live ? settings.freee.incomeNote : settings.incomeNote}</p>
      {view.incomes.length > 0 && (
        <ul className="acct-rows">
          {view.incomes.map((i) => (
            <Row key={i.key} st={st} item={i} withAuto={false} />
          ))}
        </ul>
      )}

      <Fold summary={`自動で仕分けた ${sorted.auto.length}件（くわしく）`}>
        <div className="ad-scroll">
          <table className="table acct-table">
            <thead>
              <tr>
                {!live && <th className="num">番号</th>}
                <th>口座</th>
                <th>日付</th>
                <th>入金か出金か</th>
                <th>摘要</th>
                <th className="num">金額</th>
                <th>仕分け</th>
              </tr>
            </thead>
            <tbody>
              {sorted.auto.map(({ item, use }) => (
                <tr key={item.key}>
                  {!live && <td className="num">{item.no}番</td>}
                  <td>{ACCOUNT_LABEL[item.account]}</td>
                  <td>{md(item.date)}</td>
                  <td>{SIDE_LABEL[item.side]}</td>
                  <td>{item.text}</td>
                  <td className="num">{yen(item.amount)}</td>
                  <td>
                    <span className={`tag use-${use}`}>{USE_LABEL[use]}</span> ✓ ルール <StateTag st={st} item={item} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Fold>
      <Fold summary={`自動のルール（購入先ごと・${shown.length}件）`}>
        <ul className="acct-rules">
          {shown.map((r) => (
            <li key={r.merchantId}>
              {ruleLabel(seed.merchants, r)}
              {added.has(r.merchantId) ? <span className="tag own">今回足した</span> : <span className="tag text">前の月まで</span>}
            </li>
          ))}
        </ul>
        <p className="hint">
          足した自動のルールは、次の明細からすぐ効きます{live ? "（freee から読んだ明細にも）" : ""}。ホームの「最初に戻す」で前の月までの{seed.rules.length}件に戻ります。
        </p>
      </Fold>
    </section>
  );
}
