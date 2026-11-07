"use client";

// 経理タブの右の列：freee（テスト事業所）につながっている時（オーナーのブラウザだけ）。
// 一覧は freee から読んだ、まだ処理していない明細（カード・銀行）。人が仕分けて「登録」を押した出金だけを、
// freee の明細から取引として登録する（freee の側でも明細が処理済みになる）。入金は登録しない（見せるだけ）。
// AI は使わない。科目も金額もプログラムと設定が決める（金額は明細のまま・科目と税区分は config/accounting.json）。
//
// 🔒 確定は人：登録は、人が画面のボタンを押したとき（isTrusted）だけ。1件ずつ順に送る。
// 送り始めたら、明細と店用／私用の選びを固定する。送っている間は、登録のし直しと「最初に戻す」を止める。
// つながりが切れても、途中の登録を黙って画面の中の会計に切り替えない。

import { ChooseLink } from "./ChooseLink";
import { useEffect, useState } from "react";
import { BigNumber, Fold } from "@/components/parts";
import { ACCOUNT_LABEL } from "@/lib/accounting/rows";
import { md, yen } from "@/lib/accounting/sales";
import { ruleLabel, USE_LABEL } from "@/lib/accounting/sort";
import { liveUsesOf, withRulesFromLive } from "@/lib/accounting/state";
import { useStatement } from "@/lib/accounting/useStatement";
import { countsOf, dealIdsOf, FREEE_STATE_LABEL, recordKeys, stateOf } from "@/lib/freee/state";
import { listErrorText, readFreeeRecord, type useFreee } from "@/lib/freee/useFreee";
import type { CardUse, MerchantRule } from "@/lib/data/types";
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
  "connected-cookie": "freee（テスト事業所）とつなぎました（このブラウザだけ。サーバーにつながりを置けなかったので、来た人はまだ試せません）。",
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
  const st = useStatement();
  const { acct, view, phase } = st;
  const { seed, state } = acct;
  const gate = view.gate;
  const { record, status, settings, sending } = freee;
  const callbackNote = useCallbackNote();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = recordKeys(record);
  const counts = countsOf(record, keys);
  const connected = status === "connected";
  const listed = phase.phase === "ok";
  const targets = view.targets;
  const uses: Record<string, CardUse> = { ...liveUsesOf(view.sorted, state), ...(record.uses ?? {}) };
  const unknownKeys = keys.filter((k) => stateOf(record, k) === "unknown");

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
    const bank = r.bank ? `。${r.bank}（銀行の分は入れていません）` : "";
    const after = "。一覧に出すには「freee から読み直す」を押してください";
    if (r.holdUntil) setNote(`${head}${bank}。${r.stopped ?? ""}。${timeOf(r.holdUntil)}まで待ってから、もう一度押してください（freee から読み直して、まだ無い物だけ入れます）`);
    else setNote(r.stopped ? `${head}${bank}。${r.stopped}` : `${head}${bank}${after}`);
  };

  const onRegister = async (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted || busy || sending || !listed) return;
    if (!gate.ok || targets.length === 0) return;
    setBusy(true);
    setNote(`freee から読み直して照らし合わせてから、1件ずつ送ります…`);
    const sent = targets.map((t) => ({ key: t.key, id: t.txnId!, account: t.account, date: t.date, amount: t.amount }));
    const r = await freee.register(uses, sent);
    setBusy(false);
    if (!r.ok) {
      setNote(r.reason);
      return;
    }
    if ("run" in r) {
      // 日誌には、登録できた件数だけを書く（0件の時は書かない）
      if (r.run.registered > 0) writeJournal({ who: "オーナー", text: `人が登録：テスト事業所の帳簿に、カードと銀行の明細（出金）${r.run.registered}件を取引として登録した` });
      const skipped = [r.skipped.check ? `確かめが要る ${r.skipped.check}件` : "", r.skipped.missing ? `freee に明細が無い ${r.skipped.missing}件` : ""].filter(Boolean).join("・");
      setNote([skipped ? `${skipped}は送っていません` : "", r.stoppedBy ? `止めました：${r.stoppedBy}` : ""].filter(Boolean).join("。") || null);
      // 送った行が全部済んだら（登録した・もう処理済み）、「次から自動」の購入先を自動のルールに足す（画面の中の会計の記録は変えない）
      const after = readFreeeRecord();
      const allDone = sent.every((t) => ["registered", "already"].includes(stateOf(after, t.key)));
      if (allDone) {
        let added: MerchantRule[] = [];
        const manualKeys = new Set([...view.sorted.fresh, ...view.sorted.known].map((x) => x.key));
        const done = targets.filter((t) => manualKeys.has(t.key)).map((t) => ({ merchantId: t.merchantId, use: after.uses?.[t.key] ?? uses[t.key] }));
        acct.update((s) => {
          const x = withRulesFromLive(seed, s, done, new Date().toISOString());
          added = x.added;
          return x.state;
        });
        if (added.length) writeJournal({ who: "オーナー", text: `自動のルールに足した：${added.map((x) => ruleLabel(seed.merchants, x)).join("・")}（次の明細から自動で仕分ける）` });
      }
    }
  };

  const onCheck = async (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted || busy || sending) return;
    setBusy(true);
    const r = await freee.check();
    setBusy(false);
    if (!r.ok) return setNote(listErrorText(r.reason, true));
    const s = r.setup as { accountItem?: { name: string; count: number }; tax?: { name: string; count: number } } | null;
    const one = (x?: { name: string; count: number }) => (x ? `「${x.name}」${x.count === 1 ? "✓ 1つ" : `${x.count}つ（1つに決まりません）`}` : "");
    setNote(`freee から読み直しました（何も書いていません）。まだ処理していない明細 ${r.list.rows.length}件。${s ? `科目${one(s.accountItem)}・税区分${one(s.tax)}` : ""}`);
  };

  const onDisconnect = async (e: React.MouseEvent) => {
    if (!e.nativeEvent.isTrusted || busy || sending) return;
    await freee.disconnect();
    writeJournal({ who: "オーナー", text: "テスト事業所とのつなぎを外した（このブラウザの鍵とサーバーの鍵を消した）" });
  };

  const deals = dealIdsOf(record, keys);
  const run = record.lastRun;
  const rowOf = (key: string) => view.rows.find((r) => r.key === key);

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
        アプリの中の明細 {seed.statement.items.length}件（日付・購入先や振込元・金額）を、口座「{settings.cardName}」と「{settings.bankName}」に入れます。同じ印の明細がもうあれば入れません。
      </p>
      <button type="button" className="btn" onClick={onCheck} disabled={!connected || busy || sending}>
        freee から読み直す
      </button>
      <p className="hint">一覧を読むのは、経理のタブを開いた時と、このボタンを押した時だけです。</p>
      {connected && freee.shared === true && <p className="hint">サーバーもつながりを持っています（来た人も、合言葉なしで試せます。試した物は元の形に戻します）。</p>}
      {connected && freee.shared === false && <p className="hint">サーバーはつながりを持っていません（来た人は試せません）。もう一度つなぐと持ちます。</p>}
      {connected && freee.trial === "repair" && (
        <p className="problems" role="alert">
          来た人の試しで、元の形に戻せなかった物があります（要復旧。来た人の登録は止めています）。freee の側で見本どおりの未処理に直してから、もう一度つないでください。
        </p>
      )}
      {callbackNote && (
        <p className="checked" role="status">
          {callbackNote}
        </p>
      )}
      {!connected && (
        <div role="alert" className="problems">
          <p>
            {status === "expired" ? "freee の鍵が切れました。" : "freee とつながっていません。"}
            一覧も途中の登録も、画面の中の{acct.settings.service}には切り替えません。
          </p>
          {status !== "off" && status !== "not-set" && status !== "loading" && <FreeeConnectForm label="もう一度 freee とつなぐ" />}
        </div>
      )}

      {connected && phase.phase === "error" && (
        <p className="problems" role="alert">
          {listErrorText(phase.reason, phase.reconnect)}
        </p>
      )}
      {listed && (
        <>
          <p className="acct-left" role="status">
            {gate.remaining > 0 ? (
              <ChooseLink>
                あと <strong className="num">{gate.remaining}</strong>件 選ぶ ↓
              </ChooseLink>
            ) : targets.length > 0 ? (
              "全部選びました"
            ) : (
              "送る出金はありません"
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
        disabled={!connected || !listed || busy || sending || !gate.ok || targets.length === 0}
      >
        {settings.label}に登録
      </button>
      <p className="hint">
        出金を選び終わるまで押せません。1件ずつ順に、書く直前に freee から読み直して、明細の番号・口座・日付・金額・出金・未処理が全部合う時だけ送ります。店用は「{settings.accountItemName}」・{settings.taxName}、私用はプライベート取引です。送り始めた明細の店用／私用は変えられません。入金は登録しません。
      </p>
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
      {sending && (
        <p className="hint" role="status">
          freee とやりとりしています…（終わるまで、登録のし直しと「最初に戻す」はできません）
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
        {unknownKeys.length > 0 && (
          <p className="problems" role="alert">
            結果が分からない明細は送り直しません。「freee から読み直す」で照らし合わせてから、もう一度登録してください。
          </p>
        )}
        {deals.length > 0 && (
          <Fold summary={`取引の番号（${deals.length}件）`}>
            <ul className="acct-rules">
              {deals.map((d) => (
                <li key={d.key}>
                  明細 {d.key.slice(1)} → 取引 <span className="num">{d.dealIds.join("・")}</span>
                </li>
              ))}
            </ul>
          </Fold>
        )}
        {keys.length > 0 && (
          <Fold summary={`記録のある明細（${keys.length}件）`}>
            <ul className="acct-trial-rows">
              {keys.map((k) => {
                const it = record.items[k];
                const s = stateOf(record, k);
                const u = record.uses?.[k];
                const row = rowOf(k);
                return (
                  <li key={k}>
                    <span>
                      {row ? `${ACCOUNT_LABEL[row.account]} ${md(row.date)} ${row.text} ` : `明細 ${k.slice(1)} `}
                      {row && <span className="num">{yen(row.amount)}</span>}
                      {u && <span className={`tag use-${u}`}>{USE_LABEL[u]}</span>}
                    </span>
                    <span className={s === "registered" || s === "already" ? "tag ok" : s === "pending" ? "tag text" : "tag hold"}>{FREEE_STATE_LABEL[s]}</span>
                    {it?.reason && <span className="hint">{it.reason}</span>}
                  </li>
                );
              })}
            </ul>
          </Fold>
        )}
        <p className="hint">画面の中の{acct.settings.service}の記録とは分けて持ちます。ホームの「最初に戻す」は画面の選びを戻すだけで、freee の記録は残ります（戻した後は、freee から読み直して照らし合わせてから登録します）。</p>
      </section>

      {connected && (
        <button type="button" className="btn small" onClick={onDisconnect} disabled={busy || sending}>
          つなぎを外す
        </button>
      )}
    </div>
  );
}
