"use client";

// 経理タブの右の列：freee（テスト事業所）につながっている時（オーナーのブラウザだけ）。
// 人が仕分けて「登録」を押した分だけを、freee の明細から取引として登録する（freee の側でも明細が処理済みになる）。
// AI は使わない。科目も金額もプログラムと設定が決める（金額は明細のまま・科目と税区分は config/accounting.json）。
//
// 🔒 確定は人：登録は、人が画面のボタンを押したとき（isTrusted）だけ。1件ずつ順に送る。
// 送り始めたら、明細と店用／私用の選びを固定する。送っている間は、登録のし直しと「最初に戻す」を止める。
// つながりが切れても、途中の登録を黙って会計（架空）に切り替えない。

import { ChooseLink } from "./ChooseLink";
import { useEffect, useState } from "react";
import { BigNumber, Fold } from "@/components/parts";
import { md, yen } from "@/lib/accounting/sales";
import { merchantName, ruleLabel, USE_LABEL } from "@/lib/accounting/sort";
import { usesOf, withRulesFromFreee } from "@/lib/accounting/state";
import { useAccounting } from "@/lib/accounting/useAccounting";
import { countsOf, dealIdsOf, FREEE_STATE_LABEL, stateOf } from "@/lib/freee/state";
import { readFreeeRecord, type useFreee } from "@/lib/freee/useFreee";
import type { MerchantRule } from "@/lib/data/types";
import { writeJournal } from "@/lib/journal";

type Freee = ReturnType<typeof useFreee>;

/** 「14:05」 */
function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : iso;
}

/** 「freee とつなぐ」：form で送る（サーバーが許可の画面へ 303 で送る） */
export function FreeeConnectForm({ label }: { label: string }) {
  return (
    <form method="post" action="/api/freee/start" className="freee-connect">
      <button type="submit" className="btn">
        {label}
      </button>
    </form>
  );
}

const CALLBACK_NOTE: Record<string, string> = {
  connected: "freee（テスト事業所）とつなぎました。",
  state: "許可の合図が合わない・期限が過ぎたので止めました。もう一度つないでください。",
  denied: "freee で許可されなかったので、つないでいません。",
  failed: "freee から鍵を受け取れませんでした。もう一度つないでください。",
  "no-company": "鍵の返事に事業所の番号が無かったので、鍵を捨てて止めました。",
  "wrong-company": "テスト事業所ではない事業所が選ばれたので、鍵を捨てて止めました。",
};

/** freee の許可から戻った時の1行（?freee=…） */
export function useCallbackNote(): string | null {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get("freee");
    // 画面を開いた後にだけ読む（サーバーの描画と合わせる）
    if (c && CALLBACK_NOTE[c]) setNote(CALLBACK_NOTE[c]);
  }, []);
  return note;
}

