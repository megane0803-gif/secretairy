"use client";

// 経理タブの右の列：プログラムの門（✓ 2つ）→「会計に登録」（人のボタン）→ 会計の欄。
// 登録の後は「次の明細（試し）」で、足した自動のルールが次から効くことを見せる（試しなので登録はしない）。
// 承認の箱は使わない（ホームの「承認待ち」にも入れない）。
//
// 🔒 確定は人：登録は、人が画面のボタンを押したとき（isTrusted）だけ。AI・自動の処理からは呼ばない。

import { useState } from "react";
import { BigNumber, Fold } from "@/components/parts";
import { md, yen } from "@/lib/accounting/sales";
import { merchantName, USE_LABEL } from "@/lib/accounting/sort";
import { register, registrationMessage, sortTrial } from "@/lib/accounting/state";
import { useAccounting } from "@/lib/accounting/useAccounting";
import type { useFreee } from "@/lib/freee/useFreee";
import { writeJournal, type JournalWho } from "@/lib/journal";
import { DEMO_TAG_NOTE } from "@/lib/notices";
import { FreeeConnectForm, useCallbackNote } from "./FreeePanel";

/** freee（テスト事業所）とつながっていない画面（cookie が無い・審査員の画面も）。今のまま会計に登録する */
export function RegisterPanel({ freee }: { freee: ReturnType<typeof useFreee> }) {
  const callbackNote = useCallbackNote();
  // 「freee とつなぐ」は、本番のサイトで freee の環境変数がそろっている時だけ出す（cookie が無い・鍵が切れた・事業所の番号がまだ空）
  // cookie が無い・切れた時も出す。環境変数が本当に欠けている時は、読めていない名前も出す
  const canConnect = freee.canConnect;
  const acct = useAccounting();
  const { seed, settings, state, gate } = acct;
  const [trial, setTrial] = useState(false);
  const reg = state.registered;

  const onRegister = (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted) return;
    let journal: { who: JournalWho; text: string }[] = [];
    acct.update((s) => {
      const res = register(seed, s, { nowIso: new Date().toISOString(), service: settings.service });
      if (!res.ok) return s;
      journal = res.journal;
      return res.state;
    });
    writeJournal(...journal);
  };

  const t = reg && trial ? sortTrial(seed, state) : null;
  const tManual = t ? [...t.fresh, ...t.known] : [];

  return (
    <div className="ad-review">
      {!reg && (
        <>
          <p className="acct-left" role="status">
            {gate.remaining > 0 ? (
              <>
                あと <strong className="num">{gate.remaining}</strong>件 選ぶ
              </>
            ) : (
              "全部選びました"
            )}
          </p>
          <strong>プログラムの確認</strong>
          <ul className="gate">
            {gate.checks.map((c) => {
              // 印が分かれて止めたときは ✗、まだ選び終わっていないだけのときは「・」
              const stopped = !c.ok && c.id === "autoAligned" && gate.problems.length > 0;
              return (
                <li key={c.id} className={c.ok ? "ok" : stopped ? "ng" : "skip"}>
                  {c.ok ? "✓" : stopped ? "✗" : "・"} {c.label}
                </li>
              );
            })}
          </ul>
          {gate.problems.map((p) => (
            <p key={p.merchantId} className="problems" role="alert">
              ✗ {p.text}
            </p>
          ))}
          <button type="button" className="btn primary big" onClick={onRegister} disabled={!gate.ok}>
            {settings.service}に登録
          </button>
          <p className="hint">選び終わるまで押せません。押すと、自動の分と人が選んだ分をまとめて{settings.service}に登録します。</p>
        </>
      )}

      <section className="acct-service" aria-labelledby="acct-service">
        <h3 id="acct-service" className="acct-h3">
          {settings.service}の欄
          {reg && <span className="tag ok">登録済み</span>}
        </h3>
        {reg ? (
          <>
            <BigNumber label="登録した明細" value={reg.total} unit="件" />
            <p className="checked" role="status">
              <span aria-hidden>✓</span> {registrationMessage(seed, reg)}
            </p>
            <p className="hint">
              店用 {yen(reg.shopAmount)}・私用 {yen(reg.privateAmount)}
            </p>
          </>
        ) : (
          <p className="hint">まだ登録していません（未処理 {seed.statement.items.length}件）。本物の会計にはつながっていません。</p>
        )}
        <p>
          <span className="tag text wrap">{settings.freee.unconnectedNote}</span>
        </p>
      </section>
      {callbackNote && (
        <p className="hint" role="status">
          {callbackNote}
        </p>
      )}
      {canConnect && !reg && (
        <Fold summary="オーナー用">
          <FreeeConnectForm label="freee とつなぐ" />
          <p className="hint">許可の画面で、テスト事業所を選んでください。ほかの事業所を選ぶと、鍵を捨てて止めます。</p>
          {freee.missing.length > 0 && (
            <p className="problems small" role="alert">
              サーバーが次の環境変数を読めていません：{freee.missing.join("・")}。このままでは、つなぐ所で止まります。
            </p>
          )}
        </Fold>
      )}

      {reg && (
        <>
          <p className="demo-row">
            {/* 「次の明細（試し）」は試すための物なので「デモ」の札を付ける */}
            <span className="tag text" title={DEMO_TAG_NOTE}>
              デモ<span className="sr-only">（{DEMO_TAG_NOTE}）</span>
            </span>
            <button type="button" className="btn" onClick={() => setTrial(true)} disabled={trial}>
              次の明細（試し）
            </button>
          </p>
          {t && (
            <div className="acct-trial" role="status">
              <p className="ad-change">
                <span>
                  試し <strong className="num">{seed.trial.items.length}</strong>件
                </span>
                <span className="arrow" aria-hidden>
                  →
                </span>
                <span>
                  自動 <strong className="num">{t.auto.length}</strong>件・人が選ぶ <strong className="num">{tManual.length}</strong>件
                </span>
              </p>
              <ul className="acct-trial-rows">
                {seed.trial.items.map((i) => {
                  const a = t.auto.find((x) => x.item.no === i.no);
                  return (
                    <li key={i.no}>
                      <span>
                        {md(i.date)} {merchantName(seed.merchants, i.merchantId)} <span className="num">{yen(i.amount)}</span>
                      </span>
                      {a ? (
                        <span className={`tag use-${a.use}`}>
                          自動：{USE_LABEL[a.use]}
                          {t.byAdded.includes(i.no) && "（足したルール）"}
                        </span>
                      ) : (
                        <span className="tag hold">人が選ぶ</span>
                      )}
                    </li>
                  );
                })}
              </ul>
              <p className="hint">
                {md(seed.trial.from)}〜{md(seed.trial.to)}の架空の明細です。試しなので登録はしません。
              </p>
            </div>
          )}
        </>
      )}
      <p className="hint">ホームの「最初に戻す」で、選んだ印・登録・足した自動のルールも最初に戻ります。</p>
    </div>
  );
}