export function FreeePanel({ freee }: { freee: Freee }) {
  const acct = useAccounting();
  const { seed, gate, state } = acct;
  const { record, status, settings, sending } = freee;
  const callbackNote = useCallbackNote();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nos = seed.statement.items.map((i) => i.no);
  const counts = countsOf(record, nos);
  const connected = status === "connected";
  const done = counts.registered + counts.already;
  const left = nos.length - done;
  const uses = record.uses ?? usesOf(seed, state);
  const canChoose = !record.uses; // 送り始める前だけ、選びが要る
  const needsCheck = counts.unknown > 0 || counts.failed > 0;

  const onImport = async (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted || busy || sending || freee.importWait) return;
    setBusy(true);
    setNote("freee から読み直して、まだ無い明細だけ入れています…");
    const r = await freee.importStatements();
    setBusy(false);
    if (!r.ok) {
      setNote(r.reason);
      return;
    }
    const head = `入れた ${r.created}件・もうあった ${r.existed}件${r.check ? `・確かめが要る ${r.check}件（入れていません）` : ""}`;
    if (r.holdUntil) setNote(`${head}。${r.stopped ?? ""}。${timeOf(r.holdUntil)}まで待ってから、もう一度押してください（freee から読み直して、まだ無い物だけ入れます）`);
    else setNote(r.stopped ? `${head}。${r.stopped}` : head);
  };

  const onRegister = async (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted || busy || sending) return;
    if (canChoose && !gate.ok) return;
    setBusy(true);
    setNote(`freee から読み直して照らし合わせてから、1件ずつ送ります…`);
    const r = await freee.register(uses, nos);
    setBusy(false);
    if (!r.ok) {
      setNote(r.reason);
      return;
    }
    if ("run" in r) {
      // 日誌には、登録できた件数だけを書く（0件の時は書かない）
      if (r.run.registered > 0) writeJournal({ who: "オーナー", text: `人が登録：テスト事業所の帳簿に、通販の明細 ${r.run.registered}件を取引として登録した` });
      const skipped = [r.skipped.check ? `確かめが要る ${r.skipped.check}件` : "", r.skipped.missing ? `freee に明細が無い ${r.skipped.missing}件` : ""].filter(Boolean).join("・");
      setNote([skipped ? `${skipped}は送っていません` : "", r.stoppedBy ? `止めました：${r.stoppedBy}` : ""].filter(Boolean).join("。") || null);
      // 全部済んだら（登録した・もう処理済み）、「次から自動」の購入先を自動のルールに足す（会計（架空）の記録は変えない）
      const after = countsOf(readFreeeRecord(), nos);
      if (after.registered + after.already === nos.length) {
        let added: MerchantRule[] = [];
        acct.update((s) => {
          const x = withRulesFromFreee(seed, s, new Date().toISOString());
          added = x.added;
          return x.state;
        });
        if (added.length) writeJournal({ who: "オーナー", text: `自動のルールに足した：${added.map((r) => ruleLabel(seed.merchants, r)).join("・")}（次の明細から自動で仕分ける）` });
      }
    }
  };

  const onCheck = async (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted || busy || sending) return;
    setBusy(true);
    const r = await freee.check(nos.filter((no) => stateOf(record, no) !== "registered"));
    setBusy(false);
    if (!r.ok) return setNote(r.reason);
    const s = r.setup as { accountItem?: { name: string; count: number }; tax?: { name: string; count: number } } | null;
    const one = (x?: { name: string; count: number }) => (x ? `「${x.name}」${x.count === 1 ? "✓ 1つ" : `${x.count}つ（1つに決まりません）`}` : "");
    setNote(`freee から読み直して照らし合わせました（何も書いていません）。${s ? `科目${one(s.accountItem)}・税区分${one(s.tax)}` : ""}`);
  };

  const onDisconnect = async (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted || busy || sending) return;
    await freee.disconnect();
    writeJournal({ who: "オーナー", text: "テスト事業所とのつなぎを外した（このブラウザの鍵を消した）" });
  };

  const deals = dealIdsOf(record, nos);
  const run = record.lastRun;

  return (
    <div className="ad-review" id="freee">
      <p>
        <span className="tag ok">{settings.label}</span> {connected ? <span className="hint">つながっています</span> : null}
      </p>
      {/* よく使う「freee に明細を入れる」は、つながっているかの行のすぐ下（説明の文はボタンの下） */}
      <button type="button" className="btn" onClick={onImport} disabled={!connected || busy || sending || !!freee.importWait}>
        freee に明細を入れる
      </button>
      {freee.importWait && (
        <p className="problems" role="alert">
          前に入れた結果が分からないので、{timeOf(freee.importWait.until)}まで待ってください。その後に押すと、freee から読み直して、まだ無い物だけ入れます。
        </p>
      )}
      <p className="hint">
        経理タブと同じ架空のカード明細 {nos.length}件（日付・購入先・金額）を、口座「{settings.cardName}」に入れます。同じ印の明細がもうあれば入れません。
      </p>
      {callbackNote && (
        <p className="checked" role="status">
          {callbackNote}
        </p>
      )}
      {!connected && (
        <div role="alert" className="problems">
          <p>
            {status === "expired" ? "freee の鍵が切れました。" : "freee とつながっていません。"}
            途中の登録は会計（架空）には切り替えません。
          </p>
          {status !== "off" && status !== "not-set" && status !== "loading" && <FreeeConnectForm label="もう一度 freee とつなぐ" />}
        </div>
      )}

      {canChoose && (
        <>
          <p className="acct-left" role="status">
            {gate.remaining > 0 ? (
              <ChooseLink>
                あと <strong className="num">{gate.remaining}</strong>件 選ぶ ↓
              </ChooseLink>
            ) : (
              "全部選びました"
            )}
          </p>
          <strong>プログラムの確認</strong>
          <ul className="gate">
            {gate.checks.map((c) => (
              <li key={c.id} className={c.ok ? "ok" : "skip"}>
                {c.ok ? "✓" : "・"} {c.label}
              </li>
            ))}
          </ul>
        </>
      )}


      <button
        type="button"
        className="btn primary big"
        onClick={onRegister}
        disabled={!connected || busy || sending || (canChoose && !gate.ok) || left === 0}
      >
        {settings.label}に登録
      </button>
      <p className="hint">
        選び終わるまで押せません。1件ずつ順に送ります。店用は「{settings.accountItemName}」・{settings.taxName}、私用はプライベート取引です。送り始めたら、店用／私用の選びは変えられません。
      </p>
      {needsCheck && (
        <button type="button" className="btn" onClick={onCheck} disabled={!connected || busy || sending}>
          freee から読み直す
        </button>
      )}
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
      {sending && (
        <p className="hint" role="status">
          送っています…（終わるまで、登録のし直しと「最初に戻す」はできません）
        </p>
      )}

      <section className="acct-service" aria-labelledby="freee-record">
        <h3 id="freee-record" className="acct-h3">
          {settings.label}の記録
        </h3>
        <div className="freee-counts">
          <BigNumber label="登録した" value={counts.registered} unit="件" />
          <BigNumber label="もう処理済み" value={counts.already} unit="件" />
          <BigNumber label="送れなかった" value={counts.failed} unit="件" />
          <BigNumber label="結果が分からない" value={counts.unknown} unit="件" />
        </div>
        {run && (
          <p className="hint">
            最後の登録：登録した {run.registered}件・もう処理済み {run.already}件・送れなかった {run.failed}件・結果が分からない {run.unknown}件
          </p>
        )}
        {counts.unknown > 0 && (
          <p className="problems" role="alert">
            結果が分からない明細は送り直しません。「freee から読み直す」で照らし合わせてから、もう一度登録してください。
          </p>
        )}
        {deals.length > 0 && (
          <Fold summary={`取引の番号（${deals.length}件）`}>
            <ul className="acct-rules">
              {deals.map((d) => (
                <li key={d.no}>
                  {d.no}番 → 取引 <span className="num">{d.dealIds.join("・")}</span>
                </li>
              ))}
            </ul>
          </Fold>
        )}
        <Fold summary={`明細ごと（${nos.length}件）`}>
          <ul className="acct-trial-rows">
            {seed.statement.items.map((i) => {
              const it = record.items[String(i.no)];
              const s = stateOf(record, i.no);
              const u = uses[String(i.no)];
              return (
                <li key={i.no}>
                  <span>
                    {i.no}番 {md(i.date)} {merchantName(seed.merchants, i.merchantId)} <span className="num">{yen(i.amount)}</span>
                    {u && <span className={`tag use-${u}`}>{USE_LABEL[u]}</span>}
                  </span>
                  <span className={s === "registered" || s === "already" ? "tag ok" : s === "pending" ? "tag text" : "tag hold"}>{FREEE_STATE_LABEL[s]}</span>
                  {it?.reason && <span className="hint">{it.reason}</span>}
                </li>
              );
            })}
          </ul>
        </Fold>
        <p className="hint">会計（架空）の記録とは分けて持ちます。ホームの「最初に戻す」は画面の選びを戻すだけで、freee の記録は残ります（戻した後は、freee から読み直して照らし合わせてから登録します）。</p>
      </section>

      {connected && (
        <button type="button" className="btn small" onClick={onDisconnect} disabled={busy || sending}>
          つなぎを外す
        </button>
      )}
    </div>
  );
}
